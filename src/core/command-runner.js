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

/**
 * git config keys whose VALUE git executes.
 *
 * One poisoned entry plus a later allowlisted read-only command is remote code execution:
 * `git config core.fsmonitor "<cmd>"` is a write, `git status` is a read, and both are on the
 * allowlist — two permitted invocations, no warning anywhere. So `git config` is not treated as
 * a read command any more, and these keys are refused whichever direction they appear in.
 * Patterns rather than exact names, because git's exec surface is namespaced
 * (`pager.blame`, `diff.foo.driver`, `alias.lo`, `credential.<url>.helper`).
 */
export const GIT_EXEC_CONFIG_PATTERNS = [
  { rx: /^core\.fsmonitor$/i, why: 'fsmonitor hook' },
  { rx: /^core\.pager$/i, why: 'pager is run through a shell' },
  { rx: /^core\.editor$/i, why: 'editor is run through a shell' },
  { rx: /^core\.sshcommand$/i, why: 'ssh command is run for every network op' },
  { rx: /^core\.hookspath$/i, why: 'redirects pre-commit / pre-push / post-* hooks' },
  { rx: /^sequence\.editor$/i, why: 'sequencer editor is run through a shell' },
  { rx: /^pager\./i, why: 'per-command pager is run through a shell' },
  { rx: /^alias\./i, why: 'an alias beginning with ! is a shell command' },
  { rx: /^grep\./i, why: 'grep.* plus --open-files-in-pager runs a pager' },
  { rx: /^credential\./i, why: 'credential helper is an arbitrary command' },
  { rx: /^(diff|merge)\..*\.(command|driver)$/i, why: 'external diff/merge driver is run by git' },
  { rx: /^difftool\..*\.cmd$/i, why: 'difftool command' },
  { rx: /^mergetool\..*\.cmd$/i, why: 'mergetool command' },
  { rx: /^remote\..*\.proxy$/i, why: 'remote proxy command is executed' },
  { rx: /^ext\./i, why: 'ext:: transport runs a command' },
  { rx: /^fetch\.unpacklimit$/i, why: 'not a read; kept out of the allowlist' },
];

/** Flags that make `git config` write (or open an editor) instead of read. */
const GIT_CONFIG_WRITE_FLAGS = [
  '--add', '--unset', '--unset-all', '--replace-all', '--remove-section', '--rename-section',
  '-f', '--file', '-e', '--edit', '--worktree',
];

/**
 * The single place that decides what a `git config …` invocation may do.
 *
 * Reads of a safe key are allowed; anything that writes a value, opens an editor, names an
 * exec-capable key, or dumps the whole config (which would echo other projects' secrets out of
 * `~/.gitconfig` into a record) is refused with a reason that says why.
 *
 * @param {string[]} args the arguments after the binary name, e.g. ['config','core.fsmonitor','!x']
 * @returns {{allowed:boolean, klass:string, reason:string, key:string|null, mode:string}}
 */
export function gitConfigVerdict(args = []) {
  const tokens = args.slice(1);
  const flags = [];
  const positionals = [];
  for (const t of tokens) {
    if (t === '--') continue;
    if (typeof t === 'string' && t.startsWith('-')) flags.push(t.split('=')[0]);
    else positionals.push(String(t));
  }

  const execHit = (key) => GIT_EXEC_CONFIG_PATTERNS.find((p) => p.rx.test(String(key).toLowerCase()));
  for (const key of positionals) {
    const hit = execHit(key);
    if (hit) {
      return {
        allowed: false, klass: COMMAND_CLASS.DANGEROUS, key, mode: 'read-or-write',
        reason: `git config 涉及可执行配置项「${key}」（${hit.why}）。这类键的值会被 git 用 shell 跑起来，读和写都拒绝。`,
      };
    }
  }

  if (/^(--list|-l|--get-regexp|--get-color|--get-colorbool)$/i.test(flags[0] || '')) {
    return {
      allowed: false, klass: COMMAND_CLASS.POTENTIALLY_MUTATING, key: null, mode: 'dump',
      reason: 'git config 不允许整份导出（--list/-l/--get-regexp）：那会把系统/全局配置里的地址与凭据带进分析记录。需要某个具体键时按键读。',
    };
  }

  const writeFlag = flags.find((f) => GIT_CONFIG_WRITE_FLAGS.includes(f.toLowerCase()));
  if (writeFlag) {
    return {
      allowed: false, klass: COMMAND_CLASS.DANGEROUS, key: positionals[0] || null, mode: 'write',
      reason: `git config ${writeFlag} 是写入。Commander 对工作区只读（ADR-009），而写 git 配置正是 core.fsmonitor / core.hooksPath 那类代码执行链的第一步。`,
    };
  }

  // `git config <key> [value…]` — two or more positionals is a write, whatever the caller meant.
  if (positionals.length >= 2) {
    return {
      allowed: false, klass: COMMAND_CLASS.DANGEROUS, key: positionals[0], mode: 'write',
      reason: `git config ${positionals[0]} <value> 是写入，一律拒绝。要读就只给键名（git config ${positionals[0]}）。`,
    };
  }

  if (positionals.length === 1) {
    const bare = positionals[0].toLowerCase();
    if (GIT_CONFIG_READABLE_KEYS.some((k) => bare === k || bare.startsWith(`${k}.`) || bare === k)) {
      return { allowed: true, klass: COMMAND_CLASS.READ_ONLY, key: positionals[0], mode: 'read', reason: '' };
    }
    return {
      allowed: false, klass: COMMAND_CLASS.POTENTIALLY_MUTATING, key: positionals[0], mode: 'read',
      reason: `git config 只允许读取白名单里的键（当前不含「${positionals[0]}」）。要新增可读音键请改 src/core/command-runner.js:GIT_CONFIG_READABLE_KEYS，并在评审里说明。`,
    };
  }

  return { allowed: false, klass: COMMAND_CLASS.POTENTIALLY_MUTATING, key: null, mode: 'noop', reason: 'git config 需要给出要读取的键名。' };
}

/**
 * Keys the analysis actually needs to read. An explicit list, because "any single-key read"
 * would happily read `credential.https://x.helper` straight into a build record.
 */
export const GIT_CONFIG_READABLE_KEYS = [
  'user.name', 'user.email', 'core.repositoryformatversion', 'core.bare', 'core.ignorecase',
  'core.filemode', 'core.symlinks', 'core.logallrefupdates', 'commit.gpgsign', 'init.defaultbranch',
];

/**
 * Package-manager script execution. `npm run <anything>` used to be stamped VALIDATION, which
 * made any script in a stranger's package.json look as trustworthy as `npm test`. Only names
 * that are shaped like validation get that class; everything else is reported honestly as
 * potentially mutating (and is never auto-run: see src/core/trust.js).
 */
const VALIDATION_SCRIPT_RX = /^(build|test|tests|lint|lint:.*|type-?check|tsc|verify|check|coverage|unit.*|integration.*|e2e.*|smoke.*|audit|ci)([:_-].*)?$/i;

export function packageScriptVerdict(bin, scriptName) {
  const validation = VALIDATION_SCRIPT_RX.test(String(scriptName || ''));
  return {
    klass: validation ? COMMAND_CLASS.VALIDATION : COMMAND_CLASS.POTENTIALLY_MUTATING,
    script: scriptName || null,
    validation,
  };
}

export const ALLOWLIST = [
  {
    bin: 'git',
    // `config` stays in the pattern so the rule still matches, but gitConfigVerdict() below is
    // what decides — an allowlisted prefix must never be mistaken for an allowlisted action.
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
 * The spawn options this module uses, as a table so both halves of the cancellation story are
 * testable on any machine.
 *
 * `detached` is the part that makes a POSIX group kill possible at all: it puts the child in its
 * own process group with pgid === child.pid, which is what `process.kill(-pid)` then addresses.
 * Without it there is no group, `process.kill(-pid)` throws ESRCH, and cancellation is a no-op
 * that returns false while the build keeps running behind a card that says 已取消.
 *
 * Windows is deliberately NOT detached: `detached:true` there hands the child a new console, and
 * the tree is walked with `taskkill /T /F` instead, which needs no group.
 */
export function spawnOptions({ cwd, env, platform = process.platform }) {
  return {
    cwd,
    shell: false,
    windowsHide: true,
    detached: platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

/**
 * Kill a command and everything it spawned.
 *
 * `child.kill()` only reaches the direct child. On Windows `npm run build` is a wrapper: the
 * thing that actually compiles and tests is its grandchild, so a cancelled scan used to leave
 * the real build running behind a card that said 已取消 — and the next scan would race it.
 * `taskkill /T /F` walks the tree. It is invoked here as internal teardown only: `taskkill`
 * stays on DANGEROUS_BINARIES, so no user-detected command can ever reach it.
 *
 * On POSIX the equivalent is the process group (`-pid`), which exists because every child this
 * module spawns is `detached` — see spawnOptions(). The bare pid is killed as well, because a
 * group that is missing for some reason (an already-reaped leader, a container without process
 * groups) must degrade into "kill what we can see", never into "did nothing and said true".
 *
 * @param {number|null|undefined} pid
 * @param {{force?:boolean, platform?:string, killProcess?:(pid:number, signal:string)=>boolean}} [opts]
 *        `platform`/`killProcess` are seams for tests; production calls use the defaults.
 * @returns {boolean} whether something was actually signalled
 */
export function killProcessTree(pid, { force = true, platform = process.platform, killProcess = null } = {}) {
  if (!pid) return false;
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  const kill = killProcess || ((target, sig) => { process.kill(target, sig); return true; });

  if (platform === 'win32') {
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

  let killed = false;
  try {
    kill(-pid, signal);
    killed = true;
  } catch {
    // No process group — the pre-fix shape. Do not stop here; the leader is still alive.
  }
  try {
    kill(pid, signal);
    killed = true;
  } catch {
    // Already gone: ESRCH here is success by another name, not a failure to report.
  }
  return killed;
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
  const argv = (args || []).map(String);
  const argLine = argv.join(' ');
  for (const p of DANGEROUS_ARG_PATTERNS) {
    if (p.rx.test(`${bin} ${argLine}`)) {
      return { allowed: false, klass: COMMAND_CLASS.DANGEROUS, reason: p.reason };
    }
  }
  if (DANGEROUS_BINARIES.includes(bin)) {
    return { allowed: false, klass: COMMAND_CLASS.DANGEROUS, reason: `binary "${bin}" is on the deny list` };
  }

  // git config is decided by one function, not by the allowlist prefix it happens to match.
  if (bin === 'git' && argv[0] && argv[0].toLowerCase() === 'config') {
    const verdict = gitConfigVerdict(argv);
    if (!verdict.allowed) {
      return { allowed: false, klass: verdict.klass, reason: verdict.reason, configKey: verdict.key, configMode: verdict.mode };
    }
    return { allowed: true, klass: verdict.klass, label: `git config read (${verdict.key})`, configKey: verdict.key, configMode: verdict.mode };
  }

  const rule = ALLOWLIST.find((r) => r.bin === bin && r.args.test(argLine));
  if (!rule) return { allowed: false, klass: COMMAND_CLASS.POTENTIALLY_MUTATING, reason: `no allowlist rule matches "${bin} ${argLine}"`.trim() };

  // `npm run <script>` / `pnpm run …` / `yarn run …`: honest class, never blanket VALIDATION.
  if ((bin === 'npm' || bin === 'pnpm' || bin === 'yarn') && /^(run|run-script|test)$/i.test(argv[0] || '')) {
    const script = bin === 'npm' && /^test$/i.test(argv[0]) ? 'test' : argv[1];
    const verdict = packageScriptVerdict(bin, script);
    return { allowed: true, klass: verdict.klass, label: rule.label, script: verdict.script, scriptValidation: verdict.validation };
  }

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
    let childPid = null;
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(exe, spawnArgs, spawnOptions({
          cwd,
          env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...(env || {}) },
        }));
        childPid = child.pid ?? null;
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
    gitConfig: {
      writes: 'refused (any key/value, --add/--unset/--replace-all/--remove-section/--rename-section/-f/--edit/--worktree)',
      dumps: 'refused (--list/-l/--get-regexp)',
      executableKeysRefused: GIT_EXEC_CONFIG_PATTERNS.map((p) => String(p.rx)),
      readableKeys: GIT_CONFIG_READABLE_KEYS,
      decisionFunction: 'gitConfigVerdict()',
    },
    packageScripts: {
      validationNames: String(VALIDATION_SCRIPT_RX),
      otherScripts: 'potentially_mutating —— 不再是 validation，且未经信任的工作区不会自动跑',
    },
    shellEnabled: false,
  };
}
