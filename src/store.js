import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso } from './util.js';

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS runs (
    run_id            TEXT PRIMARY KEY,
    job_key           TEXT NOT NULL,
    dataset           TEXT NOT NULL,
    status            TEXT NOT NULL,
    stage             TEXT NOT NULL,
    page_cursor       INTEGER NOT NULL DEFAULT 0,
    total_pages       INTEGER,
    current_item      TEXT,
    attempt           INTEGER NOT NULL DEFAULT 0,
    error_code        TEXT,
    error_message     TEXT,
    screenshot_ref    TEXT,
    retry_scope       TEXT,
    owner_pid         INTEGER,
    lease_token       TEXT,
    lease_expires_at  TEXT,
    config_json       TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    finished_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS steps (
    run_id            TEXT NOT NULL,
    step_key          TEXT NOT NULL,
    step_index        INTEGER NOT NULL,
    title             TEXT NOT NULL,
    status            TEXT NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    page              INTEGER,
    item_key          TEXT,
    message           TEXT,
    error_code        TEXT,
    screenshot_ref    TEXT,
    resume_stage      TEXT,
    started_at        TEXT,
    finished_at       TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (run_id, step_key)
  );

  CREATE TABLE IF NOT EXISTS pages (
    run_id            TEXT NOT NULL,
    page_index        INTEGER NOT NULL,
    status            TEXT NOT NULL,
    row_count         INTEGER NOT NULL DEFAULT 0,
    first_item_key    TEXT,
    last_item_key    TEXT,
    next_label        TEXT,
    error_code        TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (run_id, page_index)
  );

  CREATE TABLE IF NOT EXISTS items (
    run_id            TEXT NOT NULL,
    item_key          TEXT NOT NULL,
    page_index        INTEGER NOT NULL,
    row_index         INTEGER NOT NULL,
    title             TEXT NOT NULL,
    status            TEXT NOT NULL,
    size_bytes        INTEGER,
    sha256            TEXT,
    expected_sha256   TEXT,
    download_ref      TEXT,
    receipt_at        TEXT,
    error_code        TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (run_id, item_key)
  );

  -- The download ledger is the money table: one confirmed row per
  -- (job_key, dataset, item_key). A (re)started run can never double-book an
  -- item that this ledger already confirms, even if its local file vanished.
  CREATE TABLE IF NOT EXISTS download_ledger (
    job_key           TEXT NOT NULL,
    dataset           TEXT NOT NULL,
    item_key          TEXT NOT NULL,
    run_id            TEXT NOT NULL,
    sha256            TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL,
    filename          TEXT NOT NULL,
    source_page       INTEGER NOT NULL,
    confirmed_at      TEXT NOT NULL,
    PRIMARY KEY (job_key, dataset, item_key)
  );

  CREATE TABLE IF NOT EXISTS events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            TEXT NOT NULL,
    at                TEXT NOT NULL,
    kind              TEXT NOT NULL,
    step              TEXT,
    message           TEXT,
    error_code        TEXT,
    screenshot_ref    TEXT,
    payload_json      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
  CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, step_index);
  CREATE INDEX IF NOT EXISTS idx_items_run ON items(run_id, page_index, row_index);
  `,
];

export class Store {
  /** @param {string} dbPath */
  constructor(dbPath) {
    ensureDir(path.dirname(dbPath));
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    for (const sql of MIGRATIONS) this.db.exec(sql);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- runs

  createRun({ runId, jobKey, dataset, config, totalPages = null }) {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (run_id, job_key, dataset, status, stage, page_cursor, total_pages,
                           config_json, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 'login', 0, ?, ?, ?, ?)`,
      )
      .run(runId, jobKey, dataset, totalPages, JSON.stringify(config), at, at);
    return this.getRun(runId);
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) ?? null;
  }

  listRuns({ jobKey = null, limit = 50 } = {}) {
    if (jobKey) {
      return this.db
        .prepare('SELECT * FROM runs WHERE job_key = ? ORDER BY created_at DESC LIMIT ?')
        .all(jobKey, limit);
    }
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  updateRun(runId, patch) {
    const allowed = [
      'status', 'stage', 'page_cursor', 'total_pages', 'current_item', 'attempt',
      'error_code', 'error_message', 'screenshot_ref', 'retry_scope', 'owner_pid',
      'lease_token', 'lease_expires_at', 'finished_at',
    ];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);
    this.db
      .prepare(`UPDATE runs SET ${sets}, updated_at = ? WHERE run_id = ?`)
      .run(...values, nowIso(), runId);
  }

  /**
   * Take (or steal) the run lease.
   *
   * A lease is stealable when it is unset, expired, or its owner PID is no
   * longer alive on this host (the previous collector process crashed). The
   * PID check is what lets a retry run immediately after a hard crash instead
   * of waiting out the TTL.
   *
   * Returns a token when the caller now owns the run, null otherwise.
   */
  acquireLease(runId, { ownerPid, ttlMs = 30_000 }) {
    const token = `lease-${ownerPid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    const current = this.getRun(runId);
    // Only terminal-success or explicitly abandoned runs are sealed. A failed
    // or interrupted run is exactly the retry case we must be able to claim.
    if (!current || ['completed', 'abandoned'].includes(current.status)) return null;

    const ownerAlive = (() => {
      if (!current.owner_pid) return false;
      if (current.owner_pid === ownerPid) return true;
      try {
        process.kill(current.owner_pid, 0);
        return true;
      } catch (error) {
        // EPERM means the process exists but belongs to another user.
        return error.code === 'EPERM';
      }
    })();
    const leaseLive =
      Boolean(current.lease_token) &&
      Boolean(current.lease_expires_at) &&
      current.lease_expires_at >= now.toISOString() &&
      ownerAlive;
    if (leaseLive) return null;

    this.db
      .prepare(
        `UPDATE runs
            SET lease_token = ?, lease_expires_at = ?, owner_pid = ?, updated_at = ?
          WHERE run_id = ?
            AND status NOT IN ('completed','abandoned')
            AND (lease_token IS NULL OR lease_token = ? OR lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .run(
        token,
        expires,
        ownerPid,
        now.toISOString(),
        runId,
        current.lease_token ?? '',
        now.toISOString(),
      );
    const after = this.getRun(runId);
    return after?.lease_token === token ? token : null;
  }

  renewLease(runId, token, { ttlMs = 30_000 } = {}) {
    const expires = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE runs SET lease_expires_at = ?, updated_at = ?
          WHERE run_id = ? AND lease_token = ?`,
      )
      .run(expires, nowIso(), runId, token);
    return result.changes === 1;
  }

  releaseLease(runId, token) {
    this.db
      .prepare(
        `UPDATE runs SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE run_id = ? AND lease_token = ?`,
      )
      .run(nowIso(), runId, token);
  }

  // --------------------------------------------------------------- steps

  upsertStep(step) {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO steps (run_id, step_key, step_index, title, status, attempts, page,
                            item_key, message, error_code, screenshot_ref, resume_stage,
                            started_at, finished_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_key) DO UPDATE SET
           status = excluded.status,
           attempts = excluded.attempts,
           page = excluded.page,
           item_key = excluded.item_key,
           message = excluded.message,
           error_code = excluded.error_code,
           screenshot_ref = excluded.screenshot_ref,
           resume_stage = excluded.resume_stage,
           started_at = COALESCE(steps.started_at, excluded.started_at),
           finished_at = excluded.finished_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        step.runId,
        step.stepKey,
        step.stepIndex,
        step.title,
        step.status,
        step.attempts ?? 0,
        step.page ?? null,
        step.itemKey ?? null,
        step.message ?? null,
        step.errorCode ?? null,
        step.screenshotRef ?? null,
        step.resumeStage ?? null,
        step.startedAt ?? null,
        step.finishedAt ?? null,
        at,
      );
  }

  listSteps(runId) {
    return this.db
      .prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC')
      .all(runId);
  }

  // --------------------------------------------------------------- pages

  upsertPage(page) {
    this.db
      .prepare(
        `INSERT INTO pages (run_id, page_index, status, row_count, first_item_key, last_item_key,
                            next_label, error_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, page_index) DO UPDATE SET
           status = excluded.status,
           row_count = excluded.row_count,
           first_item_key = excluded.first_item_key,
           last_item_key = excluded.last_item_key,
           next_label = excluded.next_label,
           error_code = excluded.error_code,
           updated_at = excluded.updated_at`,
      )
      .run(
        page.runId,
        page.pageIndex,
        page.status,
        page.rowCount ?? 0,
        page.firstItemKey ?? null,
        page.lastItemKey ?? null,
        page.nextLabel ?? null,
        page.errorCode ?? null,
        nowIso(),
      );
  }

  listPages(runId) {
    return this.db
      .prepare('SELECT * FROM pages WHERE run_id = ? ORDER BY page_index ASC')
      .all(runId);
  }

  // --------------------------------------------------------------- items

  upsertItem(item) {
    this.db
      .prepare(
        `INSERT INTO items (run_id, item_key, page_index, row_index, title, status, size_bytes,
                            sha256, expected_sha256, download_ref, receipt_at, error_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, item_key) DO UPDATE SET
           page_index = excluded.page_index,
           row_index = excluded.row_index,
           title = excluded.title,
           status = excluded.status,
           size_bytes = COALESCE(excluded.size_bytes, items.size_bytes),
           sha256 = COALESCE(excluded.sha256, items.sha256),
           expected_sha256 = COALESCE(excluded.expected_sha256, items.expected_sha256),
           download_ref = COALESCE(excluded.download_ref, items.download_ref),
           receipt_at = COALESCE(excluded.receipt_at, items.receipt_at),
           error_code = excluded.error_code,
           updated_at = excluded.updated_at`,
      )
      .run(
        item.runId,
        item.itemKey,
        item.pageIndex,
        item.rowIndex,
        item.title,
        item.status,
        item.sizeBytes ?? null,
        item.sha256 ?? null,
        item.expectedSha256 ?? null,
        item.downloadRef ?? null,
        item.receiptAt ?? null,
        item.errorCode ?? null,
        nowIso(),
      );
  }

  listItems(runId) {
    return this.db
      .prepare('SELECT * FROM items WHERE run_id = ? ORDER BY page_index, row_index')
      .all(runId);
  }

  countItemsByStatus(runId) {
    return this.db
      .prepare('SELECT status, COUNT(*) AS n FROM items WHERE run_id = ? GROUP BY status')
      .all(runId);
  }

  // -------------------------------------------------------------- ledger

  getLedgerEntry(jobKey, dataset, itemKey) {
    return (
      this.db
        .prepare(
          'SELECT * FROM download_ledger WHERE job_key = ? AND dataset = ? AND item_key = ?',
        )
        .get(jobKey, dataset, itemKey) ?? null
    );
  }

  /** Insert a confirmed download. Fails (unique PK) if it was already booked. */
  confirmDownload(entry) {
    this.db
      .prepare(
        `INSERT INTO download_ledger
           (job_key, dataset, item_key, run_id, sha256, size_bytes, filename, source_page, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.jobKey,
        entry.dataset,
        entry.itemKey,
        entry.runId,
        entry.sha256,
        entry.sizeBytes,
        entry.filename,
        entry.sourcePage,
        nowIso(),
      );
  }

  listLedger(jobKey = null) {
    if (jobKey) {
      return this.db
        .prepare('SELECT * FROM download_ledger WHERE job_key = ? ORDER BY confirmed_at ASC')
        .all(jobKey);
    }
    return this.db.prepare('SELECT * FROM download_ledger ORDER BY confirmed_at ASC').all();
  }

  // -------------------------------------------------------------- events

  addEvent(event) {
    this.db
      .prepare(
        `INSERT INTO events (run_id, at, kind, step, message, error_code, screenshot_ref, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.runId,
        nowIso(),
        event.kind,
        event.step ?? null,
        event.message ?? null,
        event.errorCode ?? null,
        event.screenshotRef ?? null,
        event.payload ? JSON.stringify(event.payload) : null,
      );
  }

  listEvents(runId, limit = 200) {
    return this.db
      .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?')
      .all(runId, limit);
  }

  /** Refuse to open a DB whose parent directory was not creatable etc. */
  static open(dbPath) {
    if (fs.existsSync(dbPath) && !fs.statSync(dbPath).isFile()) {
      throw new Error(`Database path is not a file: ${dbPath}`);
    }
    return new Store(dbPath);
  }
}
