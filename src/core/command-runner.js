/**
 * CommandRunner — requirement #15 / ADR-003.
 *
 * The ONLY module in the codebase allowed to spawn child processes.
 * `tools/lint.js` fails the build if any other file imports child_process.
 *
 * Security model:
 *   - shell: false always (no shell injection surface)
 *   - every invocation must match an allowlist rule
 *   - dangerous binaries / argument patterns are rejected before spawn
 *   - hard timeout + output cap
 *   - every invocation is audited
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_CLASS } from '../domain/constants.js';
import { CommandBlockedError, TimeoutError } from '../domain/errors.js';
import { logger } from './logger.js';
import { summarizeOutput } from './util.js';

const log = logger.child('command');

/** Binaries that must never be executed, whatever the arguments. */
export const DANGEROUS_BINARIES = [
  'rm', 'rmdir', 'del', 'erase', 'deltree', 'format', 'mkfs', 'fdisk', 'diskpart',
  'dd', 'shred', 'shutdown', 'reboot', 'halt', 'poweroff', 'reg', 'regedit',
  'netsh', 'takeown', 'icacls', 'cacls', 'attrib', 'chmod', 'chown', 'chgrp',
  'sudo', 'su', 'runas', 'curl', 'wget', 'invoke-expression', 'iex', 'powershell',
  'cmd', 'sh', 'bash', 'zsh', 'cscript', 'wscript', 'mshta', 'rundll32',
  'schtasks', 'sc', 'net', 'taskkill', 'bcdedit', 'vssadmin', 'wbadmin',
];

/** Argument patterns that turn an otherwise safe binary into a destructive one. */
export const DANGEROUS_ARG_PATTERNS = [
  { rx: /\breset\s+--hard\b/i, reason: 'git reset --hard discards uncommitted work' },
  { rx: /\bclean\s+-[a-z]*[fd][a-z]*\b/i, reason: 'git clean deletes untracked files' },
  { rx: /\brebase\b/i, reason: 'git rebase rewrites history' },
  { rx: /\bpush\b.*(--force|-f)\b/i, reason: 'force push destroys remote history' },
  { rx: /\bcheckout\s+--\s/i, reason: 'git checkout -- discards local changes' },
  { rx: /\bfilter-branch\b/i, reason: 'git filter-branch rewrites history' },
  { rx: /\bbranch\s+-D\b/i, reason: 'branch -D force-deletes a branch' },
  { rx: /\bnpm\s+(install|i|add|uninstall|remove|link|publish)\b/i, reason: 'installing arbitrary packages is not permitted by default' },
  { rx: /\byarn\s+(add|remove)\b/i, reason: 'installing arbitrary packages is not permitted by default' },
  { rx: /\bpnpm\s+(add|remove|install)\b/i, reason: 'installing arbitrary packages is not permitted by default' },
  { rx: /\bpip\s+install\b/i, reason: 'installing packages is not permitted by default' },
  { rx: /\bnpm\s+(run\s+)?(deploy|release|publish)\b/i, reason: 'publishing/deploying is not permitted by default' },
  { rx: />\s*[^\s]+/i, reason: 'shell redirection indicates an inline script' },
  { rx: /[;&|]{1,2}/, reason: 'command chaining indicates an inline script' },
];

export const ALLOWLIST = [
  {
    bin: 'git',
    args: /^(status|diff|log|branch|rev-parse|show|ls-files|shortlog|describe|cat-file|symbolic-ref|config|stash\s+list|remote|tag|--version|-v)(\s|$)/i,
    klass: COMMAND_CLASS.READ_ONLY,
    label: 'git read-only inspection',
  },
  {
    // Git publishing — used ONLY by the explicit "上传到 GitHub" action, never by a scan.
    // These mutate the workspace's own .git and send data outbound, so they stay out of
    // AUTO_ALLOWED_SUMMARY: nothing here runs unattended.
    // The access token is passed through GIT_CONFIG_* env vars, never argv, so it cannot
    // appear in this record, in the process list, or in .git/config.
    bin: 'git',
    args: /^(init|add|commit|push|remote\s+(add|set-url|remove))(\s|$)/i,
    klass: COMMAND_CLASS.POTENTIALLY_MUTATING,
    label: 'git publish (user-initiated)',
  },
  {
    bin: 'npm',
    args: /^(test|run|run-script|--version|-v|ls|outdated)(\s|$)/i,
    klass: COMMAND_CLASS.VALIDATION,
    label: 'npm script execution',
  },
  { bin: 'pnpm', args: /^(test|run\s+[a-z0-9:_-]+|--version)(\s|$)/i, klass: COMMAND_CLASS.VALIDATION, label: 'pnpm script execution' },
  { bin: 'yarn', args: /^(test|run\s+[a-z0-9:_-]+|--version)(\s|$)/i, klass: COMMAND_CLASS.VALIDATION, label: 'yarn script execution' },
  {
    bin: 'npx',
    args: /^(vitest|playwright|jest|tsc|eslint|prettier)(\s|$)/i,
    klass: COMMAND_CLASS.VALIDATION,
    label: 'local test/typecheck tool',
  },
  { bin: 'node', args: /^(--version|-v)$/, klass: COMMAND_CLASS.READ_ONLY, label: 'version probe' },
  { bin: 'python', args: /^(--version|-V)$/, klass: COMMAND_CLASS.READ_ONLY, label: 'version probe' },
  { bin: 'python3', args: /^(--version|-V)$/, klass: COMMAND_CLASS.READ_ONLY, label: 'version probe' },
];

/** Commands the MVP is explicitly allowed to auto-run (requirement #15). */
export const AUTO_ALLOWED_SUMMARY = [
  'git status', 'git diff', 'git log', 'git branch',
  'npm run build', 'npm test', 'npm run test', 'npm run lint', 'npm run typecheck',
  'npx vitest', 'npx playwright test',
];

const EXECUTABLE_CACHE = new Map();

/**
 * Kill a command and everything it spawned.
 *
 * `child.kill()` only reaches the direct child. On Windows `npm run build` is a wrapper: the
 * thing that actually compiles and tests is its grandchild, so a cancelled scan used to leave
 * the real build running behind a card that said 已取消 — and the next scan would race it.
 * `taskkill /T /F` walks the tree. It is invoked here as internal teardown only: `taskkill`
 * stays on DANGEROUS_BINARIES, so no user-detected command can ever reach it.
 */
export function killProcessTree(pid, { force = true } = {}) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        windowsHide: true, stdio: 'ignore', shell: false,
      });
      killer.on('error', () => { /* fall back below is already done by the caller */ });
      return true;
    } catch {
      return false;
    }
  }
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); return true; } catch { return false; }
}

export function resolveExecutable(bin) {
  if (EXECUTABLE_CACHE.has(bin)) return EXECUTABLE_CACHE.get(bin);
  const win = process.platform === 'win32';
  const exts = win ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let found = null;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { found = candidate; break; }
      } catch { /* keep looking */ }
    }
    if (found) break;
  }
  EXECUTABLE_CACHE.set(bin, found);
  return found;
}

/**
 * Windows cannot spawn a `.cmd`/`.bat` shim without a shell (Node >= 18.20.2 hardening).
 * We refuse to enable `shell: true`, so instead we route package-manager shims through
 * their JavaScript entry point executed by the current Node binary (ADR-003).
 */
const JS_ENTRY_CACHE = new Map();

export function resolveJsEntry(bin) {
  if (JS_ENTRY_CACHE.has(bin)) return JS_ENTRY_CACHE.get(bin);
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', `${bin}-cli.js`),
    path.join(nodeDir, 'node_modules', 'npm', 'bin', `${bin}.js`),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', `${bin}-cli.js`),
    path.join(nodeDir, 'node_modules', 'corepack', 'dist', `${bin}.js`),
    path.join(nodeDir, `${bin}.cjs`),
    path.join(nodeDir, `${bin}.js`),
    path.join(path.dirname(nodeDir), 'lib', 'node_modules', 'corepack', 'dist', `${bin}.js`),
  ];
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
    candidates.push('C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js');
    candidates.push('C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\yarn.js');
  }
  const found = candidates.find((c) => {
    try { return fs.existsSync(c) && fs.statSync(c).isFile(); } catch { return false; }
  }) || null;
  JS_ENTRY_CACHE.set(bin, found);
  return found;
}

/**
 * Translate a logical command into a spawnable invocation without ever enabling a shell.
 * @returns {{exe:string,args:string[],shimmed:boolean}|{error:string}}
 */
export function resolveInvocation(bin, args) {
  const exe = resolveExecutable(bin);
  if (!exe) return { error: `executable not found on PATH: ${bin}` };
  const needsShim = /\.(cmd|bat)$/i.test(exe);
  if (!needsShim) return { exe, args, shimmed: false };
  const entry = resolveJsEntry(bin);
  if (!entry) {
    return { error: `"${bin}" is a Windows batch shim; no JavaScript entry point was found to run it safely without a shell` };
  }
  return { exe: process.execPath, args: [entry, ...args], shimmed: true, logicalBin: bin };
}


export function classifyCommand(command, args = []) {  const bin = path.basename(String(command)).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const argLine = args.join(' ');
  for (const p of DANGEROUS_ARG_PATTERNS) {
    if (p.rx.test(`${bin} ${argLine}`)) {
      return { allowed: false, klass: COMMAND_CLASS.DANGEROUS, reason: p.reason };
    }
  }
  if (DANGEROUS_BINARIES.includes(bin)) {
    return { allowed: false, klass: COMMAND_CLASS.DANGEROUS, reason: `binary "${bin}" is on the deny list` };
  }
  const rule = ALLOWLIST.find((r) => r.bin === bin && r.args.test(argLine));
  if (!rule) return { allowed: false, klass: COMMAND_CLASS.POTENTIALLY_MUTATING, reason: `no allowlist rule matches "${bin} ${argLine}"`.trim() };
  return { allowed: true, klass: rule.klass, label: rule.label };
}

export class CommandRunner {
  constructor({ defaultTimeoutMs = 180000, maxOutputBytes = 512 * 1024, dryRun = false } = {}) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.dryRun = dryRun;
    this.history = [];
  }

  /**
   * @param {{command:string,args?:string[],cwd:string,timeoutMs?:number,purpose?:string,detachedSafe?:boolean,signal?:AbortSignal}} req
   *
   * `signal` is what makes cancellation real: an aborted job kills its child process instead
   * of merely forgetting about it. Without this, cancelling a scan leaves the project's own
   * build/test running to completion — which is the opposite of what the button says.
   */
  async run({ command, args = [], cwd, timeoutMs, purpose = 'unspecified', env = null, signal = null }) {
    const started = Date.now();
    const verdict = classifyCommand(command, args);
    const base = {
      command: `${command} ${args.join(' ')}`.trim(),
      cwd,
      purpose,
      requestedAt: new Date().toISOString(),
    };

    if (signal?.aborted) {
      const record = { ...base, allowed: true, blocked: false, klass: verdict.klass, exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '任务已取消，未启动该命令。', durationMs: 0, truncated: false, cancelled: true };
      this.#audit(record);
      return record;
    }

    if (!verdict.allowed) {
      const record = {
        ...base,
        allowed: false,
        blocked: true,
        blockReason: verdict.reason,
        klass: verdict.klass,
        exitCode: 127,
        signal: null,
        stdout: '',
        stderr: verdict.reason,
        durationMs: 0,
        truncated: false,
      };
      this.#audit(record);
      log.warn('blocked', { command: record.command, reason: verdict.reason, klass: verdict.klass });
      return record;
    }

    if (!fs.existsSync(cwd)) {
      const record = { ...base, allowed: true, blocked: false, klass: verdict.klass, exitCode: -1, signal: null, stdout: '', stderr: `cwd does not exist: ${cwd}`, durationMs: 0, truncated: false };
      this.#audit(record);
      return record;
    }

    const rawBin = path.basename(command).replace(/\.(exe|cmd|bat)$/i, '');
    const invocation = resolveInvocation(rawBin, args);
    if (invocation.error) {
      const record = { ...base, allowed: true, blocked: false, klass: verdict.klass, exitCode: -2, signal: null, stdout: '', stderr: invocation.error, durationMs: 0, truncated: false, executableMissing: true };
      this.#audit(record);
      log.warn('executable_missing', { command, reason: invocation.error });
      return record;
    }
    const { exe, args: spawnArgs, shimmed } = invocation;

    if (this.dryRun) {
      const record = { ...base, allowed: true, blocked: false, klass: verdict.klass, exitCode: 0, signal: null, stdout: '(dry-run)', stderr: '', durationMs: 0, truncated: false, dryRun: true };
      this.#audit(record);
      return record;
    }

    const limit = timeoutMs || this.defaultTimeoutMs;
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(exe, spawnArgs, {
          cwd,
          shell: false,
          windowsHide: true,
          env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...(env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ exitCode: -3, signal: null, stdout: '', stderr: `spawn failed: ${err.message}`, timedOut: false });
        return;
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;
      const cap = this.maxOutputBytes;

      const onData = (chunk, target) => {
        if (truncated) return;
        const text = chunk.toString('utf8');
        if (target === 'out') {
          stdout += text;
          if (stdout.length > cap) { stdout = stdout.slice(0, cap); truncated = true; }
        } else {
          stderr += text;
          if (stderr.length > cap) { stderr = stderr.slice(0, cap); truncated = true; }
        }
      };

      child.stdout.on('data', (c) => onData(c, 'out'));
      child.stderr.on('data', (c) => onData(c, 'err'));

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcessTree(child.pid);
        resolve({ exitCode: null, signal: 'SIGKILL', stdout, stderr, truncated, timedOut: true });
      }, limit);

      // Cancellation must reach the child process tree, not just the promise. SIGKILL because a
      // build/test tree spawned by npm keeps running after a polite SIGTERM on Windows.
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killProcessTree(child.pid);
        resolve({ exitCode: null, signal: 'SIGKILL', stdout, stderr, truncated, timedOut: false, cancelled: true });
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: -4, signal: null, stdout, stderr: stderr + `\n${err.message}`, truncated, timedOut: false });
      });

      child.on('close', (code, signal2) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ exitCode: code, signal: signal2, stdout, stderr, truncated, timedOut: false });
      });

      this.history.push({ pid: child.pid, command: base.command, cwd, startedAt: new Date().toISOString() });
    });

    const record = {
      ...base,
      allowed: true,
      blocked: false,
      klass: verdict.klass,
      label: verdict.label,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutSummary: summarizeOutput(result.stdout, 1500),
      stderrSummary: summarizeOutput(result.stderr, 1500),
      durationMs: Date.now() - started,
      truncated: !!result.truncated,
      timedOut: !!result.timedOut,
      cancelled: !!result.cancelled,
      shimmed: !!shimmed,
      ok: result.exitCode === 0 && !result.timedOut,
    };
    this.#audit(record);
    log.info('run', {
      command: record.command,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      klass: record.klass,
      timedOut: record.timedOut,
    });
    return record;
  }

  /** Convenience wrapper that throws on a blocked command (callers that must not proceed). */
  async runOrThrow(req) {
    const res = await this.run(req);
    if (res.blocked) throw new CommandBlockedError(`command blocked: ${res.command}`, res.blockReason);
    if (res.timedOut) throw new TimeoutError(`command timed out after ${res.durationMs}ms: ${res.command}`);
    return res;
  }

  #audit(record) {
    this.history.push({
      at: new Date().toISOString(),
      command: record.command,
      cwd: record.cwd,
      purpose: record.purpose,
      klass: record.klass,
      allowed: record.allowed,
      blocked: !!record.blocked,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
    });
    if (this.history.length > 500) this.history.shift();
  }

  recentRuns(n = 20) { return this.history.slice(-n); }
}

export function describeSecurityModel() {
  return {
    autoAllowed: AUTO_ALLOWED_SUMMARY,
    alwaysBlocked: DANGEROUS_BINARIES,
    argumentPatternsBlocked: DANGEROUS_ARG_PATTERNS.map((p) => ({ pattern: String(p.rx), reason: p.reason })),
    shellEnabled: false,
  };
}
