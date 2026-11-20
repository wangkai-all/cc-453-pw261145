#!/usr/bin/env node
import { applyBrowserEnv } from '../src/env.js';

applyBrowserEnv();
const { chromium } = await import('playwright');
const { runJob, parseJobArgs } = await import('../src/job.js');

const args = parseJobArgs(process.argv.slice(2));
const overrides = {};
if (args.baseUrl) overrides.collector = { baseUrl: args.baseUrl };
if (args.headed) overrides.browser = { headless: false };
if (args.maxRetries != null) overrides.collector = { ...(overrides.collector ?? {}), maxRetries: args.maxRetries };

const log = (message) => console.log(`[rpa] ${message}`);

const summary = await runJob({
  jobKey: args.jobKey,
  dataset: args.dataset,
  dataDir: args.dataDir,
  configFile: args.configFile,
  config: overrides,
  runId: args.runId,
  fresh: args.fresh,
  playwright: chromium,
  log,
});

console.log(JSON.stringify(summary, null, 2));
if (summary.status !== 'completed') process.exitCode = 2;
