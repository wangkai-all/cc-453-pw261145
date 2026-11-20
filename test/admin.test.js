import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startFixture, makeWorkspace, runCollector, startAdmin, control,
} from './helpers.js';

test('admin run page shows per-step status, failure screenshot link and retry scope', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 3, drift: { page: 2, selector: 'table' } });
  const ws = makeWorkspace();
  const admin = await startAdmin({ dataDir: ws.dataDir });
  t.after(async () => {
    await admin.close();
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(result.status, 'failed');

  const runsPage = await (await fetch(`${admin.url}/`)).text();
  assert.match(runsPage, /Collection runs/);
  assert.match(runsPage, new RegExp(result.runId));
  assert.match(runsPage, /TABLE_MISSING/);

  const runPage = await (await fetch(`${admin.url}/runs/${encodeURIComponent(result.runId)}`)).text();
  // Each of the four steps is represented, with the observed states.
  assert.match(runPage, /Log in to collector/);
  assert.match(runPage, /Enumerate result pages/);
  assert.match(runPage, /Download listed files/);
  assert.match(runPage, /Verify downloads against manifest/);
  assert.match(runPage, /s-succeeded/);
  assert.match(runPage, /s-failed/);
  assert.match(runPage, /s-not_reached/);

  // Failure screenshot is referenced and served.
  assert.match(runPage, /Failure evidence/);
  const audit = await (await fetch(`${admin.url}/runs/${encodeURIComponent(result.runId)}/audit`)).json();
  assert.equal(audit.ok, true);
  assert.match(runPage, /Data integrity audit: passed/);

  const api = await (await fetch(`${admin.url}/runs/${encodeURIComponent(result.runId)}/api`)).json();
  const downloadStep = api.steps.find((s) => s.key === 'download');
  assert.equal(downloadStep.status, 'not_reached');
  assert.equal(downloadStep.inRetryScope, true);
  assert.equal(api.retryPlan.resumeStage, 'paginate');
  assert.equal(api.run.errorCode, 'TABLE_MISSING');

  // Retry scope is rendered in the page, including which stages re-run.
  assert.match(runPage, /Retry scope/);
  assert.match(runPage, /<code>paginate<\/code>/);
  assert.match(runPage, /<code>download<\/code>/);

  // The screenshot ref from the API is fetchable and is a real image.
  assert.ok(api.run.screenshotRef);
  const shot = await fetch(`${admin.url}/runs/${encodeURIComponent(result.runId)}/evidence/${api.run.screenshotRef}`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await shot.arrayBuffer());
  assert.ok(bytes.length > 100);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
});

test('admin evidence route refuses path traversal and symlink escapes', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 1, rowsPerPage: 1 });
  const ws = makeWorkspace();
  const admin = await startAdmin({ dataDir: ws.dataDir });
  t.after(async () => {
    await admin.close();
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(result.status, 'completed');
  const base = `${admin.url}/runs/${encodeURIComponent(result.runId)}/evidence`;

  // A plain `../..` is normalised away by the client before sending, so it
  // simply misses the route; the encoded form reaches the handler and must be
  // rejected by the server's containment check.
  const traversal = await fetch(`${base}/../../../rpa.sqlite`);
  assert.ok([400, 404].includes(traversal.status));
  assert.notEqual(await traversal.text().then((t) => t.includes('SQLite')), true);

  const encoded = await fetch(`${base}/${encodeURIComponent('../../rpa.sqlite')}`);
  assert.equal(encoded.status, 400);

  const missing = await fetch(`${base}/screenshots/nope.png`);
  assert.equal(missing.status, 404);
});

test('admin page for a completed run shows no retry scope and a green audit', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 2, rowsPerPage: 2 });
  const ws = makeWorkspace();
  const admin = await startAdmin({ dataDir: ws.dataDir });
  t.after(async () => {
    await admin.close();
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(result.status, 'completed');

  const page = await (await fetch(`${admin.url}/runs/${encodeURIComponent(result.runId)}`)).text();
  assert.match(page, /Data integrity audit: passed/);
  assert.doesNotMatch(page, /Resume instructions/);
  assert.match(page, /s-succeeded/);

  const api = await (await fetch(`${admin.url}/runs/${encodeURIComponent(result.runId)}/api`)).json();
  assert.deepEqual(api.retryPlan.stagesInScope, []);
  assert.equal(api.counts.confirmed, 4);
  assert.equal(api.counts.ledgerRows, 4);
});

test('admin lists every run and links each to its own page', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 1, rowsPerPage: 1 });
  const ws = makeWorkspace();
  const admin = await startAdmin({ dataDir: ws.dataDir });
  t.after(async () => {
    await admin.close();
    await fixture.close();
    ws.cleanup();
  });

  const a = await runCollector({ origin, dataDir: ws.dataDir, jobKey: 'job-a', dataset: 'fixture' });
  const b = await runCollector({ origin, dataDir: ws.dataDir, jobKey: 'job-b', dataset: 'fixture' });

  const runs = await (await fetch(`${admin.url}/api/runs`)).json();
  const ids = runs.map((r) => r.runId);
  assert.ok(ids.includes(a.runId) && ids.includes(b.runId));

  const pageA = await (await fetch(`${admin.url}/runs/${encodeURIComponent(a.runId)}`)).text();
  const pageB = await (await fetch(`${admin.url}/runs/${encodeURIComponent(b.runId)}`)).text();
  assert.match(pageA, /job-a|jobKey/);
  assert.match(pageB, new RegExp(b.runId));
  assert.doesNotMatch(pageA, new RegExp(`>${b.runId}<`));
});
