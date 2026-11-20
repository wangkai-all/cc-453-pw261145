import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, makeWorkspace, runCollector, detailFor, auditFor, ledgerFor, control } from './helpers.js';

test('happy path collects every page, books each download exactly once', async (t) => {
  const { fixture, origin } = await startFixture({ pages: 3, rowsPerPage: 3 });
  const ws = makeWorkspace();
  t.after(async () => {
    await fixture.close();
    ws.cleanup();
  });

  const result = await runCollector({ origin, dataDir: ws.dataDir });
  assert.equal(result.status, 'completed', JSON.stringify(result.error ?? {}));

  const detail = detailFor(ws.dataDir, result.runId);
  assert.equal(detail.counts.items, 9);
  assert.equal(detail.counts.confirmed, 9);
  assert.equal(detail.counts.ledgerRows, 9);
  assert.equal(detail.counts.mismatched, 0);
  assert.deepEqual(detail.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);

  const ledger = ledgerFor(ws.dataDir);
  assert.equal(new Set(ledger.map((e) => e.item_key)).size, 9);
  assert.ok(ledger.every((e) => e.sha256 && e.size_bytes > 0));

  const audit = auditFor(ws.dataDir, result.runId);
  assert.equal(audit.ok, true, JSON.stringify(audit.checks));

  const state = await control(origin, '/__control/state');
  assert.equal(state.downloads.length, 9);
  assert.equal(state.loginAttempts.filter((a) => a.ok).length, 1);
});
