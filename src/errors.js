/**
 * Structured failure taxonomy for the collection pipeline.
 *
 * The pipeline must never "skip and continue" when the page changes shape.
 * Every non-recoverable condition is raised as a typed error that carries the
 * step it belongs to, whether retrying could plausibly fix it, which checkpoint
 * a retry must resume from, and (when a browser is available) a screenshot ref.
 */
export class RpaError extends Error {
  /**
   * @param {object} options
   * @param {string} options.code stable machine code, e.g. SELECTOR_MISSING
   * @param {string} options.step one of login|paginate|download|verify
   * @param {string} options.message human readable, shown in the dashboard
   * @param {boolean} [options.retryable] may the same step be retried as-is
   * @param {string|null} [options.resumeStage] checkpoint stage to resume from
   * @param {number|null} [options.page] page index associated with the failure
   * @param {string|null} [options.itemKey] item key associated with the failure
   * @param {string|null} [options.screenshotRef] relative path of evidence screenshot
   * @param {object} [options.details] arbitrary diagnostics persisted as JSON
   * @param {Error} [options.cause]
   */
  constructor({
    code,
    step,
    message,
    retryable = false,
    resumeStage = null,
    page = null,
    itemKey = null,
    screenshotRef = null,
    details = {},
    cause = null,
  }) {
    super(message);
    this.name = 'RpaError';
    this.code = code;
    this.step = step;
    this.retryable = retryable;
    this.resumeStage = resumeStage;
    this.page = page;
    this.itemKey = itemKey;
    this.screenshotRef = screenshotRef;
    this.details = details;
    this.cause = cause;
  }

  withEvidence({ screenshotRef, details }) {
    if (screenshotRef) this.screenshotRef = screenshotRef;
    if (details) this.details = { ...this.details, ...details };
    return this;
  }

  toRecord() {
    return {
      code: this.code,
      step: this.step,
      message: this.message,
      retryable: this.retryable,
      resumeStage: this.resumeStage,
      page: this.page,
      itemKey: this.itemKey,
      screenshotRef: this.screenshotRef,
      details: this.details,
    };
  }

  static from(error, fallback) {
    if (error instanceof RpaError) return error;
    return new RpaError({
      ...fallback,
      message: `${fallback.message}: ${error?.message ?? String(error)}`,
      details: { ...(fallback.details ?? {}), originalStack: error?.stack ?? null },
      cause: error,
    });
  }
}

export const CODES = Object.freeze({
  STEP_FAILED: 'STEP_FAILED',
  LOGIN_FORM_MISSING: 'LOGIN_FORM_MISSING',
  LOGIN_REJECTED: 'LOGIN_REJECTED',
  LOGIN_EXPIRED: 'LOGIN_EXPIRED',
  LOGIN_TIMEOUT: 'LOGIN_TIMEOUT',
  SESSION_CHECK_FAILED: 'SESSION_CHECK_FAILED',

  TABLE_MISSING: 'TABLE_MISSING',
  ROW_SHAPE_CHANGED: 'ROW_SHAPE_CHANGED',
  PAGINATION_MISSING: 'PAGINATION_MISSING',
  PAGE_OUT_OF_RANGE: 'PAGE_OUT_OF_RANGE',
  PAGE_STALLED: 'PAGE_STALLED',

  DOWNLOAD_BUTTON_MISSING: 'DOWNLOAD_BUTTON_MISSING',
  DOWNLOAD_INTERRUPTED: 'DOWNLOAD_INTERRUPTED',
  DOWNLOAD_TIMEOUT: 'DOWNLOAD_TIMEOUT',
  DOWNLOAD_HASH_MISMATCH: 'DOWNLOAD_HASH_MISMATCH',
  DOWNLOAD_SIZE_MISMATCH: 'DOWNLOAD_SIZE_MISMATCH',
  DOWNLOAD_LEDGER_CONFLICT: 'DOWNLOAD_LEDGER_CONFLICT',

  BROWSER_CRASHED: 'BROWSER_CRASHED',
  CHECKPOINT_CORRUPT: 'CHECKPOINT_CORRUPT',
  UNSAFE_RESUME: 'UNSAFE_RESUME',
  LEASE_LOST: 'LEASE_LOST',
  CONFIG_INVALID: 'CONFIG_INVALID',
});
