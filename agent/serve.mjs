#!/usr/bin/env node
/**
 * Commander · 一条命令起服（薄封装，不含任何业务逻辑）
 *
 * 服务本来就是项目自带的那一个（`node src/server/cli.js start`，127.0.0.1:8787），
 * Agent 契约的四个端点就地挂在那一个服务上（见 src/server/routes.js），**没有第二个端口、
 * 没有第二份数据库连接**。这里只补三件 Agent 侧需要的事：
 *   1. 先看 8787 是不是已经活着 —— 用户平时是双击 启动.bat 或用桌面壳在跑的，那就是他的实时服务；
 *   2. 没活就用项目自己的方式拉起来（detached，或 --foreground 跟着终端走）；
 *   3. 就绪等待，并把**实际**地址写进 agent/.endpoint —— cli.js 在端口被占时会自动 +1
 *      （最多 +20），并把真实 URL 落到 data/server-url.txt。所以「 advertised 的地址」必须
 *      从那份文件读，不能拿 8787 这个默认值去猜，否则换端口启动时清单就说错话。
 *
 * ⚠ 这个脚本一个进程都不杀：8787 上可能是用户正在用的服务，抢端口的正确反应是复用，不是清理。
 *    要停自己起的那个：窗口里 Ctrl+C，或对桌面壳关窗（cli.js 的 SIGINT/SIGTERM 分支会收尾）。
 *
 * 用法: node agent/serve.mjs [--port 8787] [--foreground] [--print-endpoint]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(PROJECT_ROOT, 'src', 'server', 'cli.js');
const DEFAULT_PORT = 8787;

function say(s) {
  process.stdout.write(`${s}\n`);
}

function pickPort(argv) {
  const cli = argv.find((a) => a.startsWith('--port='));
  if (cli) return Number(cli.split('=')[1]);
  const cliSpace = argv.findIndex((a) => a === '--port');
  if (cliSpace >= 0 && argv[cliSpace + 1]) return Number(argv[cliSpace + 1]);
  const env = Number(process.env.COMMANDER_PORT || process.env.PORT);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_PORT;
}

/** 只读地试一次健康检查。返回契约里的 data 段（拿不到就 null）。 */
async function health(base, timeoutMs = 2000) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body = await r.json();
    return body && body.data ? body.data : null;
  } catch {
    return null;
  }
}

/**
 * 服务实际绑定的地址。cli.js 端口被占时自己 +1，那份真话只写在 <dataDir>/server-url.txt 里。
 * 找不到那份文件就退回请求打成功的那个 base —— 两种情况下都不猜端口。
 */
function urlFileFor(dataDir) {
  const dir = dataDir || path.join(PROJECT_ROOT, 'data');
  const file = path.join(dir, 'server-url.txt');
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/.test(raw) ? raw.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

async function resolveBase(preferredBase, dataDir) {
  const fromFile = urlFileFor(dataDir);
  if (fromFile && await health(fromFile, 2000)) return fromFile;
  return preferredBase;
}

async function waitReady(preferred, dataDir, deadlineMs) {
  const t0 = Date.now();
  let lastReport = 0;
  while (Date.now() - t0 < deadlineMs) {
    const base = await resolveBase(preferred, dataDir);
    const data = await health(base, 3000);
    if (data) return { base, data, ms: Date.now() - t0 };
    const waited = Math.round((Date.now() - t0) / 1000);
    if (waited > 0 && waited - lastReport >= 5) {
      lastReport = waited;
      say(`  等待中… ${waited}s（首次启动可能要导入了才这么久）`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const foreground = argv.includes('--foreground');
  const port = pickPort(argv);
  const preferred = `http://127.0.0.1:${port}`;
  const dataDir = process.env.COMMANDER_DATA_DIR || path.join(PROJECT_ROOT, 'data');

  const already = await health(preferred, 2500);
  if (already) {
    const base = await resolveBase(preferred, dataDir);
    say(`服务已在运行:${base}`);
    say(`  version=${already.version ?? '?'} agent_api=${already.agent_api ?? '?'} tools=${already.tools ?? '?'} uptime_ms=${already.uptime_ms ?? '?'}`);
    writeEndpoint(base);
    printEndpoints(base);
    say('  这个脚本没有起任何新进程，也没有动那个服务 —— 它本来就活着。');
    return 0;
  }

  if (!existsSync(ENTRY)) {
    say(`起服失败：找不到 ${path.relative(PROJECT_ROOT, ENTRY).replace(/\\/g, '/')}`);
    return 1;
  }

  say(`8787 上没有活的服务，用项目自带方式拉起：node src/server/cli.js start --port ${port}`);
  say(`  数据目录：${dataDir}（COMMANDER_DATA_DIR 可改；端口被占时 cli.js 自己 +1，最多 +20）`);
  const child = spawn(process.execPath, [ENTRY, 'start', '--port', String(port)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, COMMANDER_DATA_DIR: dataDir },
    stdio: foreground ? 'inherit' : 'ignore',
    detached: !foreground,
    windowsHide: true,
  });
  if (!foreground && child.unref) child.unref();

  const ready = await waitReady(preferred, dataDir, 90_000);
  if (!ready) {
    say(`拉起超时（90s）。想看真实原因，前台再跑一次：node agent/serve.mjs --foreground`);
    say(`  注意：如果那个端口上已经有别的东西在回答 /api/health，CLI 会一路 +1 让出去，绝不会碰别人。`);
    if (child && !foreground) { try { child.kill(); } catch { /* 已经退了 */ } }
    return 1;
  }
  writeEndpoint(ready.base);
  say(`服务就绪（${ready.ms}ms）:${ready.base}`);
  say(`  已把实际地址写入 agent/.endpoint（MCP 桥优先读它）`);
  printEndpoints(ready.base);
  if (!foreground) {
    say('  进程在后台运行（pid 由操作系统管）。要停：前台模式用 Ctrl+C；后台模式关掉它自己的窗口。');
    say('  这个脚本不会去杀 8787 上的进程 —— 那可能是用户正在用的服务。');
  }
  return 0;
}

function writeEndpoint(base) {
  const file = path.join(__dirname, '.endpoint');
  try {
    writeFileSync(file, base, 'utf8');
  } catch (err) {
    say(`  （写 ${file} 失败：${err.message}；不影响调用，用 AGENT_BASE_URL 即可）`);
  }
}

function printEndpoints(base) {
  say('Agent 契约四个端点：');
  say(`  GET  ${base}/api/health`);
  say(`  GET  ${base}/api/agent/manifest`);
  say(`  GET  ${base}/api/agent/tools`);
  say(`  POST ${base}/api/agent/tool   body {"tool":"commander.projects.list","input":{}}`);
  if (process.argv.includes('--print-endpoint')) say(base);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 不硬 process.exit()：Windows 上那会撞 libuv 的 UV_HANDLE_CLOSING 断言（fetch 的 socket
  // 还在关闭队列里）。设 exitCode，让事件循环自己排空。
  main().then(
    (code) => { process.exitCode = code ?? 0; },
    (e) => {
      say(`起服异常：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}

export { main as serveOnce, urlFileFor };
