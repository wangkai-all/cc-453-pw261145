import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { auditRun, listRunSummaries, runDetail } from './inspect.js';
import { describeRetryScope } from './pipeline.js';

const MIME = {
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f5f7fa; color: #17222e; line-height: 1.45; }
  header { background: #12202e; color: #eaf2f9; padding: .9rem 1.5rem; }
  header a { color: #9fd0ff; text-decoration: none; }
  main { max-width: 1240px; margin: 0 auto; padding: 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .6rem; }
  .muted { color: #5b6b7c; font-size: .88rem; }
  table { width: 100%; border-collapse: collapse; background: white; font-size: .88rem;
          box-shadow: 0 1px 2px rgba(20,35,50,.08); border-radius: 6px; overflow: hidden; }
  th, td { padding: .5rem .7rem; border-bottom: 1px solid #e4eaf0; text-align: left; vertical-align: top; }
  th { background: #eef3f8; font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: #43566a; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: .1rem .55rem; border-radius: 99px; font-size: .75rem; font-weight: 600; }
  .s-succeeded, .s-completed { background: #dcf5e6; color: #146c3c; }
  .s-failed { background: #fde2e1; color: #a01d18; }
  .s-running { background: #dceafd; color: #124b8f; }
  .s-pending, .s-not_reached, .s-interrupted, .s-abandoned { background: #eceff2; color: #55636f; }
  .s-skipped { background: #fff0d2; color: #8a5b00; }
  .badge-warn { background: #fff0d2; color: #8a5b00; }
  .badge-ok { background: #dcf5e6; color: #146c3c; }
  .badge-bad { background: #fde2e1; color: #a01d18; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: .75rem; margin: 1rem 0; }
  .stat { background: white; border-radius: 6px; padding: .7rem .9rem; box-shadow: 0 1px 2px rgba(20,35,50,.08); }
  .stat b { display: block; font-size: 1.4rem; }
  .error-box { background: #fde2e1; border-left: 4px solid #c0362f; padding: .8rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .ok-box { background: #dcf5e6; border-left: 4px solid #1c7a46; padding: .8rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .info-box { background: #e8f1fb; border-left: 4px solid #2b6cb0; padding: .8rem 1rem; border-radius: 4px; margin: 1rem 0; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .84rem; }
  pre { background: #12202e; color: #e6eef6; padding: .8rem; border-radius: 6px; overflow-x: auto; }
  .shot { max-width: 720px; width: 100%; border: 1px solid #cfd9e2; border-radius: 6px; margin-top: .5rem; }
  .in-scope { background: #fffbe8; }
  .row-scope td:first-child { border-left: 4px solid #e0a800; }
  .toolbar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .tag { font-family: ui-monospace, monospace; background: #eef2f6; padding: .1rem .35rem; border-radius: 3px; }
`;

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · RPA admin</title><style>${CSS}</style></head>
<body>
<header><strong>RPA collector admin</strong> &nbsp;·&nbsp; <a href="/">Runs</a></header>
<main>${body}</main>
</body></html>`;
}

function pill(status) {
  return `<span class="pill s-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function fmt(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function evidenceLink(ref, basePath) {
  if (!ref) return '<span class="muted">—</span>';
  return `<a href="${basePath}/evidence/${escapeHtml(ref)}" target="_blank">${escapeHtml(ref.split('/').pop())}</a>`;
}

function renderRunsPage(summaries) {
  const rows = summaries
    .map(
      (run) => `<tr>
        <td><a href="/runs/${encodeURIComponent(run.runId)}">${escapeHtml(run.runId)}</a></td>
        <td>${escapeHtml(run.jobKey)}</td>
        <td>${pill(run.status)}</td>
        <td>${escapeHtml(run.stage)}</td>
        <td>${run.errorCode ? `<span class="tag">${escapeHtml(run.errorCode)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${run.screenshotRef ? 'yes' : '<span class="muted">no</span>'}</td>
        <td>${escapeHtml(run.attempt)}</td>
        <td>${fmt(run.updatedAt)}</td>
      </tr>`,
    )
    .join('\n');
  return layout(
    'Runs',
    `<h1>Collection runs</h1>
     <p class="muted">Each run is checkpointed per step. Failed runs resume from the first safe point; confirmed downloads are never re-booked.</p>
     ${summaries.length === 0
       ? '<div class="info-box">No runs yet. Start one with <code>node bin/rpa.js --base-url …</code>.</div>'
       : `<table><thead><tr><th>Run</th><th>Job</th><th>Status</th><th>Stage</th><th>Error</th><th>Screenshot</th><th>Attempt</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`}`,
  );
}

function renderRunPage(detail, audit) {
  const run = detail.run;
  const auditHtml = audit
    ? `<div class="${audit.ok ? 'ok-box' : 'error-box'}">
         <strong>Data integrity audit: ${audit.ok ? 'passed' : 'FAILED'}</strong>
         <ul>${audit.checks.map((c) => `<li>${c.ok ? '✓' : '✗'} ${escapeHtml(c.name)}</li>`).join('')}</ul>
       </div>`
    : '';

  const stepRows = detail.steps
    .map(
      (step) => `<tr class="${step.inRetryScope ? 'row-scope' : ''}">
        <td>${step.index}</td>
        <td><strong>${escapeHtml(step.title)}</strong><div class="muted">${escapeHtml(step.key)}</div></td>
        <td>${pill(step.status)}</td>
        <td>${escapeHtml(step.attempts)}</td>
        <td>${step.errorCode ? `<span class="tag">${escapeHtml(step.errorCode)}</span><div class="muted">${escapeHtml(step.message ?? '')}</div>` : escapeHtml(step.message ?? '')}</td>
        <td>${evidenceLink(step.screenshotRef, `/runs/${encodeURIComponent(run.runId)}`)}</td>
        <td>${step.inRetryScope ? '<span class="pill badge-warn">in retry scope</span>' : '<span class="muted">—</span>'}</td>
      </tr>`,
    )
    .join('\n');

  const itemRows = detail.items
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.page)}</td>
        <td><code>${escapeHtml(item.itemKey)}</code><div class="muted">${escapeHtml(item.title)}</div></td>
        <td>${item.booked ? '<span class="pill badge-ok">booked</span>' : `<span class="pill badge-warn">${escapeHtml(item.status)}</span>`}</td>
        <td>${escapeHtml(item.sizeBytes ?? '—')}</td>
        <td>${item.mismatch ? '<span class="pill badge-bad">mismatch</span>' : '<span class="pill badge-ok">ok</span>'}</td>
        <td>${fmt(item.confirmedAt)}</td>
      </tr>`,
    )
    .join('\n');

  const eventRows = detail.events
    .map(
      (event) => `<tr>
        <td>${fmt(event.at)}</td>
        <td><code>${escapeHtml(event.kind)}</code></td>
        <td>${escapeHtml(event.step ?? '—')}</td>
        <td>${escapeHtml(event.message ?? '')}</td>
        <td>${event.errorCode ? `<span class="tag">${escapeHtml(event.errorCode)}</span>` : ''}</td>
      </tr>`,
    )
    .join('\n');

  const failed = run.status === 'failed' || run.status === 'interrupted';
  const shot = run.screenshotRef
    ? `<h2>Failure evidence</h2>
       <p><a href="/runs/${encodeURIComponent(run.runId)}/evidence/${escapeHtml(run.screenshotRef)}" target="_blank">${escapeHtml(run.screenshotRef)}</a></p>
       <img class="shot" src="/runs/${encodeURIComponent(run.runId)}/evidence/${escapeHtml(run.screenshotRef)}" alt="Failure screenshot">`
    : '';

  return layout(
    run.runId,
    `<div class="toolbar"><a href="/">← All runs</a></div>
     <h1>${escapeHtml(run.runId)}</h1>
     <p class="muted">job <code>${escapeHtml(run.jobKey)}</code> · dataset <code>${escapeHtml(run.dataset)}</code> · attempt ${run.attempt} · created ${fmt(run.createdAt)} · updated ${fmt(run.updatedAt)}</p>

     <div class="grid">
       <div class="stat">Status<b>${pill(run.status)}</b></div>
       <div class="stat">Resume stage<b>${escapeHtml(run.stage)}</b></div>
       <div class="stat">Items confirmed<b>${detail.counts.confirmed} / ${detail.counts.items}</b></div>
       <div class="stat">Ledger rows<b>${detail.counts.ledgerRows}</b></div>
       <div class="stat">Checksum issues<b>${detail.counts.mismatched}</b></div>
     </div>

     ${run.errorCode
       ? `<div class="error-box">
            <strong>${escapeHtml(run.errorCode)}</strong> in step <code>${escapeHtml(run.stage)}</code><br>
            ${escapeHtml(run.errorMessage ?? '')}<br>
            <span class="muted">Screenshot: ${run.screenshotRef ? escapeHtml(run.screenshotRef) : 'unavailable'}</span>
          </div>`
       : `<div class="ok-box">No active failure. Run status: ${escapeHtml(run.status)}.</div>`}

     <div class="info-box">
       <strong>Retry scope</strong> — ${escapeHtml(detail.retryPlan.description ?? '—')}<br>
       <span class="muted">Stages that a retry would re-run: ${detail.retryPlan.stagesInScope.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ') || 'none'}. Items already confirmed in the download ledger are skipped even if their files are missing.</span>
     </div>

     ${auditHtml}

     <h2>Steps</h2>
     <table><thead><tr><th>#</th><th>Step</th><th>Status</th><th>Attempts</th><th>Detail</th><th>Evidence</th><th>Retry</th></tr></thead><tbody>${stepRows}</tbody></table>

     <h2>Pages</h2>
     ${detail.pages.length === 0 ? '<p class="muted">No pages enumerated yet.</p>' : `<table><thead><tr><th>Page</th><th>Status</th><th>Rows</th><th>First</th><th>Last</th><th>Next</th></tr></thead><tbody>${detail.pages.map((p) => `<tr><td>${p.pageIndex}</td><td>${pill(p.status)}</td><td>${p.rowCount}</td><td><code>${escapeHtml(p.firstItemKey ?? '—')}</code></td><td><code>${escapeHtml(p.lastItemKey ?? '—')}</code></td><td>${escapeHtml(p.nextLabel ?? '—')}</td></tr>`).join('')}</tbody></table>`}

     <h2>Items &amp; downloads</h2>
     ${detail.items.length === 0 ? '<p class="muted">No items discovered yet.</p>' : `<table><thead><tr><th>Page</th><th>Item</th><th>State</th><th>Bytes</th><th>Checksum</th><th>Confirmed at</th></tr></thead><tbody>${itemRows}</tbody></table>`}

     ${shot}

     <h2>Event log</h2>
     <table><thead><tr><th>At</th><th>Kind</th><th>Step</th><th>Message</th><th>Code</th></tr></thead><tbody>${eventRows || '<tr><td colspan="5" class="muted">No events.</td></tr>'}</tbody></table>

     ${failed ? `<h2>Resume instructions</h2><pre>node bin/rpa.js --job-key ${escapeHtml(run.jobKey)} --dataset ${escapeHtml(run.dataset)} --base-url &lt;url&gt;</pre>
     <p class="muted">${escapeHtml(describeRetryScope(run.stage))}</p>` : ''}`,
  );
}

export function startAdminServer({ store, artifactsDir, port = 4700, host = '127.0.0.1' }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/' || url.pathname === '/runs') {
        const jobKey = url.searchParams.get('job');
        const summaries = listRunSummaries(store, { jobKey, limit: 200 });
        return sendHtml(res, 200, renderRunsPage(summaries));
      }

      if (url.pathname === '/api/runs') {
        return sendJson(res, 200, listRunSummaries(store, { limit: 200 }));
      }

      if (segments[0] === 'runs' && segments[1] && !segments[2]) {
        const detail = runDetail(store, decodeURIComponent(segments[1]));
        if (!detail) return sendHtml(res, 404, layout('Not found', '<h1>Run not found</h1>'));
        return sendHtml(res, 200, renderRunPage(detail, auditRun(store, detail.run.runId)));
      }

      if (segments[0] === 'runs' && segments[1] && segments[2] === 'api') {
        const detail = runDetail(store, decodeURIComponent(segments[1]));
        if (!detail) return sendJson(res, 404, { error: 'run not found' });
        return sendJson(res, 200, { ...detail, audit: auditRun(store, detail.run.runId) });
      }

      if (segments[0] === 'runs' && segments[1] && segments[2] === 'audit') {
        const audit = auditRun(store, decodeURIComponent(segments[1]));
        if (!audit) return sendJson(res, 404, { error: 'run not found' });
        return sendJson(res, 200, audit);
      }

      if (segments[0] === 'runs' && segments[1] && segments[2] === 'evidence') {
        const rel = decodeURIComponent(segments.slice(3).join('/'));
        return serveArtifact(res, artifactsDir, rel);
      }

      return sendHtml(res, 404, layout('Not found', '<h1>Not found</h1>'));
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve) => server.listen(port, host, resolve));
      return { port: server.address().port, url: `http://${host}:${server.address().port}` };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Serve only files inside artifactsDir. Resolves symlinks and rejects any
 * path that escapes the artifact root (path traversal and symlink escape).
 */
function serveArtifact(res, artifactsDir, relative) {
  const root = fs.realpathSync(artifactsDir);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(root + path.sep)) {
    return sendJson(res, 400, { error: 'invalid artifact path' });
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return sendJson(res, 404, { error: 'artifact not found' });
  }
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) {
    return sendJson(res, 400, { error: 'invalid artifact path' });
  }
  const type = MIME[path.extname(real)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  });
  fs.createReadStream(real).pipe(res);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value, null, 2));
}
