#!/usr/bin/env node
// MCP (Model Context Protocol) stdio 桥 —— 通用实现（与 trendscope/agent/mcp-server.mjs 同一份），
// 把本项目的 Agent API 暴露成 MCP tools。
// 用法：node <project>/agent/mcp-server.mjs
// 逻辑：读 agent/.endpoint（或 AGENT_BASE_URL）；不通则按 agent/launch.json 登记的命令自动拉起本地服务。
//
// 这份文件里没有任何项目专属常量：端口、路径、工具名全都是从 .endpoint / launch.json /
// GET /api/agent/tools 现读的。唯一的额外一条是本机令牌 —— Commander 的服务在设置了
// COMMANDER_LOCAL_TOKEN 之后，非 GET 请求要带令牌（src/server/local-guard.js）。这里**只从环境读值**，
// 绝不写死、绝不回显：没设就是没设（读请求本来就不需要令牌），设了就用它，两个名字都认。
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROTOCOL = '2.2.0';
const SERVER_INFO = { name: path.basename(PROJECT_ROOT) + '-agent-api', version: '1.0.0' };

const log = (...a) => process.stderr.write(`[mcp] ${a.join(' ')}\n`);

function endpointFile() {
  const p = path.join(__dirname, '.endpoint');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

/** 令牌只来自环境；值本身永不打印。 */
function localToken() {
  const raw = process.env.AGENT_LOCAL_TOKEN || process.env.COMMANDER_LOCAL_TOKEN || '';
  const trimmed = String(raw).trim();
  return trimmed || null;
}

function authHeaders() {
  const token = localToken();
  return token ? { 'x-commander-token': token } : {};
}

async function rpc(base, method, params) {
  const isList = method === 'tools/list';
  const res = await fetch(`${base}/api/agent/${isList ? 'tools' : 'tool'}`, {
    method: isList ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: isList ? undefined : JSON.stringify(params),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    // 服务返回的是契约信封 {ok:false,error:{code,message,…}}：把 code 一起带出来，
    // 让 MCP 侧看到的不是一句没有主语的文本，而是「confirm_required / unknown_tool / bad_input」
    // 这种能据此行动的原因。
    const code = body?.error?.code ? `${body.error.code}：` : '';
    const available = Array.isArray(body?.error?.available) ? `（本机可用：${body.error.available.join(', ')}）` : '';
    throw new Error(`${code}${body?.error?.message || `HTTP ${res.status}`}${available}`);
  }
  return body;
}

async function ensureBase() {
  const candidates = [process.env.AGENT_BASE_URL, endpointFile(), process.env.AGENT_DEFAULT_BASE].filter(Boolean);
  for (const base of candidates) {
    try {
      const r = await fetch(`${base}/api/health`, { headers: authHeaders(), signal: AbortSignal.timeout(1500) });
      if (r.ok) return base;
    } catch { /* 继续尝试 */ }
  }
  // 自动拉起：约定 agent/launch.json = {"command":"node","args":[…],"ready_port":8787}
  const launchFile = path.join(__dirname, 'launch.json');
  if (!existsSync(launchFile)) throw new Error(`Agent 服务未启动且缺少 ${launchFile}；请先运行 npm run agent:serve`);
  const spec = JSON.parse(readFileSync(launchFile, 'utf8'));
  const child = spawn(spec.command, spec.args, { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true, shell: false });
  child.unref();
  const port = spec.ready_port || 8790;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    for (let p = port; p < port + 12; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/health`, { headers: authHeaders(), signal: AbortSignal.timeout(800) });
        if (r.ok) return `http://127.0.0.1:${p}`;
      } catch { /* 未就绪 */ }
    }
  }
  throw new Error('自动拉起 Agent 服务超时（30s）');
}

let BASE = null;

function msg(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return msg(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return msg(id, {});
  if (method === 'tools/list') {
    BASE = BASE || await ensureBase();
    const body = await rpc(BASE, 'tools/list');
    return msg(id, { tools: body.data.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: t.risk === 'read', destructiveHint: false, openWorldHint: false } })) });
  }
  if (method === 'tools/call') {
    BASE = BASE || await ensureBase();
    try {
      const body = await rpc(BASE, 'tools/call', { tool: params.name, input: params.arguments || {} });
      return msg(id, { content: [{ type: 'text', text: JSON.stringify(body.data, null, 2) }], isError: false });
    } catch (e) {
      return msg(id, { content: [{ type: 'text', text: `调用失败：${e.message}` }], isError: true });
    }
  }
  return err(id, -32601, `不支持的方法：${method}`);
}

let buf = '';

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { write(err(null, -32700, 'parse error')); continue; }
    // 响应是异步的。切勿在此 process.exit()：stdout 接管道时写是异步缓冲的，
    // 立即退出会丢掉尚未 flush 的 tools/list、tools/call 响应。让事件循环自然排空。
    handle(req).then((out) => { if (out) write(out); })
      .catch((e) => write(err(req.id, -32603, e.message)));
  }
});
log(`bridge ready for ${PROJECT_ROOT}`);
