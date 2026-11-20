import { chromium } from 'playwright';
import { ensureDir, parsePositiveInt } from './util.js';
import { resolvePaths, loadConfig, restoreConfig, snapshotConfig } from './config.js';
import { Store } from './store.js';
import { Collector } from './pipeline.js';
import { RpaError } from './errors.js';

/**
 * Orchestrates one collection job:
 *  - reuse a resumable run when the job has an unfinished one
 *  - otherwise create a fresh run
 *  - compute a safe resume point and hand it to the Collector
 */
export async function runJob({
  jobKey,
  dataset,
  config = null,
  configFile = null,
  dataDir = process.env.RPA_DATA_DIR ?? '.rpa',
  runId = null,
  fresh = false,
  playwright = chromium,
  log = () => {},
  checkpointProbe = null,
  browserProbe = null,
}) {
  if (!jobKey) throw new Error('jobKey is required');
  if (!dataset) throw new Error('dataset is required');

  const resolved = loadConfig({ file: configFile, overrides: config ?? {} });
  const paths = resolvePaths({ dataDir, jobKey, dataset });
  ensureDir(paths.root);
  ensureDir(paths.stateDir);
  ensureDir(paths.artifactsDir);

  const store = Store.open(paths.dbPath);
  let collector;
  try {
    let run;
    if (fresh) {
      if (runId === 'latest' || runId == null) {
        const previous = store.listRuns({ jobKey, limit: 1 })[0] ?? null;
        if (previous) {
          store.updateRun(previous.run_id, { status: 'abandoned', retry_scope: null });
        }
      }
      run = store.createRun({
        runId: newRunId(dataset),
        jobKey,
        dataset,
        config: snapshotConfig(resolved),
      });
    } else {
      const chosen = runId ? store.getRun(runId) : null;
      if (runId && !chosen) throw new Error(`Run ${runId} not found`);
      const latest = chosen ?? store.listRuns({ jobKey, limit: 1 })[0] ?? null;
      const reusable =
        latest && ['running', 'failed', 'pending', 'interrupted'].includes(latest.status) ? latest : null;
      run = reusable ?? store.createRun({
        runId: newRunId(dataset),
        jobKey,
        dataset,
        config: snapshotConfig(resolved),
      });
      if (reusable) {
        // A run left "running" means the previous process died; mark it
        // interrupted before we claim it so the dashboard tells the truth.
        if (reusable.status === 'running') {
          store.updateRun(reusable.run_id, { status: 'interrupted' });
          store.addEvent({
            runId: reusable.run_id,
            kind: 'run_interrupted',
            message: 'Previous process ended without finishing; resuming from the last safe checkpoint',
          });
        }
      }
    }

    // Resumed runs must use the exact collector/browser config they started
    // with; only credentials are re-supplied at retry time.
    let effective = resolved;
    if (run.config_json) {
      try {
        const snapshot = JSON.parse(run.config_json);
        if (snapshot?.collector) {
          effective = restoreConfig(snapshot, resolved.credentials);
          if (resolved.baseUrlExplicit) {
            // An explicit --base-url on retry wins (e.g. the fixture moved port).
            effective.collector.baseUrl = resolved.collector.baseUrl;
            effective.collector.itemsUrlTemplate = resolved.collector.itemsUrlTemplate;
            effective.collector.loginUrl = resolved.collector.loginUrl;
          }
        }
      } catch {
        /* corrupt snapshot: fall back to the supplied config */
      }
    }

    collector = new Collector({
      store,
      runId: run.run_id,
      stateDir: paths.stateDir,
      artifactsDir: paths.artifactsDir,
      config: effective,
      playwright,
      log,
      checkpointProbe,
      browserProbe,
    });

    try {
      const summary = await collector.runPipeline();
      return { ...summary, paths };
    } catch (error) {
      if (error instanceof RpaError) {
        return {
          runId: run.run_id,
          status: 'failed',
          stage: error.resumeStage ?? error.step,
          error: error.toRecord(),
          retryScope: collector.run?.retry_scope ?? null,
          paths,
        };
      }
      throw error;
    }
  } finally {
    store.close();
  }
}

function newRunId(dataset) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${dataset}-${stamp}-${rand}`;
}


export function parseJobArgs(argv) {
  const args = { jobKey: 'fixture-job', dataset: 'fixture' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--job' || arg === '--job-key') args.jobKey = argv[++i];
    else if (arg === '--dataset') args.dataset = argv[++i];
    else if (arg === '--data-dir') args.dataDir = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--config') args.configFile = argv[++i];
    else if (arg === '--fresh') args.fresh = true;
    else if (arg === '--max-retries') args.maxRetries = parsePositiveInt(argv[++i], 2);
    else if (arg === '--headed') args.headed = true;
    else if (arg === '--run-id') args.runId = argv[++i];
  }
  return args;
}
