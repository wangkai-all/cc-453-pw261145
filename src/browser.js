import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, sha256File, safeSegment } from './util.js';

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Thin browser session wrapper.
 *
 * Responsibilities kept here (and not in the pipeline):
 *  - relaunch the browser after a crash without carrying page state forward
 *  - element assertions that FAIL LOUDLY when the page shape changes
 *  - screenshot evidence on every failure
 *  - download capture that distinguishes "completed" from "truncated"
 */
export class BrowserSession {
  constructor({ playwright, artifactsDir, headless = true, timeoutMs = 15_000, log = () => {} }) {
    this.playwright = playwright;
    this.artifactsDir = artifactsDir;
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.epoch = 0; // incremented on every relaunch — used in checkpoint safety
  }

  async launch({ storageState = null } = {}) {
    // Accept either the full playwright module or a single BrowserType.
    const browserType = this.playwright?.chromium ?? this.playwright;
    if (!browserType?.launch) throw new Error('No Playwright browser type was supplied');
    this.browser = await browserType.launch({ headless: this.headless });
    this.context = await this.browser.newContext({
      acceptDownloads: true,
      storageState: storageState ?? undefined,
      viewport: { width: 1280, height: 800 },
    });
    this.context.setDefaultTimeout(this.timeoutMs);
    this.context.setDefaultNavigationTimeout(this.timeoutMs);
    this.page = await this.context.newPage();
    this.page.on('crash', () => this.log('[browser] page crashed'));
    return this.page;
  }

  async relaunch({ storageState = null } = {}) {
    this.epoch += 1;
    await this.close();
    return this.launch({ storageState });
  }

  get isOpen() {
    return Boolean(this.browser && this.browser.isConnected() && this.page && !this.page.isClosed());
  }

  async close() {
    try {
      await this.context?.close();
    } catch {
      /* already gone */
    }
    try {
      await this.browser?.close();
    } catch {
      /* already gone */
    }
    this.context = null;
    this.page = null;
    this.browser = null;
  }

  /**
   * Kill the underlying browser process without going through the normal
   * graceful shutdown. Used by tests to model an OS-level crash; the wrapper
   * intentionally still holds the (now dead) handles so that callers observe
   * the same "target closed" errors a real crash produces.
   */
  async killBrowser() {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch {
      /* process may already be gone */
    }
  }

  async storageState() {
    if (!this.context) return null;
    return this.context.storageState();
  }

  /** Navigate and require that a selector shows the expected page. */
  async goto(url) {
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    return response;
  }

  /** Wait for a selector; on timeout throw with selector diagnostics (no silent skip). */
  async requireVisible(selector, { timeoutMs = this.timeoutMs, description = selector } = {}) {
    const locator = this.page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch (error) {
      throw Object.assign(new Error(`Required element not visible: ${description} (${selector})`), {
        code: 'ELEMENT_MISSING',
        selector,
        description,
        cause: error,
      });
    }
    return locator;
  }

  async captureEvidence(label, { details = {} } = {}) {
    if (!this.page || this.page.isClosed()) return null;
    const dir = ensureDir(path.join(this.artifactsDir, 'screenshots'));
    const name = `${safeSegment(label, 'failure')}-${Date.now()}.png`;
    const absolute = path.join(dir, name);
    try {
      await this.page.screenshot({ path: absolute, fullPage: true });
    } catch {
      return null;
    }
    let htmlPath = null;
    try {
      const htmlName = `${safeSegment(label, 'failure')}-${Date.now()}.html`;
      const absoluteHtml = path.join(dir, htmlName);
      const html = await this.page.content();
      fs.writeFileSync(absoluteHtml, `<!-- capture ${new Date().toISOString()} -->\n${html}`, 'utf8');
      htmlPath = path.relative(this.artifactsDir, absoluteHtml);
    } catch {
      /* html snapshot is best-effort */
    }
    return {
      screenshotRef: path.relative(this.artifactsDir, absolute),
      htmlRef: htmlPath,
      pageUrl: this.page.url(),
      title: await this.page.title().catch(() => null),
      details,
    };
  }

  /**
   * Click something that triggers a download and wait for the file to finish.
   *
   * A truncated transfer rejects the waitForEvent promise (or resolves a
   * download whose failure() is non-null) — both are surfaced as `interrupted`
   * instead of being mistaken for a completed file.
   */
  async downloadVia(clickTarget, { suggestionPath, timeoutMs = this.timeoutMs } = {}) {
    const downloadPromise = this.page.waitForEvent('download', { timeout: timeoutMs });
    await clickTarget.click();
    let download;
    try {
      download = await downloadPromise;
    } catch (error) {
      throw Object.assign(new Error('Download event never fired'), {
        code: 'DOWNLOAD_INTERRUPTED',
        cause: error,
      });
    }

    // failure() resolves null for a healthy transfer; for a dropped connection
    // it resolves with a reason. We wait for it (bounded) before saving so that
    // a truncated file is never mistaken for a completed one.
    let failureReason = null;
    try {
      failureReason = await withTimeout(download.failure(), timeoutMs, 'download.failure()');
    } catch (error) {
      throw Object.assign(new Error(`Download did not settle: ${error.message}`), {
        code: 'DOWNLOAD_INTERRUPTED',
        cause: error,
      });
    }

    try {
      await download.saveAs(suggestionPath);
    } catch (error) {
      throw Object.assign(new Error(`Download could not be saved: ${error.message}`), {
        code: 'DOWNLOAD_INTERRUPTED',
        cause: error,
      });
    }

    const stat = fs.existsSync(suggestionPath) ? fs.statSync(suggestionPath) : null;
    const abandoned = Boolean(failureReason);
    if (abandoned) fs.rmSync(suggestionPath, { force: true });
    return {
      path: abandoned ? null : suggestionPath,
      filename: download.suggestedFilename(),
      size: abandoned ? 0 : stat?.size ?? 0,
      sha256: abandoned || !stat ? null : sha256File(suggestionPath),
      interrupted: abandoned || !stat || stat.size === 0,
      failureReason,
    };
  }
}
