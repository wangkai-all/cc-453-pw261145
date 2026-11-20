import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createFixtureServer } from '../fixture/server.js';
import { runJob } from '../src/job.js';
import { Store } from '../src/store.js';
import { runDetail, auditRun } from '../src/inspect.js';
import { startAdminServer } from '../src/admin.js';

export { chromium };

export async function startFixture(overrides = {}) {
  const fixture = createFixtureServer({ config: overrides });
  const { origin, port } = await fixture.listen(0);
  return { fixture, origin, port };
}

export function tempDir(prefix = 'rpa-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeWorkspace() {
  const root = tempDir();
  return {
    root,
    dataDir: path.join(root, 'data'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function runCollector({
  origin,
  dataDir,
  jobKey = 'job-1',
  dataset = 'fixture',
  fresh = false,
  runId = null,
  config = {},
  checkpointProbe = null,
  browserProbe = null,
}) {
  return runJob({
    jobKey,
    dataset,
    dataDir,
    config: {
      collector: {
        baseUrl: origin,
        maxRetries: 2,
        ...(config.collector ?? {}),
      },
      browser: { headless: true, timeoutMs: 10_000, ...(config.browser ?? {}) },
      credentials: { username: 'demo', password: 'demo', ...(config.credentials ?? {}) },
      leaseTtlMs: 30_000,
      retryDelayMs: 50,
      ...(config.extra ?? {}),
    },
    fresh,
    runId,
    playwright: chromium,
    checkpointProbe,
    browserProbe,
  });
}

export function openStore(dataDir) {
  return Store.open(path.join(dataDir, 'rpa.sqlite'));
}

export function detailFor(dataDir, runId) {
  const store = openStore(dataDir);
  try {
    return runDetail(store, runId);
  } finally {
    store.close();
  }
}

export function auditFor(dataDir, runId) {
  const store = openStore(dataDir);
  try {
    return auditRun(store, runId);
  } finally {
    store.close();
  }
}

export function ledgerFor(dataDir, jobKey = 'job-1') {
  const store = openStore(dataDir);
  try {
    return store.listLedger(jobKey);
  } finally {
    store.close();
  }
}

export async function startAdmin({ dataDir, dataset = 'fixture' }) {
  const store = Store.open(path.join(dataDir, 'rpa.sqlite'));
  const admin = startAdminServer({
    store,
    artifactsDir: path.join(dataDir, 'artifacts', dataset),
    port: 0,
  });
  const { url, port } = await admin.listen();
  return {
    url,
    port,
    store,
    async close() {
      await admin.close();
      store.close();
    },
  };
}

export async function control(origin, pathname, body = null) {
  const response = await fetch(`${origin}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}
