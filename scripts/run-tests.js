#!/usr/bin/env node
/**
 * Cross-platform test runner.
 * `node --test <dir>` is not reliable across Node versions/platforms, so the file list is
 * resolved here and passed explicitly. Uses async spawn (spawnSync returns EBUSY in sandbox).
 *
 * Why there is no `--test-force-exit` here (and none may be added back):
 * every `node --test` file runs in its own process, and after its last assertion that process
 * still has sockets in the libuv *close queue* — a keep-alive connection torn down by
 * `server.close()`, the pipes of a spawned child, a raw `net.Socket`. Forcing `process.exit()`
 * at that moment hits libuv's own assertion and aborts the whole process on Windows:
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 * An abort is not a failed assertion: the runner can only report the *file* as failed, so a
 * green suite (all 24 checks in tests/integration/local-guard.test.js pass) is printed next to
 * `✖ tests\integration\local-guard.test.js` and the red says nothing about behaviour. The same
 * trap is documented upstream in trendscope's `agent/serve.mjs` ("不硬 process.exit()…否则
 * Windows 上会撞 libuv 的 UV_HANDLE_CLOSING 断言").
 * So the processes are allowed to drain their own event loops, which they demonstrably do
 * (full suite exits by itself). A test that really hangs is bounded by `--test-timeout`, and a
 * process that leaks a persistent handle is bounded by the watchdog below, which kills the run
 * and says so instead of pretending it passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { collect(p, out); continue; }
    if (/\.test\.js$/.test(entry.name)) out.push(p);
  }
  return out.sort();
}

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--')) || '--all';
const dirs = mode === '--unit' ? ['tests/unit']
  : mode === '--integration' ? ['tests/integration']
    : ['tests/unit', 'tests/integration'];

const files = dirs.flatMap((d) => collect(path.join(ROOT, d)));
if (!files.length) {
  process.stderr.write(`No test files found in: ${dirs.join(', ')}\n`);
  process.exit(1);
}

// 5 minutes for a single test that declares no timeout of its own. The slow ones (real builds,
// demo seeding) already state their own budget in the test file, which takes precedence.
const PER_TEST_TIMEOUT_MS = Number(process.env.APC_TEST_TIMEOUT_MS || 300000);
// Whole-run watchdog. Replaces what --test-force-exit used to paper over: a run that stops
// making progress because a process is waiting on a handle nobody closes must FAIL LOUDLY.
const RUN_DEADLINE_MS = Number(process.env.APC_RUN_DEADLINE_MS || 30 * 60 * 1000);

const runnerArgs = [
  '--test',
  `--test-timeout=${PER_TEST_TIMEOUT_MS}`,
  '--test-reporter=spec',
  ...files.map((f) => path.relative(ROOT, f)),
];
const child = spawn(process.execPath, runnerArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: '--no-warnings=ExperimentalWarning' },
});

let watchdog = null;
let killedByWatchdog = false;
if (Number.isFinite(RUN_DEADLINE_MS) && RUN_DEADLINE_MS > 0) {
  watchdog = setTimeout(() => {
    killedByWatchdog = true;
    process.stderr.write(`\n[test runner] no exit within ${Math.round(RUN_DEADLINE_MS / 60000)} minute(s) — killing the run. `
      + 'A test process is waiting on a handle it never closes (this is what --test-force-exit used to hide). '
      + 'Find the file that did not print a summary and close its server / socket / child there.\n');
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, RUN_DEADLINE_MS);
  if (watchdog.unref) watchdog.unref();
}

child.on('close', (code) => {
  if (watchdog) clearTimeout(watchdog);
  if (killedByWatchdog) process.exit(1);
  process.exit(code === null ? 1 : code);
});
