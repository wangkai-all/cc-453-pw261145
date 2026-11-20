import fs from 'node:fs';
import path from 'node:path';
import { CODES, RpaError } from './errors.js';

export const DEFAULT_CONFIG = Object.freeze({
  collector: {
    baseUrl: 'http://127.0.0.1:4600',
    itemsUrlTemplate: (page) => `/items?page=${page}`,
    loginUrl: '/login',
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: '#login-submit',
    rejectedSelector: '#login-error',
    expiredBannerSelector: '#session-expired',
    sessionProbeSelector: '#welcome',
    tableSelector: '#items-table',
    rowSelector: '#items-body tr',
    cellKeySelector: '.col-sku',
    cellTitleSelector: '.col-title',
    cellShaSelector: '.col-sha',
    nextSelector: '#next-page',
    downloadSelector: 'a.download-link',
    maxPages: 50,
    maxRetries: 2,
  },
  browser: {
    headless: true,
    timeoutMs: 15_000,
  },
  credentials: {
    username: 'demo',
    password: 'demo',
  },
  leaseTtlMs: 30_000,
  retryDelayMs: 150,
});

const DEFAULT_ITEMS_URL_TEMPLATE = '/items?page={page}';
const SELECTOR_KEYS = [
  'usernameSelector', 'passwordSelector', 'submitSelector', 'rejectedSelector',
  'expiredBannerSelector', 'sessionProbeSelector', 'tableSelector', 'rowSelector',
  'cellKeySelector', 'cellTitleSelector', 'cellShaSelector', 'nextSelector', 'downloadSelector',
];

/** Serialize config for storage in the runs table (functions cannot persist). */
export function snapshotConfig(config) {
  const clone = JSON.parse(JSON.stringify({
    ...config,
    collector: { ...config.collector, itemsUrlTemplate: DEFAULT_ITEMS_URL_TEMPLATE },
  }));
  delete clone.credentials;
  delete clone.baseUrlExplicit;
  return clone;
}

/** Rebuild a runnable config from a stored snapshot plus current credentials. */
export function restoreConfig(snapshot, credentials) {
  const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return loadConfig({
    overrides: {
      ...base,
      credentials: credentials ?? base.credentials ?? DEFAULT_CONFIG.credentials,
    },
  });
}

function deepMerge(base, patch) {
  if (patch == null) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object') {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig({ file = null, overrides = {} } = {}) {
  let fromFile = null;
  if (file) {
    if (!fs.existsSync(file)) {
      throw new RpaError({
        code: CODES.CONFIG_INVALID,
        step: 'config',
        message: `Config file not found: ${file}`,
        retryable: false,
      });
    }
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new RpaError({
        code: CODES.CONFIG_INVALID,
        step: 'config',
        message: `Config file is not valid JSON: ${error.message}`,
        retryable: false,
      });
    }
  }
  let config = deepMerge(deepMerge({ ...DEFAULT_CONFIG }, fromFile), overrides);
  config.baseUrlExplicit = Boolean(overrides?.collector?.baseUrl || fromFile?.collector?.baseUrl);
  if (!config.collector.baseUrl || !String(config.collector.baseUrl).startsWith('http')) {
    throw new RpaError({
      code: CODES.CONFIG_INVALID,
      step: 'config',
      message: `collector.baseUrl must be an absolute http(s) URL, got ${config.collector.baseUrl}`,
      retryable: false,
    });
  }
  // A support function cannot survive JSON; allow a template string override.
  if (typeof config.collector.itemsUrlTemplate === 'string') {
    const template = config.collector.itemsUrlTemplate;
    config.collector.itemsUrlTemplate = (page) => template.replace('{page}', String(page));
  }
  const collector = config.collector;
  const origin = config.collector.baseUrl.replace(/\/$/, '');
  const wrap = (fn) => (page) => {
    const value = fn(page);
    return /^https?:/.test(value) ? value : `${origin}${value.startsWith('/') ? '' : '/'}${value}`;
  };
  config.collector.itemsUrlTemplate = wrap(collector.itemsUrlTemplate);
  config.collector.loginUrl = /^https?:/.test(collector.loginUrl)
    ? collector.loginUrl
    : `${origin}${collector.loginUrl.startsWith('/') ? '' : '/'}${collector.loginUrl}`;
  for (const key of SELECTOR_KEYS) {
    if (!collector[key] || typeof collector[key] !== 'string') {
      throw new RpaError({
        code: CODES.CONFIG_INVALID,
        step: 'config',
        message: `collector.${key} must be a non-empty selector string`,
        retryable: false,
      });
    }
  }
  return config;
}

export function resolvePaths({ dataDir = process.env.RPA_DATA_DIR ?? '.rpa', jobKey, dataset }) {
  const root = path.resolve(dataDir);
  const stateDir = path.join(root, 'state', jobKey);
  const artifactsDir = path.join(root, 'artifacts', dataset);
  return {
    root,
    dbPath: path.join(root, 'rpa.sqlite'),
    stateDir,
    artifactsDir,
  };
}
