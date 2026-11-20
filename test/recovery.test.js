import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startFixture, makeWorkspace, runCollector, detailFor, auditFor, ledgerFor, control, openStore,
} from './helpers.js';

test('login expiry mid-run: session is renewed in place and confirmed downloads are never re-booked', async (t) => {
  // The first session dies mid-download; a fresh login must recover the run.
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 3, sessionLifetimeRequests: 12 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const first = await runCollector({ origin, dataDir: ws.dataDir, config: { collector: { maxRetries: 1 } } });
  assert.equal(first.status, 'completed', JSON.stringify(first.error ?? {}));

  const detail = detailFor(ws.dataDir, first.runId);
  assert.ok(
    detail.events.some((e) => e.kind === 'session_recovery'),
    're-authentication must be logged',
  );
  assert.ok(
    detail.events.some((e) => e.kind === 'download_attempt_failed' && e.errorCode === 'LOGIN_EXPIRED'),
    'the expiry must be surfaced as LOGIN_EXPIRED',
  );
  assert.equal(detail.counts.confirmed, 9);
  assert.equal(detail.counts.ledgerRows, 9);
  assert.equal(auditFor(ws.dataDir, first.runId).ok, true);

  const state = await control(origin, '/__control/state');
  assert.equal(state.loginAttempts.filter((a) => a.ok).length, 2, 'exactly one re-login');

  // Every item was transferred exactly once: an expired session must not cause
  // an already-confirmed item to be fetched again.
  const counts = new Map();
  for (const download of state.downloads) {
    counts.set(download.itemKey, (counts.get(download.itemKey) ?? 0) + 1);
  }
  assert.equal(counts.size, 9);
  for (const [itemKey, n] of counts) {
    assert.equal(n, 1, `${itemKey} fetched ${n} times`);
  }
  assert.equal(ledgerFor(ws.dataDir).length, 9, 'no duplicate ledger rows');
});

test('login expiry with retries disabled parks the run at a resumable checkpoint', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 3, sessionLifetimeRequests: 12 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const first = await runCollector({ origin, dataDir: ws.dataDir, config: { collector: { maxRetries: 0 } } });
  assert.equal(first.status, 'failed');
  assert.equal(first.error.code, 'LOGIN_EXPIRED');
  assert.equal(first.stage, 'download');
  assert.ok(first.error.screenshotRef, 'expiry must be evidenced');

  const before = detailFor(ws.dataDir, first.runId);
  const bookedBefore = before.counts.confirmed;
  assert.ok(bookedBefore > 0 && bookedBefore < 9, `expected a partial booking, got ${bookedBefore}`);
  assert.equal(before.retryPlan.resumeStage, 'download');

  // The operator retries against a healthy collector: same run, no re-booking.
  // Clear the injected session penalty (the outage is over) before retrying.
  await control(origin, '/__control/reset', {});
  await control(origin, '/__control/config', { sessionLifetimeRequests: null });
  const second = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(second.status, 'completed', JSON.stringify(second.error ?? {}));
  assert.equal(second.runId, first.runId, 'retry must continue the same run, not start over');

  const after = detailFor(ws.dataDir, second.runId);
  assert.equal(after.counts.confirmed, 9);
  assert.equal(after.counts.items, 9);
  assert.equal(auditFor(ws.dataDir, second.runId).ok, true);

  // The ledger proves exactly-once booking.
  const ledger = ledgerFor(ws.dataDir);
  assert.equal(ledger.length, 9);
  assert.equal(new Set(ledger.map((e) => e.item_key)).size, 9);
});

test('download interruption is not booked, is retried, and lands exactly once', async (t) => {
  // The first attempt at SKU-004 is cut off halfway.
  const { fixture, origin } = await startFixture({
    pages: 2,
    rowsPerPage: 3,
    interrupt: { itemKey: 'SKU-004', onAttempt: 1, mode: 'short-body' },
  });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir, config: { collector: { maxRetries: 2 } } });
  assert.equal(result.status, 'completed', JSON.stringify(result.error ?? {}));

  const detail = detailFor(ws.dataDir, result.runId);
  const interrupted = detail.events.filter((e) => e.errorCode === 'DOWNLOAD_INTERRUPTED');
  assert.equal(interrupted.length, 1, 'the interrupted attempt must be recorded');

  const item = detail.items.find((i) => i.itemKey === 'SKU-004');
  assert.equal(item.booked, true);
  assert.equal(item.status, 'confirmed');

  const ledger = ledgerFor(ws.dataDir);
  assert.equal(ledger.length, 6);
  assert.equal(ledger.filter((e) => e.item_key === 'SKU-004').length, 1, 'no double booking');

  const state = await control(origin, '/__control/state');
  const sku4 = state.downloads.filter((d) => d.itemKey === 'SKU-004');
  assert.equal(sku4.length, 2, 'fixture should have seen one truncated and one complete transfer');
  assert.equal(sku4[0].mode, 'interrupted:short-body');

  const audit = auditFor(ws.dataDir, result.runId);
  assert.equal(audit.ok, true, JSON.stringify(audit.checks));
  assert.equal(detail.counts.mismatched, 0);
});

test('interruption that never heals fails the download step without booking the item', async (t) => {
  const { fixture, origin } = await startFixture({
    pages: 2,
    rowsPerPage: 2,
    interrupt: { itemKey: 'SKU-002', mode: 'short-body' }, // every attempt is cut
  });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir, config: { collector: { maxRetries: 1 } } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'DOWNLOAD_INTERRUPTED');
  assert.equal(result.error.retryable, true);
  assert.ok(result.error.screenshotRef);

  const ledger = ledgerFor(ws.dataDir);
  assert.equal(ledger.length, 1, 'SKU-001 is booked; the broken item is not');
  assert.equal(ledger[0].item_key, 'SKU-001');

  const detail = detailFor(ws.dataDir, result.runId);
  const item = detail.items.find((i) => i.itemKey === 'SKU-002');
  assert.equal(item.booked, false);
  assert.equal(detail.retryPlan.resumeStage, 'download');
});

test('restarting the browser resumes from a safe checkpoint rather than restarting the run', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 2 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  // Kill the pipeline mid-flight (after the download step has committed 2
  // items) by throwing from the checkpoint probe. This models a process crash.
  let downloadsAtCrash = 0;
  const crash = await runCollector({
    origin,
    dataDir: ws.dataDir,
    checkpointProbe: ({ stage, lastConfirmedItem }) => {
      if (stage === 'download' && lastConfirmedItem === 'SKU-002') {
        downloadsAtCrash = ledgerFor(ws.dataDir).length;
        throw new Error('simulated process crash');
      }
    },
  });
  assert.equal(crash.status, 'failed');
  assert.equal(downloadsAtCrash, 2);

  const storeBefore = openStore(ws.dataDir);
  const stepBefore = storeBefore.listSteps(crash.runId).find((s) => s.step_key === 'download');
  storeBefore.close();
  assert.equal(stepBefore.status, 'failed', 'a crash mid-download is not reported as success');

  const resumed = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error ?? {}));
  assert.equal(resumed.runId, crash.runId);

  const ledger = ledgerFor(ws.dataDir);
  assert.equal(ledger.length, 6);
  const state = await control(origin, '/__control/state');
  // Items confirmed before the crash were never fetched again.
  for (const booked of ledger.slice(0, 2)) {
    const fetches = state.downloads.filter((d) => d.itemKey === booked.item_key);
    assert.equal(fetches.length, 1, `${booked.item_key} must not be re-downloaded`);
  }
});

test('tampered checkpoint is rejected instead of being silently trusted', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 2, rowsPerPage: 2 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const first = await runCollector({ origin, dataDir: ws.dataDir, config: { collector: { maxRetries: 0 } } });
  assert.equal(first.status, 'completed');

  const checkpointFile = path.join(ws.dataDir, 'state', 'job-1', 'checkpoints', `${first.runId}.json`);
  const raw = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  raw.pageIndex = 99; // pretend we got much further than we did
  fs.writeFileSync(checkpointFile, JSON.stringify(raw));

  // Force a new run on the same job, then simulate a resume needing the mirror.
  const store = openStore(ws.dataDir);
  store.updateRun(first.runId, { status: 'interrupted', stage: 'download', page_cursor: 1 });
  store.close();

  const result = await runCollector({ origin, dataDir: ws.dataDir, runId: first.runId });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CHECKPOINT_CORRUPT');
});

test('browser process death stops the run at a safe checkpoint; retry resumes without re-booking', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 2 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  // Hard-kill Chromium as soon as the 4th item is committed. The pipeline must
  // stop at that checkpoint rather than misreport the item and re-download.
  const result = await runCollector({
    origin,
    dataDir: ws.dataDir,
    jobKey: 'job-crash',
    config: { collector: { maxRetries: 0 } },
    browserProbe: async (session, { lastConfirmedItem }) => {
      if (lastConfirmedItem === 'SKU-004') {
        await session.killBrowser();
      }
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'BROWSER_CRASHED', result.error.message);
  assert.equal(result.error.retryable, true);
  assert.equal(result.stage, 'download');

  const bookedAtCrash = ledgerFor(ws.dataDir, 'job-crash').length;
  assert.ok(bookedAtCrash >= 4, `expected >=4 booked before crash, got ${bookedAtCrash}`);
  assert.ok(bookedAtCrash < 6, 'crash happens before all items are done');

  const resumed = await runCollector({ origin, dataDir: ws.dataDir, jobKey: 'job-crash' });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error ?? {}));
  assert.equal(resumed.runId, result.runId, 'resume continues the interrupted run');

  const ledger = ledgerFor(ws.dataDir, 'job-crash');
  assert.equal(ledger.length, 6);
  assert.equal(new Set(ledger.map((e) => e.item_key)).size, 6);
});
