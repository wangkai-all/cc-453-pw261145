import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from './browser.js';
import { CODES, RpaError } from './errors.js';
import { planResume, readCheckpoint, writeCheckpoint } from './checkpoint.js';
import { ensureDir, nowIso, safeSegment, sha256File } from './util.js';

export const STEPS = Object.freeze([
  { key: 'login', index: 0, title: 'Log in to collector' },
  { key: 'paginate', index: 1, title: 'Enumerate result pages' },
  { key: 'download', index: 2, title: 'Download listed files' },
  { key: 'verify', index: 3, title: 'Verify downloads against manifest' },
]);

/** Natural-language retry scope for the dashboard. */
export function describeRetryScope(stage) {
  switch (stage) {
    case 'login':
      return 'Retry the whole run from the login step. No confirmed download is re-booked.';
    case 'paginate':
      return 'Retry page enumeration only. Downloads already confirmed for this job are never repeated.';
    case 'download':
      return 'Retry the download step, resuming at the first item without a confirmed ledger row.';
    case 'verify':
      return 'Retry verification only. It is read-only over already confirmed downloads.';
    default:
      return 'Unknown scope — a human must inspect this run before retrying.';
  }
}

export class Collector {
  /**
   * @param {object} options
   * @param {import('./store.js').Store} options.store
   * @param {string} options.runId
   * @param {string} options.stateDir
   * @param {string} options.artifactsDir
   * @param {object} options.config
   * @param {import('playwright').BrowserType} [options.playwright] injected for tests
   * @param {Function} [options.log]
   * @param {Function} [options.checkpointProbe] test hook, called after each checkpoint write
   */
  constructor({ store, runId, stateDir, artifactsDir, config, playwright = null, log = () => {}, checkpointProbe = null, browserProbe = null }) {
    this.store = store;
    this.runId = runId;
    this.stateDir = stateDir;
    this.artifactsDir = artifactsDir;
    this.config = config;
    this.playwright = playwright;
    this.log = log;
    this.checkpointProbe = checkpointProbe;
    this.browserProbe = browserProbe;
    this.session = null;
    this.leaseToken = null;
    this.epoch = 0;
    this.failures = 0;
    this.lastGoodStage = null;
    // Distinguishes "the browser died mid-run" from "the browser never
    // started" — the latter is an environment/config problem, not a crash.
    this.browserLaunched = false;
  }

  get run() {
    return this.store.getRun(this.runId);
  }

  // -------------------------------------------------------------- plumbing

  async openBrowser() {
    if (this.session?.isOpen) return this.session;
    if (!this.session) {
      this.session = new BrowserSession({
        playwright: this.playwright,
        artifactsDir: this.artifactsDir,
        headless: this.config.browser.headless,
        timeoutMs: this.config.browser.timeoutMs,
        log: this.log,
      });
    }
    await this.session.launch({ storageState: this.loadStorageState() });
    this.browserLaunched = true;
    this.epoch = this.session.epoch;
    return this.session;
  }

  async relaunchBrowser(reason, { step, page = null, itemKey = null, resumeStage = step }) {
    if (!this.session) return this.openBrowser();
    try {
      await this.session.relaunch({ storageState: this.loadStorageState() });
      this.browserLaunched = true;
    } catch (error) {
      throw new RpaError({
        code: CODES.BROWSER_CRASHED,
        step,
        page,
        itemKey,
        message: `Browser was lost (${reason}) and could not be relaunched: ${error.message}`,
        retryable: true,
        resumeStage,
        details: { reason },
        cause: error,
      });
    }
    this.epoch = this.session.epoch;
    this.store.addEvent({
      runId: this.runId,
      kind: 'browser_relaunch',
      message: `Browser relaunched after ${reason} (epoch ${this.epoch})`,
      step,
    });
    return this.session;
  }

  browserAlive() {
    return Boolean(this.session?.isOpen);
  }

  storageStatePath() {
    return path.join(this.stateDir, 'browser', `${this.runId}.storage.json`);
  }

  loadStorageState() {
    const file = this.storageStatePath();
    return fs.existsSync(file) ? file : null;
  }

  async persistStorageState() {
    if (!this.session?.context) return;
    const file = this.storageStatePath();
    ensureDir(path.dirname(file));
    const state = await this.session.storageState();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  setStep(key, status, patch = {}) {
    const def = STEPS.find((s) => s.key === key) ?? { key, index: 99, title: key };
    this.store.upsertStep({
      runId: this.runId,
      stepKey: key,
      stepIndex: patch.stepIndex ?? def.index,
      title: patch.title ?? def.title,
      status,
      attempts: patch.attempts ?? 0,
      page: patch.page ?? null,
      itemKey: patch.itemKey ?? null,
      message: patch.message ?? null,
      errorCode: patch.errorCode ?? null,
      screenshotRef: patch.screenshotRef ?? null,
      resumeStage: patch.resumeStage ?? null,
      startedAt: status === 'running' ? nowIso() : patch.startedAt ?? null,
      finishedAt: ['succeeded', 'failed', 'skipped'].includes(status) ? nowIso() : null,
    });
  }

  checkpoint(stage, { pageIndex, itemCursor = null, lastConfirmedItem = null, probe = true }) {
    const run = this.run;
    const payload = writeCheckpoint(this.stateDir, {
      runId: this.runId,
      jobKey: run.job_key,
      dataset: run.dataset,
      stage,
      pageIndex,
      itemCursor,
      lastConfirmedItem,
      browserEpoch: this.epoch,
    });
    this.store.updateRun(this.runId, { stage, page_cursor: pageIndex });
    if (probe) {
      this.checkpointProbe?.({ stage, pageIndex, itemCursor, lastConfirmedItem, payload });
    }
    return payload;
  }

  async evidence(label, details = {}) {
    if (!this.session?.isOpen) return null;
    const captured = await this.session.captureEvidence(`${this.runId}-${label}`, { details });
    return captured;
  }

  /** Wrap any error into a typed RpaError, capturing a screenshot when possible. */
  async normalizeError(error, { step, page = null, itemKey = null, resumeStage = step }) {
    const typed = RpaError.from(error, {
      code: CODES.STEP_FAILED,
      step,
      message: `Unexpected failure in ${step}`,
      retryable: false,
      resumeStage,
      page,
      itemKey,
    });
    if (!typed.screenshotRef && this.session?.isOpen) {
      const evidence = await this.evidence(`${step}-${typed.code}`, typed.details).catch(() => null);
      if (evidence) typed.screenshotRef = evidence.screenshotRef;
    }
    this.store.addEvent({
      runId: this.runId,
      kind: 'step_failed',
      step,
      message: typed.message,
      errorCode: typed.code,
      screenshotRef: typed.screenshotRef,
      payload: typed.details,
    });
    return typed;
  }

  markFailure(typed) {
    const scope = typed.resumeStage ?? 'login';
    this.store.updateRun(this.runId, {
      status: 'failed',
      stage: scope,
      error_code: typed.code,
      error_message: typed.message,
      screenshot_ref: typed.screenshotRef ?? null,
      retry_scope: describeRetryScope(scope),
    });
    this.setStep(typed.step, 'failed', {
      page: typed.page,
      itemKey: typed.itemKey,
      message: typed.message,
      errorCode: typed.code,
      screenshotRef: typed.screenshotRef ?? null,
      resumeStage: scope,
    });
  }

  // ---------------------------------------------------------------- driver

  /**
   * Execute or resume the run.
   * @param {object} [options]
   * @param {string} [options.resumeFrom] force a stage (defaults to the safe plan)
   * @param {object} [options.resumePoint] precomputed plan (internal)
   */
  async runPipeline({ resumePoint = null } = {}) {
    const run = this.run;
    if (run.status === 'completed') return this.summary();

    this.leaseToken = this.store.acquireLease(this.runId, {
      ownerPid: process.pid,
      ttlMs: this.config.leaseTtlMs ?? 30_000,
    });
    if (!this.leaseToken) {
      throw new RpaError({
        code: CODES.LEASE_LOST,
        step: 'resume',
        message: 'Another process currently owns this run (or it is already finished)',
        retryable: true,
      });
    }

    const plan = resumePoint ?? this.computeResumePlan();
    this.leaseRenew = setInterval(() => {
      if (!this.store.renewLease(this.runId, this.leaseToken)) {
        this.leaseLost = true;
      }
    }, Math.max(1000, Math.floor((this.config.leaseTtlMs ?? 30_000) / 3)));
    this.leaseRenew.unref?.();

    try {
      await this.openBrowser();
      const stageOrder = ['login', 'paginate', 'download', 'verify'];
      const startIndex = stageOrder.indexOf(plan.stage);
      this.store.updateRun(this.runId, {
        status: 'running',
        stage: plan.stage,
        page_cursor: plan.pageIndex ?? 0,
        attempt: (this.run.attempt ?? 0) + 1,
      });

      let ctx = this.resumeContextFor(plan);
      for (let i = startIndex; i < stageOrder.length; i += 1) {
        const stage = stageOrder[i];
        if (stage === 'login') {
          const result = await this.stageLogin(ctx);
          ctx = { ...ctx, ...result };
        } else if (stage === 'paginate') {
          const result = await this.stagePaginate(ctx);
          ctx = { ...ctx, ...result };
        } else if (stage === 'download') {
          const result = await this.stageDownload(ctx);
          ctx = { ...ctx, ...result };
        } else if (stage === 'verify') {
          await this.stageVerify(ctx);
        }
      }

      this.store.updateRun(this.runId, {
        status: 'completed',
        stage: 'verify',
        error_code: null,
        error_message: null,
        screenshot_ref: null,
        retry_scope: null,
        current_item: null,
        finished_at: nowIso(),
      });
      this.store.addEvent({ runId: this.runId, kind: 'run_completed', message: 'All stages succeeded' });
      await this.persistStorageState().catch(() => {});
      return this.summary();
    } catch (error) {
      // A closed browser turns every selector call into "target closed".
      // Reclassify that plainly so the dashboard says the browser died, and
      // point the retry at the stage's last committed checkpoint.
      if (this.browserLaunched && !this.browserAlive() && !(error instanceof RpaError)) {
        const typedBrowser = new RpaError({
          code: CODES.BROWSER_CRASHED,
          step: this.run.stage,
          message: `Browser/context closed during ${this.run.stage}; the run stopped at its last safe checkpoint.`,
          retryable: true,
          resumeStage: this.run.stage,
          details: { originalMessage: error?.message ?? String(error) },
          cause: error,
        });
        const typed = await this.normalizeError(typedBrowser, {
          step: typedBrowser.step,
          resumeStage: typedBrowser.resumeStage,
        });
        this.markFailure(typed);
        throw typed;
      }
      const typed = await this.normalizeError(error, {
        step: error.step ?? this.run.stage,
        page: error.page ?? null,
        itemKey: error.itemKey ?? null,
        resumeStage: error.resumeStage ?? error.step ?? this.run.stage,
      });
      this.markFailure(typed);
      const wrapped = new RpaError({ ...typed.toRecord(), cause: typed.cause });
      throw wrapped;
    } finally {
      clearInterval(this.leaseRenew);
      this.store.releaseLease(this.runId, this.leaseToken);
      await this.session?.close().catch(() => {});
    }
  }

  // ------------------------------------------------------------ resume plan

  computeResumePlan() {
    const run = this.run;
    const { checkpoint: mirror } = readCheckpoint(this.stateDir, {
      runId: run.run_id,
      jobKey: run.job_key,
      dataset: run.dataset,
    });
    const items = this.store.listItems(this.runId);
    const ledgerKeys = new Set(
      this.store.listLedger(run.job_key).filter((e) => e.dataset === run.dataset).map((e) => e.item_key),
    );
    return planResume({
      run,
      mirror,
      jobKey: run.job_key,
      dataset: run.dataset,
      items,
      ledgerKeys,
    });
  }

  resumeContextFor(plan) {
    return {
      pageIndex: plan.pageIndex ?? 0,
      itemCursor: plan.itemCursor ?? null,
      resumeStage: plan.stage,
    };
  }

  // ------------------------------------------------------------------ login

  async stageLogin(ctx = {}) {
    const startedAt = Date.now();
    this.setStep('login', 'running', { attempts: this.run.attempt });
    this.store.addEvent({ runId: this.runId, kind: 'step_started', step: 'login' });
    const { itemsUrlTemplate, sessionProbeSelector, expiredBannerSelector } = this.config.collector;

    // A relaunched browser may still have a live session cookie; probe the
    // application shell first so a restart does not needlessly re-authenticate.
    await this.session.goto(itemsUrlTemplate(1));
    const hasSession = await this.probeSignedIn();
    if (!hasSession) {
      const onLoginPage = this.session.page.url().includes('/login');
      const expiredBanner = await this.session.page
        .locator(expiredBannerSelector)
        .count()
        .catch(() => 0);
      if (expiredBanner > 0) {
        this.store.addEvent({
          runId: this.runId,
          kind: 'login_expired_banner',
          step: 'login',
          message: 'Collector reported an expired session; re-authenticating',
        });
      }
      if (!onLoginPage) {
        const evidence = await this.evidence('login-shell-missing');
        throw new RpaError({
          code: CODES.SESSION_CHECK_FAILED,
          step: 'login',
          message: `Neither the signed-in shell (${sessionProbeSelector}) nor the login form appeared at ${this.session.page.url()}. The site layout may have changed.`,
          retryable: false,
          resumeStage: 'login',
          screenshotRef: evidence?.screenshotRef ?? null,
          details: { url: this.session.page.url(), evidence },
        });
      }
      await this.fillLogin();
      await this.assertLoggedIn();
    }

    await this.persistStorageState();
    this.checkpoint('paginate', { pageIndex: 1 });
    this.setStep('login', 'succeeded', {
      attempts: this.run.attempt,
      message: `Authenticated as ${this.config.credentials.username} in ${Date.now() - startedAt}ms`,
    });
    this.store.addEvent({ runId: this.runId, kind: 'step_succeeded', step: 'login' });
    return { pageIndex: 1 };
  }

  async probeSignedIn() {
    const { sessionProbeSelector } = this.config.collector;
    return this.session.page
      .locator(sessionProbeSelector)
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
  }

  async fillLogin() {
    const { usernameSelector, passwordSelector, submitSelector, loginUrl } = this.config.collector;
    const formTimeout = Math.min(this.config.browser.timeoutMs, 5000);
    try {
      await this.session.requireVisible(usernameSelector, {
        timeoutMs: formTimeout,
        description: 'username field',
      });
    } catch (error) {
      const evidence = await this.evidence('login-form');
      throw new RpaError({
        code: CODES.LOGIN_FORM_MISSING,
        step: 'login',
        message: `Login form not found at ${loginUrl}. The page layout may have changed — refusing to continue.`,
        retryable: false,
        resumeStage: 'login',
        screenshotRef: evidence?.screenshotRef ?? null,
        details: { url: this.session.page.url(), evidence },
        cause: error,
      });
    }
    await this.session.page.fill(usernameSelector, this.config.credentials.username);
    await this.session.page.fill(passwordSelector, this.config.credentials.password);
    await Promise.all([
      this.session.page.waitForLoadState('domcontentloaded').catch(() => {}),
      this.session.page.click(submitSelector),
    ]);
  }

  async assertLoggedIn() {
    const { sessionProbeSelector, loginUrl, rejectedSelector } = this.config.collector;
    try {
      await this.session.requireVisible(sessionProbeSelector, {
        timeoutMs: Math.min(this.config.browser.timeoutMs, 5000),
        description: 'post-login application shell',
      });
      return;
    } catch (error) {
      const rejected = await this.session.page.locator(rejectedSelector).count().catch(() => 0);
      const evidence = await this.evidence('login-rejected');
      if (rejected > 0) {
        throw new RpaError({
          code: CODES.LOGIN_REJECTED,
          step: 'login',
          message: 'Collector rejected the supplied credentials.',
          retryable: false,
          resumeStage: 'login',
          screenshotRef: evidence?.screenshotRef ?? null,
          details: { url: this.session.page.url(), evidence },
          cause: error,
        });
      }
      throw new RpaError({
        code: CODES.LOGIN_TIMEOUT,
        step: 'login',
        message: `Still on ${this.session.page.url()} after submitting credentials; signed-in marker never appeared.`,
        retryable: true,
        resumeStage: 'login',
        screenshotRef: evidence?.screenshotRef ?? null,
        details: { url: this.session.page.url(), loginUrl, evidence },
        cause: error,
      });
    }
  }

  // --------------------------------------------------------------- paginate

  async stagePaginate(ctx = {}) {
    const startPage = Math.max(1, Number(ctx.pageIndex) || 1);
    await this.ensureAuthenticated();
    this.setStep('paginate', 'running', { attempts: this.run.attempt, resumeStage: 'paginate' });
    this.store.addEvent({ runId: this.runId, kind: 'step_started', step: 'paginate', payload: { startPage } });

    const { itemsUrlTemplate, tableSelector, rowSelector, nextSelector, maxPages } = this.config.collector;
    let current = startPage;
    let totalPages = 0;
    const pages = new Map();

    // Already-known pages before the resume point stay as they were.
    for (const existing of this.store.listPages(this.runId)) {
      pages.set(existing.page_index, existing);
      totalPages = Math.max(totalPages, existing.page_index);
    }

    while (true) {
      if (current > maxPages) {
        throw new RpaError({
          code: CODES.PAGE_OUT_OF_RANGE,
          step: 'paginate',
          message: `Page ${current} exceeds configured maxPages=${maxPages}; possible pagination loop.`,
          retryable: false,
          resumeStage: 'paginate',
          page: current,
        });
      }
      await this.session.goto(itemsUrlTemplate(current));
      await this.assertSessionAlive({ step: 'paginate', page: current, resumeStage: 'paginate' });

      let table;
      try {
        table = await this.session.requireVisible(tableSelector, {
          timeoutMs: Math.min(this.config.browser.timeoutMs, 8000),
          description: 'results table',
        });
      } catch (error) {
        const evidence = await this.evidence(`paginate-page-${current}`);
        throw new RpaError({
          code: CODES.TABLE_MISSING,
          step: 'paginate',
          message: `Results table ${tableSelector} missing on page ${current}. Page layout changed — stopping instead of skipping.`,
          retryable: false,
          resumeStage: 'paginate',
          page: current,
          screenshotRef: evidence?.screenshotRef ?? null,
          details: { url: this.session.page.url(), evidence },
          cause: error,
        });
      }

      const rows = table.locator(rowSelector);
      const rowCount = await rows.count();
      if (rowCount === 0) {
        const endMarker = await this.session.page.locator('#page-end').count().catch(() => 0);
        if (endMarker > 0) break;
        const evidence = await this.evidence(`paginate-empty-${current}`);
        throw new RpaError({
          code: CODES.PAGE_STALLED,
          step: 'paginate',
          message: `Page ${current} rendered an empty results table without an end-of-results marker.`,
          retryable: true,
          resumeStage: 'paginate',
          page: current,
          screenshotRef: evidence?.screenshotRef ?? null,
          details: { evidence },
        });
      }

      const parsed = [];
      for (let i = 0; i < rowCount; i += 1) {
        const row = rows.nth(i);
        const item = await this.parseRow(row, { page: current, row: i });
        parsed.push(item);
        this.store.upsertItem({
          runId: this.runId,
          itemKey: item.itemKey,
          pageIndex: current,
          rowIndex: i,
          title: item.title,
          status: 'listed',
          expectedSha256: item.expectedSha256,
        });
      }

      const nextLabel = await this.readNextLabel(nextSelector);
      this.store.upsertPage({
        runId: this.runId,
        pageIndex: current,
        status: 'listed',
        rowCount: parsed.length,
        firstItemKey: parsed[0]?.itemKey ?? null,
        lastItemKey: parsed.at(-1)?.itemKey ?? null,
        nextLabel,
      });
      totalPages = Math.max(totalPages, current);
      pages.set(current, { page_index: current, row_count: parsed.length });

      this.store.updateRun(this.runId, { page_cursor: current, total_pages: totalPages });
      this.checkpoint('paginate', { pageIndex: current + 1 });

      if (!nextLabel) break;
      current += 1;
    }

    this.store.updateRun(this.runId, { total_pages: totalPages });
    this.setStep('paginate', 'succeeded', {
      attempts: this.run.attempt,
      page: totalPages,
      message: `Enumerated ${totalPages} page(s), ${[...pages.values()].reduce((n, p) => n + (p.row_count ?? 0), 0)} item(s)`,
    });
    this.checkpoint('download', { pageIndex: startPage });
    return { pageIndex: startPage, totalPages };
  }

  async parseRow(row, { page, row: rowIndex }) {
    const itemKey = await this.textOrNull(row.locator(this.config.collector.cellKeySelector));
    const title = await this.textOrNull(row.locator(this.config.collector.cellTitleSelector));
    const expectedSha256 = await this.attrOrNull(
      row.locator(this.config.collector.cellShaSelector),
      'data-sha256',
    );
    if (!itemKey || !title) {
      const evidence = await this.evidence(`row-shape-page-${page}-row-${rowIndex}`);
      throw new RpaError({
        code: CODES.ROW_SHAPE_CHANGED,
        step: 'paginate',
        message: `Row ${rowIndex} on page ${page} is missing key/title cells. The row layout changed — refusing to guess.`,
        retryable: false,
        resumeStage: 'paginate',
        page,
        screenshotRef: evidence?.screenshotRef ?? null,
        details: { rowIndex, itemKey, title, evidence },
      });
    }
    return { itemKey: itemKey.trim(), title: title.trim(), expectedSha256 };
  }

  async readNextLabel(selector) {
    const locator = this.session.page.locator(selector).first();
    const count = await locator.count();
    if (count === 0) {
      const endMarker = await this.session.page.locator('#page-end').count().catch(() => 0);
      const unavailable = await this.session.page.locator('#pagination-unavailable').count().catch(() => 0);
      if (endMarker === 0 && unavailable > 0) {
        const evidence = await this.evidence('pagination-missing');
        throw new RpaError({
          code: CODES.PAGINATION_MISSING,
          step: 'paginate',
          message: `Next-page control ${selector} disappeared before the end-of-results marker. Pagination changed — stopping.`,
          retryable: false,
          resumeStage: 'paginate',
          screenshotRef: evidence?.screenshotRef ?? null,
          details: { selector, evidence },
        });
      }
      return null;
    }
    return (await locator.innerText().catch(() => 'next'))?.trim() || 'next';
  }

  // --------------------------------------------------------------- download

  async stageDownload(ctx = {}) {
    const run = this.run;
    await this.ensureAuthenticated();
    this.reconcileLedgerItems();
    const ledgerKeys = new Set(
      this.store.listLedger(run.job_key).filter((e) => e.dataset === run.dataset).map((e) => e.item_key),
    );
    const items = this.store.listItems(this.runId);
    const pending = items.filter((item) => !ledgerKeys.has(item.item_key));

    this.setStep('download', 'running', {
      attempts: this.run.attempt,
      itemKey: ctx.itemCursor ?? null,
      message: `${pending.length} item(s) to download; ${items.length - pending.length} already booked in the ledger`,
    });
    this.store.addEvent({
      runId: this.runId,
      kind: 'step_started',
      step: 'download',
      payload: { pending: pending.length, cursor: ctx.itemCursor },
    });

    const downloadDir = ensureDir(path.join(this.artifactsDir, 'downloads'));
    let downloadedNow = 0;
    let reused = 0;

    for (const item of pending) {
      const booked = this.store.getLedgerEntry(run.job_key, run.dataset, item.item_key);
      if (booked) {
        reused += 1;
        continue;
      }
      await this.downloadOne(item, downloadDir, { run, items });
      downloadedNow += 1;
    }

    // Everything in this page set must now be in the ledger; verify the invariant.
    const finalKeys = new Set(
      this.store.listLedger(run.job_key).filter((e) => e.dataset === run.dataset).map((e) => e.item_key),
    );
    const missing = items.filter((item) => !finalKeys.has(item.item_key));
    if (missing.length > 0) {
      throw new RpaError({
        code: CODES.DOWNLOAD_INTERRUPTED,
        step: 'download',
        message: `${missing.length} item(s) have no confirmed ledger entry after the download step.`,
        retryable: true,
        resumeStage: 'download',
        details: { missing: missing.map((m) => m.item_key) },
      });
    }

    this.setStep('download', 'succeeded', {
      attempts: this.run.attempt,
      message: `${downloadedNow} downloaded this attempt, ${reused} already confirmed, ${items.length} total`,
    });
    this.checkpoint('verify', { pageIndex: run.page_cursor });
    return {};
  }

  async downloadOne(item, downloadDir, { run }) {
    const { itemsUrlTemplate, downloadSelector, maxRetries } = this.config.collector;
    const page = this.session.page;
    const maxAttempts = Math.max(1, maxRetries + 1);
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (this.leaseLost) {
        throw new RpaError({
          code: CODES.LEASE_LOST,
          step: 'download',
          message: 'Lost the run lease to another worker; aborting to avoid duplicate work.',
          retryable: true,
          resumeStage: 'download',
          itemKey: item.item_key,
        });
      }
      this.store.updateRun(this.runId, { current_item: item.item_key });
      try {
        await this.session.goto(itemsUrlTemplate(item.page_index));
        await this.assertSessionAlive({
          step: 'download',
          itemKey: item.item_key,
          page: item.page_index,
          resumeStage: 'download',
        });

        const row = page.locator(
          `${this.config.collector.rowSelector} >> text=${item.item_key}`,
        ).first();
        await row.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const link = page
          .locator(`${this.config.collector.rowSelector}`, { hasText: item.item_key })
          .locator(downloadSelector)
          .first();
        const linkCount = await link.count();
        if (linkCount === 0) {
          const evidence = await this.evidence(`download-link-${item.item_key}`);
          throw new RpaError({
            code: CODES.DOWNLOAD_BUTTON_MISSING,
            step: 'download',
            message: `Download control missing for ${item.item_key}; the row layout changed. Not skipping the item.`,
            retryable: false,
            resumeStage: 'download',
            itemKey: item.item_key,
            page: item.page_index,
            screenshotRef: evidence?.screenshotRef ?? null,
            details: { evidence },
          });
        }

        const suggestionPath = path.join(
          downloadDir,
          `${safeSegment(item.item_key)}.part-${process.pid}-${attempt}`,
        );
        let result;
        const downloadEvent = this.session.downloadVia(link, {
          suggestionPath,
          timeoutMs: this.config.browser.timeoutMs,
        });
        // If the click instead navigates to the login page (session expired),
        // no download event fires. Race the transfer against a URL watch so
        // the expiry is reported as LOGIN_EXPIRED, not "download never fired".
        const expiryWatch = this.session.page
          .waitForURL((url) => url.pathname.startsWith('/login'), { timeout: this.config.browser.timeoutMs })
          .then(() => ({ expired: true }))
          .catch(() => null);
        try {
          result = await Promise.race([
            downloadEvent.then((value) => ({ value })).catch((error) => ({ error })),
            expiryWatch.then((watched) => (watched ? { expired: true } : new Promise(() => {}))),
          ]);
        } finally {
          // Let a stale expiry watcher die with the page; do not await it.
          expiryWatch.catch(() => {});
        }

        if (result.expired) {
          const evidence = await this.evidence(`session-expired-download-${item.item_key}`);
          throw new RpaError({
            code: CODES.LOGIN_EXPIRED,
            step: 'download',
            page: item.page_index,
            itemKey: item.item_key,
            message: `Session expired while downloading ${item.item_key}: the collector redirected to login. Checkpoint kept; re-authentication resumes the download step.`,
            retryable: true,
            resumeStage: 'download',
            screenshotRef: evidence?.screenshotRef ?? null,
            details: { url: this.session.page.url(), evidence },
          });
        }
        if (result.error) throw result.error;
        result = result.value;

        if (result.interrupted) {
          const evidence = await this.evidence(`download-interrupted-${item.item_key}`);
          throw new RpaError({
            code: CODES.DOWNLOAD_INTERRUPTED,
            step: 'download',
            message: `Transfer for ${item.item_key} ended early (${result.failureReason ?? 'no bytes'}). Item left unbooked for a clean retry.`,
            retryable: true,
            resumeStage: 'download',
            itemKey: item.item_key,
            page: item.page_index,
            screenshotRef: evidence?.screenshotRef ?? null,
            details: { failureReason: result.failureReason, evidence },
          });
        }

        const finalPath = path.join(downloadDir, `${safeSegment(item.item_key)}.${result.sha256.slice(0, 12)}.bin`);
        if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
        fs.renameSync(result.path, finalPath);

        // Guard against a mismatched transfer: the row advertises a size and
        // checksum, and a short/clean-EOF body only shows up here.
        if (item.expected_sha256 && item.expected_sha256 !== result.sha256) {
          fs.rmSync(finalPath, { force: true });
          const sizeNote = result.size && item.expected_sha256
            ? ` (received ${result.size} bytes)`
            : '';
          throw new RpaError({
            code: CODES.DOWNLOAD_INTERRUPTED,
            step: 'download',
            message: `Transfer for ${item.item_key} is incomplete or corrupt${sizeNote}: page advertises ${item.expected_sha256.slice(0, 12)}…, file hashes to ${result.sha256.slice(0, 12)}…. Item left unbooked.`,
            retryable: true,
            resumeStage: 'download',
            itemKey: item.item_key,
            page: item.page_index,
            details: { expected: item.expected_sha256, actual: result.sha256, bytes: result.size },
          });
        }

        // Ledger insert is the commit point. A duplicate (already booked by a
        // concurrent/earlier run) is success-from-the-ledger's-perspective:
        // keep the existing row, drop our redundant file.
        const filename = path.basename(finalPath);
        try {
          this.store.tx(() => {
            this.store.confirmDownload({
              jobKey: run.job_key,
              dataset: run.dataset,
              itemKey: item.item_key,
              runId: this.runId,
              sha256: result.sha256,
              sizeBytes: result.size,
              filename,
              sourcePage: item.page_index,
            });
            this.store.upsertItem({
              runId: this.runId,
              itemKey: item.item_key,
              pageIndex: item.page_index,
              rowIndex: item.row_index,
              title: item.title,
              status: 'confirmed',
              sizeBytes: result.size,
              sha256: result.sha256,
              downloadRef: path.relative(this.artifactsDir, finalPath),
              receiptAt: nowIso(),
              errorCode: null,
            });
            this.checkpoint('download', {
              pageIndex: item.page_index,
              itemCursor: item.item_key,
              lastConfirmedItem: item.item_key,
              probe: false,
            });
          });
          // The probe runs after COMMIT so a simulated crash leaves a fully
          // confirmed ledger row — i.e. the crash boundary is a safe checkpoint.
          try {
            await this.checkpointProbe?.({
              stage: 'download',
              pageIndex: item.page_index,
              lastConfirmedItem: item.item_key,
            });
            await this.browserProbe?.(this.session, { stage: 'download', lastConfirmedItem: item.item_key });
          } catch (probeError) {
            // A probe-thrown "crash" must not be retried or reclassified: the
            // item is already booked, and the process is modelled as dead.
            probeError.simulatedCrash = true;
            throw probeError;
          }
        } catch (error) {
          if (error?.simulatedCrash) throw error;
          const existing = this.store.getLedgerEntry(run.job_key, run.dataset, item.item_key);
          if (existing && /UNIQUE|constraint/i.test(String(error.message))) {
            fs.rmSync(finalPath, { force: true });
            this.store.upsertItem({
              runId: this.runId,
              itemKey: item.item_key,
              pageIndex: item.page_index,
              rowIndex: item.row_index,
              title: item.title,
              status: 'confirmed',
              sizeBytes: existing.size_bytes,
              sha256: existing.sha256,
              downloadRef: null,
              receiptAt: existing.confirmed_at,
              errorCode: null,
            });
            this.store.addEvent({
              runId: this.runId,
              kind: 'ledger_duplicate_suppressed',
              step: 'download',
              message: `${item.item_key} was already confirmed for this job; duplicate not booked.`,
              payload: { existingRun: existing.run_id },
            });
            return;
          }
          throw error;
        }

        this.store.addEvent({
          runId: this.runId,
          kind: 'download_confirmed',
          step: 'download',
          message: `Confirmed ${item.item_key} (${result.size} bytes)`,
          payload: { sha256: result.sha256 },
        });
        return;
      } catch (error) {
        // A browser that died mid-item surfaces as a generic driver error
        // ("target closed"). Classify it here, while we still know which item
        // was in flight, so the failure is reported as BROWSER_CRASHED rather
        // than an opaque STEP_FAILED.
        const browserDied = this.browserLaunched && !this.browserAlive() && !(error instanceof RpaError);
        if (browserDied) {
          lastError = await this.normalizeError(
            new RpaError({
              code: CODES.BROWSER_CRASHED,
              step: 'download',
              message: `Browser/context closed while downloading ${item.item_key}; the run stopped at its last safe checkpoint.`,
              retryable: true,
              resumeStage: 'download',
              page: item.page_index,
              itemKey: item.item_key,
              details: { originalMessage: error?.message ?? String(error) },
              cause: error,
            }),
            { step: 'download', itemKey: item.item_key, page: item.page_index, resumeStage: 'download' },
          );
        } else {
          lastError = error instanceof RpaError ? error : await this.normalizeError(error, {
            step: 'download',
            itemKey: item.item_key,
            page: item.page_index,
            resumeStage: 'download',
          });
        }

        // Only retry transient transport/session problems, never layout changes.
        const transient = [
          CODES.DOWNLOAD_INTERRUPTED,
          CODES.DOWNLOAD_TIMEOUT,
          CODES.LOGIN_EXPIRED,
          CODES.BROWSER_CRASHED,
        ].includes(lastError.code);
        this.store.addEvent({
          runId: this.runId,
          kind: 'download_attempt_failed',
          step: 'download',
          message: lastError.message,
          errorCode: lastError.code,
          payload: { itemKey: item.item_key, attempt: attempt + 1 },
        });
        if (lastError.simulatedCrash) throw lastError;
        if (!transient || attempt === maxAttempts - 1) throw lastError;

        // A dead browser must be relaunched before the item is retried; the
        // page handles are gone and every subsequent call would fail.
        if (!this.browserAlive()) {
          await this.relaunchBrowser('browser crash during download', {
            step: 'download',
            itemKey: item.item_key,
            page: item.page_index,
            resumeStage: 'download',
          });
        } else {
          await this.recoverSession(lastError);
        }
        await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs ?? 150));
      }
    }
    throw lastError;
  }

  /**
   * A new run for a job/dataset that the ledger already covers starts with
   * `listed` item rows. Mark those items confirmed from the ledger so verify
   * (and the dashboard) reflect reality instead of re-downloading them.
   */
  reconcileLedgerItems() {
    const run = this.run;
    const items = this.store.listItems(this.runId);
    let reconciled = 0;
    for (const item of items) {
      if (item.status === 'confirmed') continue;
      const booked = this.store.getLedgerEntry(run.job_key, run.dataset, item.item_key);
      if (!booked) continue;
      this.store.upsertItem({
        runId: this.runId,
        itemKey: item.item_key,
        pageIndex: item.page_index,
        rowIndex: item.row_index,
        title: item.title,
        status: 'confirmed',
        sizeBytes: booked.size_bytes,
        sha256: booked.sha256,
        expectedSha256: item.expected_sha256,
        downloadRef: null,
        receiptAt: booked.confirmed_at,
        errorCode: null,
      });
      reconciled += 1;
    }
    if (reconciled > 0) {
      this.store.addEvent({
        runId: this.runId,
        kind: 'ledger_reconciled',
        step: 'download',
        message: `${reconciled} item(s) were already confirmed for this job; reused from the download ledger`,
      });
    }
  }

  /** Guarantee a live session before a non-login stage runs (e.g. on resume). */
  async ensureAuthenticated() {
    const { itemsUrlTemplate, expiredBannerSelector } = this.config.collector;
    await this.session.goto(itemsUrlTemplate(1));
    if (await this.probeSignedIn()) return;
    const expiredBanner = await this.session.page
      .locator(expiredBannerSelector)
      .count()
      .catch(() => 0);
    if (!this.session.page.url().includes('/login') && expiredBanner === 0) {
      // Not obviously an auth problem — let the stage's own selectors decide.
      return;
    }
    this.store.addEvent({
      runId: this.runId,
      kind: 'session_recovery',
      step: 'login',
      message: 'Stored session was no longer valid on resume; re-authenticating before continuing',
    });
    await this.session.goto(this.config.collector.loginUrl);
    await this.fillLogin();
    await this.assertJustLoggedIn();
    await this.persistStorageState();
    this.setStep('login', 'succeeded', {
      attempts: this.run.attempt,
      message: 'Re-authenticated on resume',
    });
  }

  async recoverSession(error) {
    if (error?.code !== CODES.LOGIN_EXPIRED) return;
    this.store.addEvent({
      runId: this.runId,
      kind: 'session_recovery',
      step: 'login',
      message: 'Session expired mid-run; re-authenticating before retrying',
    });
    this.setStep('login', 'running', { attempts: this.run.attempt, message: 'Re-authenticating after session expiry' });
    await this.session.goto(this.config.collector.loginUrl);
    await this.fillLogin();
    await this.assertJustLoggedIn();
    await this.persistStorageState();
    this.setStep('login', 'succeeded', {
      attempts: this.run.attempt,
      message: 'Session renewed in place after expiry',
    });
    this.store.addEvent({
      runId: this.runId,
      kind: 'step_succeeded',
      step: 'login',
      message: 'Re-authentication succeeded',
    });
  }

  async assertJustLoggedIn() {
    const { sessionProbeSelector } = this.config.collector;
    try {
      await this.session.requireVisible(sessionProbeSelector, {
        timeoutMs: Math.min(this.config.browser.timeoutMs, 5000),
        description: 'signed-in shell after re-authentication',
      });
    } catch (error) {
      const evidence = await this.evidence('reauth-failed');
      throw new RpaError({
        code: CODES.LOGIN_TIMEOUT,
        step: 'login',
        message: 'Re-authentication did not reach the signed-in shell.',
        retryable: true,
        resumeStage: 'login',
        screenshotRef: evidence?.screenshotRef ?? null,
        details: { url: this.session.page.url(), evidence },
        cause: error,
      });
    }
  }

  async assertSessionAlive({ step, itemKey = null, page = null, resumeStage = step }) {
    const run = this.run;
    const url = this.session.page.url();
    if (url.includes('/login')) {
      const evidence = await this.evidence(`session-expired-${step}`);
      throw new RpaError({
        code: CODES.LOGIN_EXPIRED,
        step,
        page,
        itemKey,
        message: `Session expired: redirected to ${url}. Checkpoint kept; re-authentication will resume ${step}.`,
        retryable: true,
        resumeStage,
        screenshotRef: evidence?.screenshotRef ?? null,
        details: { url, step, itemKey },
      });
    }
    if (run.lease_token && this.leaseLost) {
      throw new RpaError({
        code: CODES.LEASE_LOST,
        step,
        page,
        itemKey,
        message: 'Run lease was taken over by another worker.',
        retryable: true,
        resumeStage,
      });
    }
  }

  // ----------------------------------------------------------------- verify

  async stageVerify(ctx = {}) {
    this.setStep('verify', 'running', { attempts: this.run.attempt });
    this.store.addEvent({ runId: this.runId, kind: 'step_started', step: 'verify' });
    const run = this.run;
    const items = this.store.listItems(this.runId);
    const problems = [];

    for (const item of items) {
      const entry = this.store.getLedgerEntry(run.job_key, run.dataset, item.item_key);
      if (!entry) {
        problems.push({ itemKey: item.item_key, reason: 'not in download ledger' });
        continue;
      }
      if (item.status !== 'confirmed') {
        problems.push({ itemKey: item.item_key, reason: `item status is ${item.status}` });
        continue;
      }
      if (item.expected_sha256 && entry.sha256 !== item.expected_sha256) {
        problems.push({
          itemKey: item.item_key,
          reason: 'checksum differs from the value advertised on the listing page',
          expected: item.expected_sha256,
          actual: entry.sha256,
        });
        continue;
      }
      if (item.sha256 && item.sha256 !== entry.sha256) {
        problems.push({
          itemKey: item.item_key,
          reason: 'local receipt hash does not match ledger hash',
          expected: entry.sha256,
          actual: item.sha256,
        });
      }
    }

    // Ledger rows for this job/dataset must all be represented in this run's items.
    const itemKeys = new Set(items.map((i) => i.item_key));
    const stray = this.store
      .listLedger(run.job_key)
      .filter((e) => e.dataset === run.dataset && !itemKeys.has(e.item_key));
    if (stray.length > 0) {
      problems.push({
        reason: 'ledger contains items that are not part of this run',
        itemKeys: stray.map((s) => s.item_key),
      });
    }

    if (problems.length > 0) {
      const evidence = await this.evidence('verify-failed');
      throw new RpaError({
        code: CODES.DOWNLOAD_HASH_MISMATCH,
        step: 'verify',
        message: `Verification failed for ${problems.length} item(s); confirmed downloads were not altered.`,
        retryable: true,
        resumeStage: 'verify',
        screenshotRef: evidence?.screenshotRef ?? null,
        details: { problems },
      });
    }

    this.setStep('verify', 'succeeded', {
      attempts: this.run.attempt,
      message: `Verified ${items.length} item(s) against the download ledger`,
    });
    this.store.addEvent({
      runId: this.runId,
      kind: 'step_succeeded',
      step: 'verify',
      payload: { items: items.length },
    });
    return {};
  }

  // ---------------------------------------------------------------- helpers

  async textOrNull(locator) {
    try {
      if ((await locator.count()) === 0) return null;
      return await locator.first().innerText();
    } catch {
      return null;
    }
  }

  async attrOrNull(locator, name) {
    try {
      if ((await locator.count()) === 0) return null;
      return await locator.first().getAttribute(name);
    } catch {
      return null;
    }
  }

  summary() {
    const run = this.store.getRun(this.runId);
    const itemStats = Object.fromEntries(
      this.store.countItemsByStatus(this.runId).map((row) => [row.status, row.n]),
    );
    return {
      runId: this.runId,
      status: run.status,
      stage: run.stage,
      jobKey: run.job_key,
      dataset: run.dataset,
      error: run.error_code
        ? { code: run.error_code, message: run.error_message, screenshotRef: run.screenshot_ref }
        : null,
      retryScope: run.retry_scope,
      items: itemStats,
      pages: this.store.listPages(this.runId).length,
      steps: this.store.listSteps(this.runId).map((s) => ({
        key: s.step_key,
        status: s.status,
        attempts: s.attempts,
        errorCode: s.error_code,
        screenshotRef: s.screenshot_ref,
      })),
    };
  }
}
