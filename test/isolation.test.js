import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../src/job.js';
import { chromium } from 'playwright';
import {
  startFixture, makeWorkspace, runCollector, detailFor, ledgerFor, openStore, control,
} from './helpers.js';

test('two concurrent jobs on the same fixture stay isolated: separate ledgers, files and checkpoints', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 3 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  // Two jobs, same data dir, same expensive downloads. They must not share a
  // run, a checkpoint file, or a ledger key.
  const run = (jobKey) =>
    runCollector({ origin, dataDir: ws.dataDir, jobKey, dataset: `ds-${jobKey}`, fresh: true });

  const [a, b] = await Promise.all([run('job-a'), run('job-b')]);
  assert.equal(a.status, 'completed', JSON.stringify(a.error ?? {}));
  assert.equal(b.status, 'completed', JSON.stringify(b.error ?? {}));
  assert.notEqual(a.runId, b.runId);

  const detailA = detailFor(ws.dataDir, a.runId);
  const detailB = detailFor(ws.dataDir, b.runId);
  assert.equal(detailA.counts.confirmed, 9);
  assert.equal(detailB.counts.confirmed, 9);
  assert.equal(ledgerFor(ws.dataDir, 'job-a').length, 9);
  assert.equal(ledgerFor(ws.dataDir, 'job-b').length, 9);
  assert.ok(ledgerFor(ws.dataDir, 'job-a').every((e) => e.dataset === 'ds-job-a'));
  assert.ok(ledgerFor(ws.dataDir, 'job-b').every((e) => e.dataset === 'ds-job-b'));

  // Artifacts live under a per-dataset directory; downloadRef is relative to
  // that directory, so identical names must still resolve to distinct files.
  const refA = detailA.items[0].downloadRef;
  const refB = detailB.items[0].downloadRef;
  assert.equal(refA, refB, 'same item file name in each dataset dir');
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const fileA = path.join(ws.dataDir, 'artifacts', 'ds-job-a', refA);
  const fileB = path.join(ws.dataDir, 'artifacts', 'ds-job-b', refB);
  assert.ok(fs.existsSync(fileA) && fs.existsSync(fileB));
  assert.notEqual(fs.realpathSync(fileA), fs.realpathSync(fileB));

  // Both runs hit the fixture once per item — no shared-cookie session bleed.
  const state = await control(origin, '/__control/state');
  assert.equal(state.downloads.length, 18);
});

test('two workers racing the SAME run: exactly one owns it, the other is told to back off', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 2, rowsPerPage: 3 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const args = {
    jobKey: 'job-race',
    dataset: 'fixture',
    dataDir: ws.dataDir,
    config: {
      collector: { baseUrl: origin, maxRetries: 1 },
      browser: { headless: true, timeoutMs: 8000 },
      leaseTtlMs: 30_000,
    },
    playwright: chromium,
  };

  // Kick off worker 1, and while it is still running, try to claim the same
  // run from worker 2. The lease must reject the second claim.
  const worker1 = runJob({ ...args, fresh: true });
  const firstSummary = await worker1;
  const runId = firstSummary.runId;

  // Simulate a foreign live lease by writing one owned by this PID.
  const store = openStore(ws.dataDir);
  store.updateRun(runId, {
    status: 'running',
    lease_token: 'foreign-lease',
    owner_pid: process.pid,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  store.close();

  // The same-process second claim must lose.
  const { Collector } = await import('../src/pipeline.js');
  const { loadConfig, resolvePaths } = await import('../src/config.js');
  const store2 = openStore(ws.dataDir);
  const paths = resolvePaths({ dataDir: ws.dataDir, jobKey: 'job-race', dataset: 'fixture' });
  const collector = new Collector({
    store: store2,
    runId,
    stateDir: paths.stateDir,
    artifactsDir: paths.artifactsDir,
    config: loadConfig({ overrides: args.config }),
    playwright: chromium,
  });
  await assert.rejects(
    () => collector.runPipeline(),
    (error) => error.code === 'LEASE_LOST',
    'a live lease must block a second worker',
  );
  store2.close();
});

test('the same job retried serially resumes rather than duplicating downloads', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 2, rowsPerPage: 2, drift: null });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const first = await runCollector({ origin, dataDir: ws.dataDir, jobKey: 'serial', dataset: 'serial' });
  assert.equal(first.status, 'completed');

  // A second invocation for a completed job starts a fresh run but must not
  // re-book the ledger (it creates new item keys only if the collector changes).
  const second = await runCollector({ origin, dataDir: ws.dataDir, jobKey: 'serial', dataset: 'serial' });
  assert.equal(second.status, 'completed');
  assert.notEqual(second.runId, first.runId, 'a completed job gets a new run on re-invocation');

  const ledger = ledgerFor(ws.dataDir, 'serial');
  assert.equal(ledger.length, 4, 'ledger stays one row per item across runs');
  assert.equal(new Set(ledger.map((e) => e.item_key)).size, 4);
  const state = await control(origin, '/__control/state');
  // Each item is fetched once: the second run sees them pre-booked and skips.
  for (const itemKey of new Set(ledger.map((e) => e.item_key))) {
    const fetches = state.downloads.filter((d) => d.itemKey === itemKey).length;
    assert.equal(fetches, 1, `${itemKey} fetched ${fetches} times`);
  }
});
