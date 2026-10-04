/**
 * Local API guard — the one authentication/origin boundary in front of Commander's HTTP API.
 *
 * Why this exists at all: the server binds 127.0.0.1, and "localhost only" does NOT mean
 * "only my UI". Every process on this machine can reach the socket, and a browser can be made
 * to reach it too. Before this module the only gate was
 * `req.headers.origin === 'http://' + req.headers.host`, which is the rebinding bug in one
 * line: both sides of that comparison come from the attacker's DNS record, so
 * `Host: evil.test:8787` + `Origin: http://evil.test:8787` passed it and could then POST
 * /api/projects/relocate, enqueue a scan that runs a stranger's npm scripts, or publish a
 * project to GitHub.
 *
 * What is checked here, in order, before any route runs:
 *   1. Host allowlist — must be `127.0.0.1:<bound>`, `localhost:<bound>` or `[::1]:<bound>`,
 *      where <bound> is `req.socket.localPort`: the port THIS socket is actually listening
 *      on, which no DNS record can change. Origin is never compared against the request's own
 *      Host header.
 *   2. Origin / Referer — if present, the scheme+host+port must be that same loopback
 *      authority. Absent is fine (curl, Node clients, browser GETs send none).
 *   3. Shared secret — on non-GET methods when COMMANDER_LOCAL_TOKEN is configured, read from
 *      `x-commander-token`, `Authorization: Bearer <t>` or `?token=<t>`, compared with
 *      timingSafeEqual. When it is configured the server mirrors it into
 *      <dataDir>/local-token.txt (0600) so the desktop shell and the MCP bridge keep working
 *      with zero user setup; nothing here forces the token on, because the browser SPA cannot
 *      read that file.
 *
 * This module answers one question — "may this request reach the router?" — and returns a
 * response verdict. It does not know about routes, tools or the database.
 */
import { timingSafeEqual } from 'node:crypto';

/** The only Host authorities this service will answer. Binding is loopback-only (see cli.js). */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

export const TOKEN_ENV_VAR = 'COMMANDER_LOCAL_TOKEN';
export const TOKEN_HEADER = 'x-commander-token';
export const TOKEN_FILE_NAME = 'local-token.txt';

/** Where the token is mirrored for local clients. cli.js owns the write (it owns the data dir). */
export function localTokenFile(dataDir) {
  return `${String(dataDir).replace(/[\\/]+$/, '')}/${TOKEN_FILE_NAME}`;
}

/** Resolve the configured secret: env wins; empty/absent means "no token required". */
export function resolveLocalToken(explicit) {
  const raw = explicit !== undefined ? explicit : process.env[TOKEN_ENV_VAR];
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  return s || null;
}

/**
 * `127.0.0.1:8787` / `evil.test` / `[::1]:8787` → `{ host, port }`.
 * Bracketed IPv6 keeps its port; an unbracketed value containing more than one colon is
 * ambiguous and returned as `{ host: <whole thing>, port: null }` so the caller rejects it.
 */
export function parseAuthority(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  let host = s;
  let port = null;
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close === -1) return null;
    host = s.slice(1, close);
    const tail = s.slice(close + 1);
    if (tail) {
      if (!tail.startsWith(':')) return null;
      port = tail.slice(1);
    }
  } else {
    const first = s.indexOf(':');
    if (first >= 0) {
      if (s.indexOf(':', first + 1) >= 0) return { host: s, port: null };
      host = s.slice(0, first);
      port = s.slice(first + 1);
    }
  }
  if (port !== null && port !== '') {
    if (!/^\d{1,5}$/.test(port)) return { host, port: -1 };
    port = Number(port);
  } else {
    port = null;
  }
  return { host, port };
}

export function isLoopbackName(host) {
  return LOOPBACK_HOSTS.includes(String(host || '').toLowerCase());
}

/** The socket's own local address — a second, independent proof that we are not exposed. */
export function isLoopbackAddress(address) {
  const a = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::1' || a === '::ffff:127.0.0.1') return true;
  if (a.startsWith('127.')) return true;
  return a === 'localhost';
}

/** The authority a correctly-configured client of this server sends. */
export function loopbackAuthority(boundPort) {
  return `127.0.0.1:${boundPort}`;
}

function verdict(status, code, message, hint) {
  return { status, code, message, hint };
}

/** 403: the request arrived, but not from a client this machine treats as its own UI. */
function forbiddenHost(host) {
  return verdict(403, 'forbidden_host',
    `Host "${host || '(missing)'}" is not a loopback address of this machine`,
    '只允许 127.0.0.1 / localhost / [::1] 加上服务实际监听的端口。这正是 DNS rebinding 的拦截点：判据用本机监听端口，绝不拿请求自带的 Host 去对照 Origin。');
}

function forbiddenOrigin(origin, boundPort) {
  return verdict(403, 'forbidden_origin',
    `Origin/Referer "${origin}" is not this service's own http://127.0.0.1:${boundPort}`,
    '跨站请求已被拒绝。本服务只服务本机界面，不开放任何跨源写入（没有 access-control-allow-origin）。');
}

function unauthorized(how) {
  return verdict(401, 'unauthorized',
    `${TOKEN_ENV_VAR} is configured on this server, so ${how} requests must carry the local token`,
    `带上本机令牌：请求头 ${TOKEN_HEADER}: <token>，或 Authorization: Bearer <token>，或 ?token=<token>。令牌已镜像到数据目录的 ${TOKEN_FILE_NAME}，桌面壳与 MCP 桥自动读取。`);
}

/** Timing-safe compare that never throws on unequal lengths. */
export function tokenMatches(provided, expected) {
  const a = String(provided ?? '');
  const b = String(expected ?? '');
  if (!b) return !a ? true : false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function extractToken(url, headers) {
  const header = headers[TOKEN_HEADER] || headers[TOKEN_HEADER.toLowerCase()];
  if (header) return String(header).trim();
  const auth = String(headers.authorization || '').trim();
  const m = /^(?:Bearer|Token)\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const q = url.searchParams.get('token');
  return q ? String(q).trim() : '';
}

/**
 * The single decision function. Returns `null` when the request may proceed, otherwise a
 * verdict carrying the HTTP status and the contract-shaped error body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url parsed request URL
 * @param {{token?:string|null}} [options] override the configured secret (tests); default is env
 */
export function guardRequest(req, url, options = {}) {
  const socket = req.socket || {};
  const boundPort = socket.localPort;
  const headers = req.headers || {};

  if (!Number.isInteger(boundPort) || boundPort <= 0) {
    return verdict(500, 'guard_unavailable', 'cannot determine the listening port of this socket', '拒绝放行：判据不成立时不假装通过。');
  }

  // 1. Host allowlist, checked against the port this socket is listening on.
  const host = parseAuthority(headers.host);
  if (!host || !isLoopbackName(host.host)) return forbiddenHost(headers.host);
  if (host.port !== null && host.port !== boundPort) return forbiddenHost(`${headers.host}`);
  if (host.port === null && boundPort !== 80) return forbiddenHost(`${headers.host} (缺少端口)`);

  // 2. Never answer a socket that somehow got bound to a routable interface.
  if (socket.localAddress && !isLoopbackAddress(socket.localAddress)) {
    return verdict(403, 'forbidden_binding', `server socket is bound to ${socket.localAddress}, not loopback`, '只监听 127.0.0.1。');
  }

  // 3. Origin and Referer against the same loopback authority — never against req.headers.host.
  for (const headerName of ['origin', 'referer']) {
    const value = headers[headerName];
    if (!value) continue;
    if (String(value).trim() === 'null') return forbiddenOrigin('null', boundPort);
    let parsedUrl;
    try {
      parsedUrl = new URL(String(value).trim());
    } catch {
      return forbiddenOrigin(String(value), boundPort);
    }
    if (parsedUrl.protocol !== 'http:') return forbiddenOrigin(String(value), boundPort);
    const authority = parseAuthority(parsedUrl.host);
    if (!authority || !isLoopbackName(authority.host)) return forbiddenOrigin(String(value), boundPort);
    const originPort = authority.port === null ? 80 : authority.port;
    if (originPort !== boundPort) return forbiddenOrigin(String(value), boundPort);
  }

  // 4. Shared secret on state-changing methods, only when one is configured.
  const expected = options.token === undefined ? resolveLocalToken() : resolveLocalToken(options.token);
  if (expected && req.method !== 'GET' && req.method !== 'HEAD') {
    const provided = extractToken(url, headers);
    if (!provided) return unauthorized(req.method);
    if (!tokenMatches(provided, expected)) {
      return verdict(401, 'bad_token', 'the local token supplied with this request is not valid', '检查请求头 x-commander-token 是否等于数据目录 local-token.txt 里的值。');
    }
  }

  return null;
}

/** Error body for a guard verdict. `ok:false` is what the Agent API contract demands. */
export function guardPayload(v) {
  return { ok: false, error: { code: v.code, message: v.message, hint: v.hint } };
}

/**
 * Build the request hook used by http-server.js. Kept as a factory so the configured secret is
 * read once per server (startup env), not re-parsed per request.
 */
export function createLocalGuard(options = {}) {
  const token = options.token === undefined ? resolveLocalToken() : resolveLocalToken(options.token);
  const guard = (req, url) => guardRequest(req, url, { token });
  guard.tokenRequired = Boolean(token);
  guard.tokenFileFor = (dataDir) => localTokenFile(dataDir);
  return guard;
}
