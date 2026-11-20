import { STEPS, describeRetryScope } from './pipeline.js';

/**
 * Assemble everything the admin pages need for a run, in one place so the
 * HTML server and the JSON API can never disagree.
 */
export function runDetail(store, runId) {
  const run = store.getRun(runId);
  if (!run) return null;
  const steps = store.listSteps(runId);
  const stepByKey = new Map(steps.map((s) => [s.step_key, s]));
  const pages = store.listPages(runId);
  const items = store.listItems(runId);
  const ledger = store.listLedger(run.job_key).filter((e) => e.dataset === run.dataset);
  const events = store.listEvents(runId, 100);

  const booked = new Map(ledger.map((e) => [e.item_key, e]));
  const itemRows = items.map((item) => {
    const entry = booked.get(item.item_key);
    return {
      itemKey: item.item_key,
      title: item.title,
      page: item.page_index,
      status: item.status,
      booked: Boolean(entry),
      sha256: item.sha256,
      expectedSha256: item.expected_sha256,
      sizeBytes: item.size_bytes,
      confirmedAt: entry?.confirmed_at ?? item.receipt_at ?? null,
      downloadRef: item.download_ref,
      mismatch:
        Boolean(item.expected_sha256 && item.sha256) && item.expected_sha256 !== item.sha256,
    };
  });

  const stageIndex = { login: 0, paginate: 1, download: 2, verify: 3 };
  const failedStageIndex = run.error_code ? stageIndex[run.stage] ?? 0 : null;

  return {
    run: {
      runId: run.run_id,
      jobKey: run.job_key,
      dataset: run.dataset,
      status: run.status,
      stage: run.stage,
      pageCursor: run.page_cursor,
      totalPages: run.total_pages,
      attempt: run.attempt,
      currentItem: run.current_item,
      errorCode: run.error_code,
      errorMessage: run.error_message,
      screenshotRef: run.screenshot_ref,
      retryScope: run.retry_scope,
      ownerPid: run.owner_pid,
      leaseExpiresAt: run.lease_expires_at,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      finishedAt: run.finished_at,
    },
    steps: STEPS.map((def) => {
      const row = stepByKey.get(def.key);
      const willRetry =
        failedStageIndex != null && def.index >= failedStageIndex && run.status !== 'completed';
      return {
        key: def.key,
        index: def.index,
        title: row?.title ?? def.title,
        status: row?.status ?? (run.status === 'pending' ? 'pending' : 'not_reached'),
        attempts: row?.attempts ?? 0,
        message: row?.message ?? null,
        errorCode: row?.error_code ?? null,
        screenshotRef: row?.screenshot_ref ?? null,
        // Range the operator's retry will touch, derived from the failed step.
        inRetryScope: willRetry,
      };
    }),
    retryPlan: {
      resumeStage: run.status === 'completed' ? null : run.stage,
      description: run.error_code ? run.retry_scope : describeRetryScope(run.stage),
      stagesInScope: run.status === 'completed' ? [] : STEPS.slice(stageIndex[run.stage] ?? 0).map((s) => s.key),
    },
    pages: pages.map((p) => ({
      pageIndex: p.page_index,
      status: p.status,
      rowCount: p.row_count,
      firstItemKey: p.first_item_key,
      lastItemKey: p.last_item_key,
      nextLabel: p.next_label,
      errorCode: p.error_code,
    })),
    items: itemRows,
    counts: {
      items: itemRows.length,
      listed: itemRows.filter((i) => i.status === 'listed').length,
      confirmed: itemRows.filter((i) => i.booked).length,
      mismatched: itemRows.filter((i) => i.mismatch).length,
      ledgerRows: ledger.length,
    },
    ledger,
    events: events.map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      step: e.step,
      message: e.message,
      errorCode: e.error_code,
      screenshotRef: e.screenshot_ref,
      payload: e.payload_json ? safeParse(e.payload_json) : null,
    })),
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function listRunSummaries(store, { jobKey = null, limit = 50 } = {}) {
  return store.listRuns({ jobKey, limit }).map((run) => ({
    runId: run.run_id,
    jobKey: run.job_key,
    dataset: run.dataset,
    status: run.status,
    stage: run.stage,
    errorCode: run.error_code,
    screenshotRef: run.screenshot_ref,
    attempt: run.attempt,
    totalPages: run.total_pages,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    finishedAt: run.finished_at,
  }));
}

/**
 * Integration checks that an operator can see before trusting a green run.
 * These are the "no double-booking" invariants expressed as queries rather
 * than as prose.
 */
export function auditRun(store, runId) {
  const detail = runDetail(store, runId);
  if (!detail) return null;
  const checks = [];
  const run = detail.run;
  const ledgerForJob = store.listLedger(run.jobKey).filter((e) => e.dataset === run.dataset);

  checks.push({
    name: 'every confirmed item has a ledger row',
    ok: detail.items.every((i) => i.status !== 'confirmed' || i.booked),
  });
  checks.push({
    name: 'no confirmed item is missing a ledger row',
    ok: detail.items.every((i) => i.status !== 'confirmed' || i.booked),
  });
  checks.push({
    name: 'no ledger row exists for an unlisted item',
    ok: detail.items.every((i) => !i.booked || i.status === 'confirmed'),
  });
  checks.push({
    name: 'every ledger row maps to an item in this run',
    ok: detail.counts.ledgerRows === detail.items.filter((i) => i.booked).length,
  });
  checks.push({
    name: 'no checksum mismatches',
    ok: detail.items.every((i) => !i.mismatch),
  });
  checks.push({
    name: 'each item appears in the ledger at most once',
    ok: new Set(ledgerForJob.map((e) => e.item_key)).size === ledgerForJob.length,
  });
  if (run.status === 'completed') {
    checks.push({
      name: 'completed run has all steps succeeded',
      ok: detail.steps.every((s) => s.status === 'succeeded'),
    });
  }
  return { runId, checks, ok: checks.every((c) => c.ok) };
}
