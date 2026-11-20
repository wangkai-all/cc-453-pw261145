/**
 * Test/demo environment bootstrap.
 *
 * Chromium in this container needs two things that the base image omits:
 *  - shared libraries (glib, nss, atk, …) and fonts
 *  - a fontconfig file pointing at those fonts
 *
 * `scripts/bootstrap-browser-env.sh` downloads and extracts them into
 * .local/browser-deps (gitignored). This module wires the resulting paths into
 * the current process so tests and CLIs need no shell exports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.resolve(here, '..');

export const BROWSER_DEPS = path.join(workspaceRoot, '.local', 'browser-deps');
export const BROWSERS_PATH = path.join(workspaceRoot, '.local', 'browsers');
export const FONTS_DIR = path.join(workspaceRoot, '.local', 'fonts');

function existingLibDirs() {
  return [
    path.join(BROWSER_DEPS, 'usr/lib/x86_64-linux-gnu'),
    path.join(BROWSER_DEPS, 'lib/x86_64-linux-gnu'),
  ].filter((dir) => fs.existsSync(dir));
}

/**
 * Apply LD_LIBRARY_PATH / FONTCONFIG_FILE / PLAYWRIGHT_BROWSERS_PATH for the
 * current process. Chromium reads LD_LIBRARY_PATH from its own environment, so
 * this must run before the first browser launch.
 */
export function applyBrowserEnv() {
  const libDirs = existingLibDirs();
  if (libDirs.length > 0) {
    const existing = (process.env.LD_LIBRARY_PATH ?? '').split(':').filter(Boolean);
    process.env.LD_LIBRARY_PATH = [...new Set([...libDirs, ...existing])].join(':');
  }

  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(BROWSERS_PATH)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;
  }

  if (!process.env.FONTCONFIG_FILE && fs.existsSync(FONTS_DIR)) {
    const confPath = path.join(BROWSER_DEPS, 'fonts.conf');
    fs.mkdirSync(path.dirname(confPath), { recursive: true });
    fs.writeFileSync(
      confPath,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${FONTS_DIR}</dir>\n  <cachedir>${path.join(BROWSER_DEPS, 'font-cache')}</cachedir>\n</fontconfig>\n`,
      'utf8',
    );
    process.env.FONTCONFIG_FILE = confPath;
  }
  return {
    libDirs,
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
    fontconfig: process.env.FONTCONFIG_FILE ?? null,
  };
}

export function browserEnvStatus() {
  return {
    libDirs: existingLibDirs(),
    browsersPath: fs.existsSync(BROWSERS_PATH) ? BROWSERS_PATH : null,
    fonts: fs.existsSync(FONTS_DIR),
  };
}
