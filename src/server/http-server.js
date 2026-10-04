/**
 * Zero-dependency HTTP server: tiny router + static file serving + uniform error mapping.
 * No `shell`, no template strings into HTML, no stack traces leaked to clients.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeError, NotFoundError, ValidationError } from '../domain/errors.js';
import { logger } from '../core/logger.js';
import { toPosix } from '../core/util.js';
import { createLocalGuard, guardPayload } from './local-guard.js';

const log = logger.child('http');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:[A-Za-z0-9_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }).replace(/\*/g, '.*')}$`);
    this.routes.push({ method, rx, keys, handler, pattern });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  describe() {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }
}

export async function readJsonBody(req, { limit = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const error = new ValidationError('request body too large', [{ path: 'body', message: `exceeds ${limit} bytes` }]);
        error.status = 413;
        error.closeConnection = true;
        chunks.length = 0;
        reject(error);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new ValidationError('invalid JSON body', [{ path: 'body', message: err.message }])); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(WEB_ROOT, rel);
  if (abs !== WEB_ROOT && !abs.startsWith(WEB_ROOT + path.sep)) { sendJson(res, 403, { error: { code: 'forbidden', message: 'path traversal denied' } }); return true; }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
  const ext = path.extname(abs).toLowerCase();
  const body = fs.readFileSync(abs);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
  return true;
}

export function createHttpServer({ router, app, guard = null } = {}) {
  // The loopback guard is unconditional. There used to be a `cors` option here that set
  // `access-control-allow-origin: *` and skipped the origin check; no caller passed it, and a
  // wildcard on a state-changing local API is exactly the hole this module closes, so the
  // option is gone rather than defaulted off.
  const localGuard = guard === false ? null : (guard || createLocalGuard());
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '';

    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = toPosix(url.pathname);

      const verdict = localGuard ? localGuard(req, url) : null;
      if (verdict) {
        log.warn('guard_denied', { method: req.method, host: req.headers.host, origin: req.headers.origin || null, code: verdict.code, status: verdict.status });
        sendJson(res, verdict.status, guardPayload(verdict));
        return;
      }

      if (req.method === 'OPTIONS') {
        // Preflight only for our own origin; anything else was refused above.
        res.writeHead(204, { vary: 'Origin' });
        res.end();
        return;
      }

      if (pathname.startsWith('/api/')) {
        const matched = router.match(req.method, pathname);
        if (!matched) { sendJson(res, 404, apiErrorPayload(pathname, { code: 'not_found', message: `no route for ${req.method} ${pathname}` })); return; }
        const query = Object.fromEntries(url.searchParams.entries());
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJsonBody(req) : {};
        const result = await matched.route.handler({ params: matched.params, query, body, req, res, app });
        if (res.writableEnded) return;
        if (result && result.__raw) { sendJson(res, result.status || 200, result.payload); return; }
        sendJson(res, 200, { data: result === undefined ? null : result });
        return;
      }

      if (pathname.startsWith('/files/')) {
        const rel = pathname.slice('/files/'.length);
        const abs = path.join(app.dataDir, 'exports', rel);
        const exportRoot = path.join(app.dataDir, 'exports');
        if (abs !== exportRoot && !abs.startsWith(exportRoot + path.sep)) { sendJson(res, 403, { error: { code: 'forbidden', message: 'path traversal denied' } }); return; }
        if (!fs.existsSync(abs)) { sendJson(res, 404, { error: { code: 'not_found', message: 'file not found' } }); return; }
        const body = fs.readFileSync(abs);
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-length': body.length });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
      sendJson(res, 404, { error: { code: 'not_found', message: `not found: ${pathname}` } });
    } catch (err) {
      const e = normalizeError(err);
      if (err.closeConnection) res.setHeader('connection', 'close');
      log.warn('request_failed', { method: req.method, path: pathname, code: e.code, status: e.status, message: e.message });
      if (!res.writableEnded) {
        const body = apiErrorPayload(pathname, e.toJSON());
        if (pathname.startsWith('/api/agent/')) body.error.available = agentToolNames(app);
        sendJson(res, e.status, body);
      }
    } finally {
      log.debug('request', { method: req.method, path: pathname, ms: Date.now() - started });
    }
  });
  server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* noop */ } });
  return server;
}

export function requireParam(body, name, { type = 'string', maxLength = 5000 } = {}) {
  const v = body ? body[name] : undefined;
  if (v === undefined || v === null || (type === 'string' && String(v).trim() === '')) {
    throw new ValidationError(`missing required field "${name}"`, [{ path: name, message: 'is required' }]);
  }
  if (type === 'string') {
    const s = String(v);
    if (s.length > maxLength) throw new ValidationError(`field "${name}" is too long`, [{ path: name, message: `max ${maxLength} characters` }]);
    return s;
  }
  if (type === 'string[]') {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ValidationError(`field "${name}" must be an array of strings`, [{ path: name, message: 'expected string[]' }]);
    return v;
  }
  return v;
}

export function notFound(what, id) { throw new NotFoundError(what, id); }

/**
 * Error body shaping, in one place.
 *
 * The app's own REST surface has always returned `{error:{code,message,hint}}` and its web UI
 * reads `payload.error.message`, so that shape stays. The four Agent-contract endpoints must
 * instead return `{ok:false,error:{code,message}}` (docs/AGENT_API_STANDARD.md), and a
 * bare `{error}` there is a contract violation a tool caller cannot parse — which is exactly
 * what a malformed JSON body or an unmatched /api/agent/* route would otherwise produce.
 */
export function apiErrorPayload(pathname, error) {
  if (typeof pathname === 'string' && pathname.startsWith('/api/agent/')) return { ok: false, error };
  return { error };
}

/** The tool-name list attached to agent-path failures, from the container, never hardcoded here. */
function agentToolNames(app) {
  const list = app && app.agentApi && app.agentApi.available;
  return Array.isArray(list) ? list.slice() : [];
}

export { sendJson, WEB_ROOT };
