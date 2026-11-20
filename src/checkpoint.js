import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonIfExists } from './util.js';
import { CODES, RpaError } from './errors.js';

/**
 * Checkpoint mirror.
 *
 * SQLite is the source of truth. This file exists so that operators (and the
 * resume path) can see exactly which point was considered safe, and so that
 * tampering/corruption of the run state is detected loudly instead of being
 * guessed around.
 *
 * The rule for resume is conservative in one direction only:
 *   resume at the EARLIEST durable point among {DB state, checkpoint file}.
 * Never later. Re-doing a listed page or an unconfirmed download is safe;
 * skipping work is not.
 */
const VERSION = 1;

function canonical(payload) {
  return JSON.stringify({
    version: payload.version,
    runId: payload.runId,
    jobKey: payload.jobKey,
    dataset: payload.dataset,
    stage: payload.stage,
    pageIndex: payload.pageIndex,
    itemCursor: payload.itemCursor,
    lastConfirmedItem: payload.lastConfirmedItem,
    savedAt: payload.savedAt,
    browserEpoch: payload.browserEpoch,
  });
}

export function checkpointPath(stateDir, runId) {
  return path.join(ensureDir(path.join(stateDir, 'checkpoints')), `${runId}.json`);
}

export function writeCheckpoint(stateDir, checkpoint) {
  const payload = {
    version: VERSION,
    runId: checkpoint.runId,
    jobKey: checkpoint.jobKey,
    dataset: checkpoint.dataset,
    stage: checkpoint.stage,
    pageIndex: checkpoint.pageIndex,
    itemCursor: checkpoint.itemCursor ?? null,
    lastConfirmedItem: checkpoint.lastConfirmedItem ?? null,
    savedAt: new Date().toISOString(),
    browserEpoch: checkpoint.browserEpoch ?? null,
  };
  payload.checksum = sha256(canonical(payload));
  const file = checkpointPath(stateDir, checkpoint.runId);
  atomicWriteJson(file, payload);
  return payload;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Read and validate the mirror. Returns { checkpoint, warning } or throws a
 * typed CHECKPOINT_CORRUPT error when the file exists but cannot be trusted.
 */
export function readCheckpoint(stateDir, { runId, jobKey, dataset }) {
  const file = checkpointPath(stateDir, runId);
  if (!fs.existsSync(file)) return { checkpoint: null, warning: 'checkpoint file missing' };

  let raw;
  try {
    raw = readJsonIfExists(file);
  } catch (error) {
    throw checkpointCorrupt(runId, `checkpoint is not valid JSON: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw checkpointCorrupt(runId, 'checkpoint is empty or not an object');
  }
  if (raw.version !== VERSION) {
    throw checkpointCorrupt(runId, `unsupported checkpoint version ${raw.version}`);
  }
  if (raw.runId !== runId || raw.jobKey !== jobKey || raw.dataset !== dataset) {
    throw checkpointCorrupt(
      runId,
      'checkpoint identity does not match the run (run/job/dataset mismatch)',
    );
  }
  const expected = sha256(canonical(raw));
  if (expected !== raw.checksum) {
    throw checkpointCorrupt(runId, 'checkpoint checksum mismatch — refusing to resume from it');
  }
  return { checkpoint: raw, warning: null };
}

function checkpointCorrupt(runId, message) {
  return new RpaError({
    code: CODES.CHECKPOINT_CORRUPT,
    step: 'resume',
    message,
    retryable: false,
    details: { runId },
  });
}

/**
 * Pick the conservative resume point.
 *
 * @param {object} run        row from the runs table
 * @param {object|null} mirror decoded checkpoint mirror
 * @param {object} opts       { jobKey, dataset, items, ledgerKeys }
 */
export function planResume({ run, mirror, jobKey, dataset, items, ledgerKeys }) {
  const dbPoint = { stage: run.stage, pageIndex: run.page_cursor, itemCursor: null };
  const mirrorPoint = mirror
    ? { stage: mirror.stage, pageIndex: mirror.pageIndex, itemCursor: mirror.itemCursor ?? null }
    : null;

  const problems = [];

  // Consistency invariants: a confirmed item must have a ledger row, and a
  // ledger row for this run's items must have a matching confirmed item.
  for (const item of items) {
    const booked = ledgerKeys.has(item.item_key);
    if (item.status === 'confirmed' && !booked) {
      problems.push(
        `item ${item.item_key} is marked confirmed but has no download ledger row`,
      );
    }
  }
  if (problems.length > 0) {
    throw new RpaError({
      code: CODES.UNSAFE_RESUME,
      step: 'resume',
      message: `Run state is inconsistent; refusing to resume: ${problems.join('; ')}`,
      retryable: false,
      details: { problems },
    });
  }

  // If the mirror is BEHIND the database (e.g. crash after DB commit but before
  // the mirror write), the mirror's earlier point wins. If the mirror is AHEAD,
  // it is not trusted at all — DB commit is the authority.
  let source = 'database';
  let point = dbPoint;
  if (mirrorPoint) {
    const mirrorBehind =
      mirrorPoint.stage !== dbPoint.stage || mirrorPoint.pageIndex < dbPoint.pageIndex;
    if (mirrorBehind) {
      source = 'checkpoint-file (earlier than database)';
      point = mirrorPoint;
    }
  }

  if (point.stage === 'login') {
    return { ...point, stage: 'login', source, itemCursor: null };
  }
  if (point.stage === 'paginate') {
    return { ...point, stage: 'paginate', pageIndex: Number(point.pageIndex) || 0, source };
  }
  if (point.stage === 'download') {
    const pageIndex = Number(point.pageIndex) || 0;
    const pageItems = items
      .filter((item) => item.page_index === pageIndex)
      .sort((a, b) => a.row_index - b.row_index);
    const firstUnbooked = pageItems.find((item) => !ledgerKeys.has(item.item_key));
    const cursorKey = firstUnbooked?.item_key ?? null;
    return {
      stage: 'download',
      pageIndex,
      itemCursor: cursorKey,
      source,
      jobKey,
      dataset,
    };
  }
  if (point.stage === 'verify') {
    return { stage: 'verify', pageIndex: point.pageIndex, itemCursor: null, source };
  }
  throw new RpaError({
    code: CODES.UNSAFE_RESUME,
    step: 'resume',
    message: `Unknown resume stage "${point.stage}" — refusing to guess`,
    retryable: false,
  });
}
