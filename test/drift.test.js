import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startFixture, makeWorkspace, runCollector, detailFor, auditFor, ledgerFor, control,
} from './helpers.js';

test('page drift: missing table fails the paginate step loudly, with a screenshot and a bounded retry scope', async (t) => {
  // Page 2 renders no results table at all.
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 3, drift: { page: 2, selector: 'table' } });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'paginate');
  assert.equal(result.error.code, 'TABLE_MISSING');
  assert.equal(result.error.step, 'paginate');
  assert.equal(result.error.page, 2);
  assert.equal(result.error.retryable, false);

  const detail = detailFor(ws.dataDir, result.runId);
  const paginate = detail.steps.find((s) => s.key === 'paginate');
  assert.equal(paginate.status, 'failed');
  assert.equal(paginate.errorCode, 'TABLE_MISSING');

  // Failure evidence exists on disk and is referenced by the run.
  assert.ok(result.error.screenshotRef, 'a screenshot ref must be recorded');
  const shotPath = path.join(ws.dataDir, 'artifacts', 'fixture', result.error.screenshotRef);
  assert.ok(fs.existsSync(shotPath), `screenshot missing at ${shotPath}`);
  assert.ok(fs.statSync(shotPath).size > 0, 'screenshot must not be empty');

  // It must NOT silently skip page 2 and download pages 1/3.
  assert.equal(detail.items.length, 3, 'only page 1 items are known');
  assert.equal(ledgerFor(ws.dataDir).length, 0, 'no download may be booked when enumeration fails');

  // Retry scope is explicit and starts at paginate.
  assert.equal(detail.retryPlan.resumeStage, 'paginate');
  assert.deepEqual(detail.retryPlan.stagesInScope, ['paginate', 'download', 'verify']);
  assert.equal(auditFor(ws.dataDir, result.runId).ok, true);
});

test('page drift: missing download control fails the download step instead of skipping the item', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 2, rowsPerPage: 2, drift: { page: 2, selector: 'download-link' } });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'DOWNLOAD_BUTTON_MISSING');
  assert.equal(result.error.step, 'download');
  assert.equal(result.error.retryable, false);

  const detail = detailFor(ws.dataDir, result.runId);
  assert.equal(detail.steps.find((s) => s.key === 'download').status, 'failed');
  assert.equal(detail.steps.find((s) => s.key === 'verify').status, 'not_reached');
  // Page 1's two downloads were booked before the layout break; page 2's were not.
  assert.equal(detail.counts.ledgerRows, 2);
  assert.equal(detail.counts.confirmed, 2);
  assert.equal(detail.retryPlan.resumeStage, 'download');
  assert.ok(result.error.screenshotRef);
});

test('login rejection is a hard failure with evidence and no page work', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 2, rejectPassword: 'demo' });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'LOGIN_REJECTED');
  assert.equal(result.error.step, 'login');

  const detail = detailFor(ws.dataDir, result.runId);
  assert.equal(detail.steps.find((s) => s.key === 'login').status, 'failed');
  assert.equal(detail.counts.items, 0);
  assert.ok(detail.run.screenshotRef);
  assert.equal(detail.retryPlan.resumeStage, 'login');

  const state = await control(origin, '/__control/state');
  assert.equal(state.loginAttempts.length, 1);
  assert.equal(state.loginAttempts[0].ok, false);
});

test('missing login form (site redesign) fails without guessing', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 1, rowsPerPage: 1 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({
    origin,
    dataDir: ws.dataDir,
    config: { collector: { usernameSelector: '#does-not-exist' } },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'LOGIN_FORM_MISSING');
  assert.ok(result.error.screenshotRef);
});
