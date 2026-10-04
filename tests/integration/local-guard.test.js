/**
 * Local API guard — the authentication/origin boundary, tested on a REAL server.
 *
 * Every test here is written so it fails against the pre-fix gate. That pre-fix gate was
 * `req.headers.origin === 'http://' + req.headers.host`: both sides of it come from the
 * attacker's DNS record, so the rebinding pair in `DNS rebinding …` below used to sail
 * straight through to the router and reach a write endpoint.
 *
 * Nothing is stubbed: a real App on an isolated temp data dir, a real http.Server on an
 * ephemeral loopback port, real sockets with hand-written Host/Origin/Referer headers.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { App } from '../../src/core/app.js';
import { buildRouter } from '../../src/server/routes.js';
import { createHttpServer } from '../../src/server/http-server.js';
import { createLocalGuard, guardRequest, parseAuthority, tokenMatches, localTokenFile } from '../../src/server/local-guard.js';
import { makeTempDir } from '../helpers/tmp.js';

const ROOT = makeTempDir('apc-guard-');
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'local-secret-value-1234';

let app;
let server;
let port;
let guardedApp;
let guardedServer;
let guardedPort;

/**
 * A real socket to 127.0.0.1:<port> with an arbitrary Host header — the shape DNS rebinding
 * and every non-browser local client actually produce. Node only derives `Host` from the
 * connection target when the caller did not set one, so this is a faithful spoof.
 */
function raw({ method = 'GET', p = '/api/health', host, origin, referer, headers = {}, body = null, targetPort = null }) {
  return new Promise((resolve, reject) => {
    const out = { status: 0, headers: {}, text: '', json: null };
    const req = http.request({
      host: '127.0.0.1',
      port: targetPort ?? port,
      method,
      path: p,
      headers: {
        ...(host ? { host } : {}),
        ...(origin ? { origin } : {}),
        ...(referer ? { referer } : {}),
        ...headers,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      out.status = res.statusCode;
      out.headers = res.headers;
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        out.text = text;
        try { out.json = text ? JSON.parse(text) : null; } catch { out.json = null; }
        resolve(out);
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  app = new App({ dataDir: path.join(ROOT, 'data-open'), logLevel: 'error' });
  server = createHttpServer({ router: buildRouter(app), app });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  // Same router behind a configured secret: what COMMANDER_LOCAL_TOKEN produces.
  guardedApp = new App({ dataDir: path.join(ROOT, 'data-token'), logLevel: 'error' });
  guardedServer = createHttpServer({ router: buildRouter(guardedApp), app: guardedApp, guard: createLocalGuard({ token: SECRET }) });
  await new Promise((resolve) => guardedServer.listen(0, '127.0.0.1', resolve));
  guardedPort = guardedServer.address().port;
});

after(() => {
  for (const [a, s] of [[app, server], [guardedApp, guardedServer]]) {
    try { a.close(); } catch { /* noop */ }
    try { s.close(); } catch { /* noop */ }
  }
});

describe('Host allowlist (the DNS rebinding gate)', () => {
  test('a foreign Host is refused outright', async () => {
    const res = await raw({ host: 'evil.test' });
    assert.equal(res.status, 403);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'forbidden_host');
    assert.equal(res.json.error.message.includes('evil.test'), true);
  });

  test('a foreign Host carrying our own port is refused', async () => {
    const res = await raw({ host: `evil.test:${port}` });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_host');
  });

  test('DNS rebinding: matching Host and Origin no longer authorises a write', async () => {
    // The pre-fix check compared Origin against the request's own Host — both attacker-supplied
    // once evil.test resolves to 127.0.0.1 — so this POST reached the router and relocated
    // project records. It must now be refused on the Host allowlist alone.
    const res = await raw({
      method: 'POST', p: '/api/projects/relocate',
      host: `evil.test:${port}`, origin: `http://evil.test:${port}`, body: { moves: [] },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_host', 'Host must be judged against the bound port, never against Origin');
    assert.equal(res.text.includes('apc-'), false, 'a refused request must not echo workspace data');
  });

  test('a loopback Host pointing at a different port is refused', async () => {
    const res = await raw({ host: '127.0.0.1:1' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_host');
  });

  test('the legitimate loopback Host with no Origin is accepted', async () => {
    const res = await raw({ host: `127.0.0.1:${port}` });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.ok, true);
  });

  test('localhost and [::1] with the bound port are accepted', async () => {
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      const res = await raw({ host });
      assert.equal(res.status, 200, `${host} should be an allowed loopback authority`);
    }
  });

  test('the server is listening on a loopback address', () => {
    const addr = server.address();
    assert.equal(addr.family, 'IPv4');
    assert.equal(addr.address, '127.0.0.1');
    const guarded = guardedServer.address();
    assert.ok(guarded.address === '127.0.0.1' || guarded.address === '::1', `not loopback: ${guarded.address}`);
  });
});

describe('Origin / Referer', () => {
  test('a foreign Origin on a POST is refused', async () => {
    const res = await raw({ method: 'POST', p: '/api/projects/relocate', origin: 'https://evil.example', body: { moves: [] } });
    assert.equal(res.status, 403);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'forbidden_origin');
  });

  test('a foreign Referer is refused, including on GET', async () => {
    const res = await raw({ referer: 'https://evil.example/attack.html' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_origin');
  });

  test('a same-origin Origin is accepted on a write', async () => {
    const res = await raw({
      method: 'POST', p: '/api/projects/relocate',
      host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, body: { moves: [] },
    });
    assert.equal(res.status, 400, 'the guard must pass it to the router, which rejects the empty move list');
    assert.equal(res.json.error.code, 'validation_error');
  });

  test('a null Origin (file:// or sandboxed frame) is refused', async () => {
    const res = await raw({ method: 'POST', p: '/api/projects/relocate', origin: 'null', body: {} });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_origin');
  });

  test('the own-origin check does not read the request Host as truth', async () => {
    // Origin looks fine and Host matches it; only the bound port can tell them apart.
    const res = await raw({ method: 'POST', p: '/api/projects/relocate', host: `localhost:${port}`, origin: `http://localhost:${port}`, body: {} });
    assert.equal(res.status, 400, 'a genuine loopback authority must still reach the router');
  });
});

describe('no cross-origin write surface', () => {
  test('no response carries access-control-allow-origin', async () => {
    for (const p of ['/api/health', '/api/projects', '/api/dashboard']) {
      const res = await raw({ p });
      assert.equal(res.headers['access-control-allow-origin'], undefined, `${p} was wildcarded`);
    }
  });

  test('the old cors escape hatch cannot re-open the wildcard any more', async () => {
    const legacy = createHttpServer({ router: buildRouter(app), app, cors: true });
    await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve));
    try {
      const res = await raw({ p: '/api/health', targetPort: legacy.address().port });
      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    } finally {
      legacy.close();
    }
  });
});

describe('COMMANDER_LOCAL_TOKEN', () => {
  test('reads it from the environment when no explicit secret is given', (t) => {
    const previous = process.env.COMMANDER_LOCAL_TOKEN;
    process.env.COMMANDER_LOCAL_TOKEN = 'env-configured-token';
    t.after(() => {
      if (previous === undefined) delete process.env.COMMANDER_LOCAL_TOKEN;
      else process.env.COMMANDER_LOCAL_TOKEN = previous;
    });
    assert.equal(createLocalGuard().tokenRequired, true);
    assert.equal(createLocalGuard({ token: null }).tokenRequired, false);
    assert.equal(tokenMatches('env-configured-token', 'env-configured-token'), true);
    assert.equal(tokenMatches('env-configured-toke', 'env-configured-token'), false);
    assert.equal(tokenMatches('', 'env-configured-token'), false);
  });

  test('a write without the token is refused, and the router is never reached', async () => {
    const res = await raw({ method: 'POST', p: '/api/projects/relocate', host: `127.0.0.1:${guardedPort}`, body: { moves: [] }, targetPort: guardedPort });
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'unauthorized');
    assert.match(res.json.error.hint, /local-token\.txt/);
  });

  test('a wrong token is refused', async () => {
    const res = await raw({
      method: 'POST', p: '/api/projects/relocate', host: `127.0.0.1:${guardedPort}`,
      headers: { 'x-commander-token': 'guess-guess-guess' }, body: { moves: [] }, targetPort: guardedPort,
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'bad_token');
  });

  test('the header, the bearer form and the query form are all honoured', async () => {
    const variants = [
      { headers: { 'x-commander-token': SECRET } },
      { headers: { authorization: `Bearer ${SECRET}` } },
      { p: `/api/projects/relocate?token=${SECRET}` },
    ];
    for (const v of variants) {
      const res = await raw({
        method: 'POST', p: v.p || '/api/projects/relocate', host: `127.0.0.1:${guardedPort}`,
        body: { moves: [] }, targetPort: guardedPort, headers: v.headers || {},
      });
      assert.equal(res.status, 400, `${JSON.stringify(v)} should have reached the router`);
      assert.equal(res.json.error.code, 'validation_error');
    }
  });

  test('GET needs no token, so the page and the health probe still load', async () => {
    const res = await raw({ p: '/api/health', host: `127.0.0.1:${guardedPort}`, targetPort: guardedPort });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.ok, true);
  });

  test('a token-bearing server also refuses a foreign Host', async () => {
    const res = await raw({ method: 'POST', p: '/api/projects/relocate', host: `evil.test:${guardedPort}`, headers: { 'x-commander-token': SECRET }, body: {}, targetPort: guardedPort });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_host');
  });

  test('the secret is mirrored into the data dir for local clients, mode-limited', async () => {
    assert.equal(localTokenFile('/tmp/x'), '/tmp/x/local-token.txt');
    // Real check: boot the actual CLI with the env var set and read what it wrote.
    const dataDir = path.join(ROOT, 'data-cli');
    const freePort = 18700 + (process.pid % 300);
    const child = spawn(process.execPath, ['src/server/cli.js', 'start', '--port', String(freePort), '--demo=false'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, COMMANDER_DATA_DIR: dataDir, COMMANDER_LOCAL_TOKEN: SECRET, COMMANDER_LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const tokenFile = path.join(dataDir, 'local-token.txt');
    try {
      const base = await waitForServerUrl(dataDir, 30000);
      assert.ok(base.startsWith(`http://127.0.0.1:${freePort}`) || base.startsWith('http://127.0.0.1:'), base);
      assert.ok(fs.existsSync(tokenFile), `expected ${tokenFile} to exist; cli output: ${out.slice(0, 400)}`);
      assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), SECRET);
      const stats = fs.statSync(tokenFile);
      if (process.platform !== 'win32') {
        // eslint-disable-next-line no-bitwise
        assert.equal(stats.mode & 0o777, 0o600, 'the token file must not be group/world readable');
      }
      const without = await fetch(`${base}/api/projects/relocate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves: [] }),
      });
      assert.equal(without.status, 401);
      const withToken = await fetch(`${base}/api/projects/relocate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-commander-token': fs.readFileSync(tokenFile, 'utf8').trim() },
        body: JSON.stringify({ moves: [] }),
      });
      assert.equal(withToken.status, 400, 'the token read from the file must be accepted');
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
    } finally {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      await new Promise((resolve) => child.on('close', resolve));
    }
  });
});

describe('guard primitives', () => {
  test('parseAuthority understands the three loopback forms and nothing else', () => {
    assert.deepEqual(parseAuthority('127.0.0.1:8787'), { host: '127.0.0.1', port: 8787 });
    assert.deepEqual(parseAuthority('localhost:8787'), { host: 'localhost', port: 8787 });
    assert.deepEqual(parseAuthority('[::1]:8787'), { host: '::1', port: 8787 });
    assert.deepEqual(parseAuthority('evil.test'), { host: 'evil.test', port: null });
    assert.equal(parseAuthority(''), null);
  });

  test('guardRequest refuses when it cannot prove the listening port', () => {
    const verdict = guardRequest({ method: 'GET', headers: { host: '127.0.0.1:8787' }, socket: {} }, new URL('http://localhost/api/health'));
    assert.equal(verdict.status, 500);
    assert.equal(verdict.code, 'guard_unavailable');
  });

  test('a request missing its Host header is refused, not waved through', async () => {
    // http.request cannot send a truly absent Host (HTTP/1.1 requires it), so drive a raw socket.
    const net = await import('node:net');
    const text = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET /api/health HTTP/1.1\r\nUser-Agent: no-host-probe\r\nConnection: close\r\n\r\n');
      });
      let acc = '';
      sock.on('data', (c) => { acc += c; });
      sock.on('end', () => resolve(acc));
      sock.on('error', reject);
    });
    // Either this guard answers 403 forbidden_host, or Node's own HTTP/1.1 Host requirement
    // answers first — both are a refusal. What must never happen is the router answering.
    assert.match(text, /HTTP\/1\.1 40[0-3]/, `expected a 4xx refusal, got: ${text.split('\r\n')[0]}`);
    assert.doesNotMatch(text, /"ok":\s*true/);
  });
});

async function waitForServerUrl(dataDir, timeoutMs) {
  const file = path.join(dataDir, 'server-url.txt');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      const url = fs.readFileSync(file, 'utf8').trim();
      try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (res.status === 200 || res.status === 403 || res.status === 404) return url;
      } catch { /* not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server-url.txt never became reachable under ${dataDir}`);
}
