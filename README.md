# Browser RPA collector

A resumable Playwright + SQLite collection pipeline over a login-gated fixture
site. It logs in, enumerates result pages, downloads each listed file, and
verifies what landed on disk against the site manifest.

The design goal is that **every step is a durable checkpoint**, so a crash,
an expired session, or a truncated transfer can never turn into a lost item or
a double-booked one.

## Guarantees

| Requirement | How it is met |
| --- | --- |
| Each step persists resumable state | `runs` / `steps` / `pages` / `items` tables plus a checksummed mirror file per run under `state/<job>/checkpoints/`. The DB commit is the authority; a mirror that is ahead of the DB is not trusted. |
| Page changes fail loudly | Selectors are asserted through `BrowserSession.requireVisible`. A missing table, row shape, pagination control or download link raises a typed `RpaError` with a screenshot + HTML snapshot, never a silent skip. |
| Restart only from a safe checkpoint | Resume picks the *earlier* of {DB state, mirror state}. A confirmed item without a ledger row is rejected as `UNSAFE_RESUME` rather than re-downloaded. Corrupt/tampered mirrors raise `CHECKPOINT_CORRUPT`. |
| Confirmed downloads are never double-booked | `download_ledger` has primary key `(job_key, dataset, item_key)`. Booking is a single transaction that also flips the item to `confirmed` and advances the checkpoint. Duplicate inserts are suppressed, not retried. |
| Admin shows state, evidence, retry scope | `bin/admin.js` renders per-step status, the failure screenshot, an integrity audit, and the exact stages a retry would re-run. |

## Layout

```
bin/rpa.js               collector CLI
bin/admin.js             dashboard CLI
fixture/server.js        fixture site + failure injection (/__control/*)
src/pipeline.js          the four stages, retry policy, resume plan
src/browser.js           Playwright wrapper: assertions, evidence, downloads
src/store.js             SQLite schema, leases, ledger, events
src/checkpoint.js        mirror files, checksum validation, safe resume plan
src/inspect.js           run detail, summaries, integrity audit
src/admin.js             server-rendered dashboard + JSON API
scripts/bootstrap-browser-env.sh   root-free Chromium dependency bootstrap
test/                    end-to-end tests (Node's test runner)
```

Runtime data lives under `--data-dir` (default `.rpa/`):

```
rpa.sqlite
state/<jobKey>/browser/<runId>.storage.json     persisted login state
state/<jobKey>/checkpoints/<runId>.json         checksummed mirror
artifacts/<dataset>/downloads/                  downloaded files
artifacts/<dataset>/screenshots/                failure PNG + HTML evidence
```

## Setup

Node 22.5+ is required (`node:sqlite`). Chromium's shared libraries and fonts
are installed under `.local/` without root:

```bash
npm install
npm run bootstrap        # apt-get download + dpkg-deb -x into .local/, then playwright install
```

`src/env.js` exports `applyBrowserEnv()`, which points `LD_LIBRARY_PATH`,
`FONTCONFIG_FILE` and `PLAYWRIGHT_BROWSERS_PATH` at `.local/`. The collector CLI
and the tests call it automatically; if you launch Chromium yourself, call it
before the first launch.

## Run it

Three terminals:

```bash
# 1. fixture site (demo/demo), port 4600
npm run fixture

# 2. collector
node bin/rpa.js --job-key demo --dataset demo --base-url http://127.0.0.1:4600

# 3. dashboard
node bin/admin.js --data-dir .rpa --port 4700
# open http://127.0.0.1:4700
```

Useful flags: `--fresh` (abandon the previous run and start over),
`--run-id <id>`, `--max-retries N`, `--headed`, `--config <file>`,
`--data-dir <dir>`.

A failed run exits `2` and prints the typed error plus its retry scope.
Re-running the same command resumes the same run from the first item without a
ledger row.

## Failure injection

`POST /__control/config` merges into the fixture config; `GET /__control/state`
reports logins, page views and every download attempt. Options include:

```jsonc
{ "sessionLifetimeRequests": 12 }                          // first session dies mid-run
{ "rejectPassword": "demo" }                               // login rejected
{ "drift": { "page": 2, "selector": "table" } }            // selector disappears
{ "interrupt": { "itemKey": "SKU-004", "onAttempt": 1,
                 "mode": "short-body" } }                  // truncated transfer
{ "downloadDelayMs": 5000 }                                // timeout coverage
```

`POST /__control/reset` restores defaults and clears sessions.

## Tests

```bash
npm test
```

19 end-to-end tests cover the happy path, page drift, login rejection, login
expiry mid-run (with and without retries), truncated downloads, process crash
via a checkpoint probe, a real Chromium process kill, tampered checkpoints,
concurrent-job isolation, same-run lease contention, serial resume, and the
dashboard including path-traversal rejection.
