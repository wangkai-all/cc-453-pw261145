import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

/**
 * Fixture collector site.
 *
 * Deliberately small and dependency-free so the RPA pipeline can be exercised
 * end to end. Controls live under /__control/* and are only used by tests and
 * the demo runner.
 *
 * Behaviours that can be injected at runtime:
 *  - session expiry (time- or request-count based)
 *  - page drift (a selector disappears on a given page)
 *  - interrupted downloads (connection dropped after partial bytes)
 *  - slow downloads (for timeout coverage)
 *  - login rejection for a given password
 */

const DEFAULT_CONFIG = {
  pages: 3,
  rowsPerPage: 3,
  sessionTtlMs: 60 * 60 * 1000,
  sessionMaxRequests: 10_000,
  // Expire the FIRST session after N authenticated requests (mid-run expiry
  // that a fresh login does not inherit).
  sessionLifetimeRequests: null,
  expireAfterDownloads: null,
  rejectPassword: null,
  drift: null, // { page: 2, selector: 'table'|'download-link'|'next-page' }
  interrupt: null, // { itemKey: 'SKU-...', onAttempt: 1, mode: 'drop'|'short-body' }
  downloadDelayMs: 0,
  downloadChunkDelayMs: 0,
};

function itemFor(page, row, rowsPerPage) {
  const index = (page - 1) * rowsPerPage + row;
  const itemKey = `SKU-${String(index + 1).padStart(3, '0')}`;
  const title = `Fixture widget ${itemKey}`;
  const body = `item=${itemKey}\npage=${page}\nrow=${row}\n${'x'.repeat(512 + index * 37)}\n`;
  const buffer = Buffer.from(body, 'utf8');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { itemKey, title, body, size: buffer.length, sha256 };
}

function manifestFor(config) {
  const items = [];
  for (let page = 1; page <= config.pages; page += 1) {
    for (let row = 0; row < config.rowsPerPage; row += 1) {
      const item = itemFor(page, row, config.rowsPerPage);
      items.push({ itemKey: item.itemKey, title: item.title, size: item.size, sha256: item.sha256, page });
    }
  }
  return items;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

const PAGE_CSS = `
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #16202a; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; }
  th, td { border: 1px solid #c8d2dc; padding: .5rem .75rem; text-align: left; }
  th { background: #eef3f7; }
  a.download-link { color: #0b5cad; }
  #next-page { display: inline-block; margin-top: 1rem; padding: .4rem .8rem; background: #0b5cad; color: white; text-decoration: none; border-radius: 4px; }
  .muted { color: #5c6b7a; }
  .banner { padding: .6rem .8rem; background: #fff4d6; border-left: 4px solid #d99e00; margin-bottom: 1rem; }
`;

function renderLogin({ expired = false, error = null, user = '' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture login</title><style>${PAGE_CSS}</style></head>
<body>
  <h1>Fixture collector</h1>
  ${expired ? '<div class="banner" id="session-expired">Your session expired. Sign in again.</div>' : ''}
  ${error ? `<div class="banner" id="login-error">${escapeHtml(error)}</div>` : ''}
  <form id="login-form" method="post" action="/login">
    <p><label for="username">Username</label><br><input id="username" name="username" value="${escapeHtml(user)}" autocomplete="username"></p>
    <p><label for="password">Password</label><br><input id="password" name="password" type="password" autocomplete="current-password"></p>
    <p><button id="login-submit" type="submit">Sign in</button></p>
  </form>
</body></html>`;
}

function renderItems(config, page, rows, session) {
  const driftTable = config.drift?.page === page && config.drift?.selector === 'table';
  const driftDownload =
    config.drift?.page === page && config.drift?.selector === 'download-link';
  const driftNext = config.drift?.page === page && config.drift?.selector === 'next-page';
  const nextPage = page + 1;
  const hasNext = page < config.pages;

  const bodyRows = rows
    .map(
      (item, row) => `<tr data-item-key="${escapeHtml(item.itemKey)}">
        <td class="col-sku">${escapeHtml(item.itemKey)}</td>
        <td class="col-title">${escapeHtml(item.title)}</td>
        <td class="col-size" data-size="${item.size}">${item.size}</td>
        <td class="col-sha" data-sha256="${item.sha256}">${item.sha256.slice(0, 12)}…</td>
        <td>${driftDownload ? '<span class="muted">temporarily unavailable</span>' : `<a class="download-link" data-row="${row}" href="/download/${encodeURIComponent(item.itemKey)}?page=${page}" data-sha256="${item.sha256}" data-size="${item.size}">Download</a>`}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Items page ${page}</title><style>${PAGE_CSS}</style></head>
<body>
  <h1 id="welcome">Signed in as ${escapeHtml(session.user)}</h1>
  <p class="muted">Dataset: fixture · Page <span id="current-page">${page}</span> of ${config.pages}
    ${hasNext && !driftNext ? `<a id="next-page" href="/items?page=${nextPage}">Next page</a>` : ''}
    ${hasNext && driftNext ? '<span class="muted" id="pagination-unavailable">next page unavailable</span>' : ''}
    ${!hasNext ? '<span id="page-end">End of results</span>' : ''}
  </p>
  ${driftTable
    ? '<div class="banner" id="rows-unavailable">The result list could not be rendered.</div>'
    : `<table id="items-table">
        <thead><tr><th>SKU</th><th>Title</th><th>Bytes</th><th>SHA-256</th><th>File</th></tr></thead>
        <tbody id="items-body">
${bodyRows}
        </tbody>
      </table>`}
  <p class="muted" id="session-meta" data-requests="${session.requests}">Request ${session.requests}</p>
</body></html>`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createFixtureServer({ config: overrides = {}, quiet = true } = {}) {
  let config = { ...DEFAULT_CONFIG, ...overrides };
  const state = {
    sessions: new Map(),
    downloads: [],
    loginAttempts: [],
    pageViews: [],
    activeSockets: new Set(),
    seq: 0,
  };

  function newSession(user) {
    const id = `sess-${++state.seq}-${crypto.randomBytes(4).toString('hex')}`;
    const session = {
      id,
      user,
      createdAt: Date.now(),
      expiresAt: Date.now() + config.sessionTtlMs,
      requests: 0,
      // Only the first session is penalised, so a re-login recovers cleanly.
      lifetimeRequests: state.seq === 1 ? config.sessionLifetimeRequests : null,
    };
    state.sessions.set(id, session);
    return session;
  }

  function getSession(req) {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const session = state.sessions.get(cookies.session ?? '');
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      state.sessions.delete(session.id);
      return { expired: true, id: session.id, user: session.user };
    }
    session.requests += 1;
    // `sessionLifetimeRequests` (when set) kills a specific session after N
    // authenticated requests — this models a mid-run expiry that a brand new
    // login does not inherit.
    if (session.lifetimeRequests && session.requests > session.lifetimeRequests) {
      state.sessions.delete(session.id);
      return { expired: true, id: session.id, user: session.user };
    }
    return session;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      // ------------------------------------------------------------- control
      if (pathname.startsWith('/__control/')) {
        return await handleControl(req, res, url);
      }

      // --------------------------------------------------------------- login
      if (pathname === '/login' && req.method === 'GET') {
        const expired = url.searchParams.get('expired') === '1';
        return sendHtml(res, 200, renderLogin({ expired }));
      }

      if (pathname === '/login' && req.method === 'POST') {
        const body = new URLSearchParams(await readBody(req));
        const username = body.get('username') ?? '';
        const password = body.get('password') ?? '';
        state.loginAttempts.push({ username, at: new Date().toISOString(), ok: null });
        if (!username || !password || password === config.rejectPassword) {
          state.loginAttempts.at(-1).ok = false;
          return sendHtml(res, 200, renderLogin({ error: 'Invalid username or password', user: username }));
        }
        const session = newSession(username);
        state.loginAttempts.at(-1).ok = true;
        res.writeHead(303, {
          'Set-Cookie': `session=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax`,
          Location: '/items?page=1',
        });
        return res.end();
      }

      // --------------------------------------------------------------- items
      if (pathname === '/items') {
        const session = getSession(req);
        if (!session) {
          return redirect(res, '/login?expired=1');
        }
        if (session.expired) {
          res.writeHead(303, { 'Set-Cookie': 'session=; Path=/; Max-Age=0', Location: '/login?expired=1' });
          return res.end();
        }
        const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        if (page > config.pages) {
          return sendHtml(res, 200, `<!doctype html><html><body><h1 id="empty-page">No more results</h1><p><a href="/items?page=1">Start over</a></p></body></html>`);
        }
        const rows = [];
        for (let row = 0; row < config.rowsPerPage; row += 1) {
          rows.push(itemFor(page, row, config.rowsPerPage));
        }
        if (config.drift?.page === page) {
          state.pageViews.push({ page, at: new Date().toISOString(), drift: config.drift.selector });
        } else {
          state.pageViews.push({ page, at: new Date().toISOString(), drift: null });
        }
        return sendHtml(res, 200, renderItems(config, page, rows, session));
      }

      // ------------------------------------------------------------ download
      if (pathname.startsWith('/download/')) {
        const session = getSession(req);
        if (!session) return redirect(res, '/login?expired=1');
        if (session.expired) return redirect(res, '/login?expired=1');
        const itemKey = decodeURIComponent(pathname.slice('/download/'.length));
        const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
        const all = manifestFor(config);
        const manifest = all.find((entry) => entry.itemKey === itemKey);
        if (!manifest) return sendHtml(res, 404, '<h1 id="not-found">Unknown item</h1>');
        const rowIndex = all.filter((e) => e.page === manifest.page).indexOf(manifest);
        const item = itemFor(manifest.page, rowIndex, config.rowsPerPage);
        const declaredSize = Buffer.byteLength(item.body, 'utf8');

        const cumulative = state.downloads.filter((d) => d.itemKey === itemKey).length + 1;
        const record = {
          itemKey,
          page,
          at: new Date().toISOString(),
          attempt: cumulative,
          mode: 'ok',
          session: session.id,
          user: session.user,
        };
        state.downloads.push(record);

        const interruptThis =
          config.interrupt?.itemKey === itemKey &&
          (config.interrupt.onAttempt == null || config.interrupt.onAttempt === cumulative);

        if (interruptThis) {
          // Two failure shapes:
          //  short-body  → clean EOF with fewer bytes than the row advertises.
          //                Chrome reports success, so only checksum/size
          //                validation can catch it.
          //  drop        → socket destroyed mid-transfer (Chrome may retry
          //                transparently).
          record.mode = `interrupted:${config.interrupt.mode ?? 'drop'}`;
          const body = Buffer.from(item.body, 'utf8');
          const partial = body.subarray(0, Math.floor(body.length / 2));
          if ((config.interrupt.mode ?? 'drop') === 'short-body') {
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(partial.length),
              'Content-Disposition': `attachment; filename="${itemKey}.txt"`,
              'X-Item-Key': itemKey,
            });
            return res.end(partial);
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(declaredSize),
            'Content-Disposition': `attachment; filename="${itemKey}.txt"`,
            'X-Item-Key': itemKey,
          });
          res.write(partial);
          setTimeout(() => res.destroy(), 10);
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(declaredSize),
          'Content-Disposition': `attachment; filename="${itemKey}.txt"`,
          'X-Item-Key': itemKey,
        });

        if (config.downloadDelayMs > 0) await sleep(config.downloadDelayMs);
        if (config.downloadChunkDelayMs > 0) {
          const buf = Buffer.from(item.body, 'utf8');
          const half = Math.floor(buf.length / 2);
          res.write(buf.subarray(0, half));
          await sleep(config.downloadChunkDelayMs);
          res.end(buf.subarray(half));
          return;
        }
        return res.end(item.body);
      }

      if (pathname === '/') return redirect(res, '/items?page=1');

      return sendHtml(res, 404, '<h1 id="not-found">Not found</h1>');
    } catch (error) {
      if (!quiet) console.error('[fixture] request failed', error);
      if (!res.headersSent) sendHtml(res, 500, '<h1 id="server-error">Fixture error</h1>');
      else res.destroy();
    }
  });

  server.on('connection', (socket) => {
    state.activeSockets.add(socket);
    socket.on('close', () => state.activeSockets.delete(socket));
  });

  async function handleControl(req, res, url) {
    if (url.pathname === '/__control/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      config = { ...config, ...body };
      return sendJson(res, 200, { ok: true, config });
    }
    if (url.pathname === '/__control/reset' && req.method === 'POST') {
      config = { ...DEFAULT_CONFIG, ...overrides };
      state.sessions.clear();
      state.downloads.length = 0;
      state.loginAttempts.length = 0;
      state.pageViews.length = 0;
      // Clearing the session counter lets the next login get a clean budget,
      // modelling "the outage is over, resume the job".
      state.seq = 0;
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/__control/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        config,
        downloads: state.downloads,
        loginAttempts: state.loginAttempts,
        pageViews: state.pageViews,
        activeSessions: [...state.sessions.values()].map((s) => ({ id: s.id, user: s.user, requests: s.requests })),
        manifest: manifestFor(config),
      });
    }
    if (url.pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, { dataset: 'fixture', items: manifestFor(config) });
    }
    return sendJson(res, 404, { error: 'unknown control endpoint' });
  }

  function redirect(res, location) {
    res.writeHead(303, { Location: location });
    res.end();
  }

  return {
    server,
    state,
    getConfig: () => ({ ...config }),
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return { port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
    },
    async close() {
      for (const socket of state.activeSockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
    baseUrl() {
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

// Allow `node fixture/server.js` for manual exploration.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = createFixtureServer({ quiet: false });
  const { origin } = await fixture.listen(Number.parseInt(process.env.PORT ?? '4600', 10));
  console.log(`Fixture collector running at ${origin}`);
  console.log('  login: demo / demo');
  console.log('  control: POST /__control/config, GET /__control/state');
}
