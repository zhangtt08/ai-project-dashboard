/**
 * Command allowlist + workspace trust, tested against real subprocesses.
 *
 * Two things are proven here, and both need a marker file to be worth anything:
 *
 *  1. `git config` used to match the READ_ONLY allowlist rule, so poisoning a repository was two
 *     allowed invocations: `git config core.fsmonitor "<cmd>"` (write) plus `git status` (read).
 *     `core.hooksPath` + `git commit` is the same chain, and on this machine (git 2.55.0.windows.2)
 *     the hooksPath form is the one that demonstrably EXECUTES — so that one is used as the
 *     positive control: it creates the marker when the write is allowed and must not create it
 *     once the write is refused. Saying "the chain is refused" without showing the chain can run
 *     would be a vacuous assertion.
 *  2. A folder added from outside must not have its package.json scripts executed until a person
 *     trusts it. Untrusted → no marker; trusted → marker. Both directions, same fixture.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { App } from '../../src/core/app.js';
import { CommandRunner, classifyCommand, gitConfigVerdict, packageScriptVerdict } from '../../src/core/command-runner.js';
import { commandsAllowedFor } from '../../src/core/trust.js';
import { COMMAND_CLASS } from '../../src/domain/constants.js';
import { toPosix } from '../../src/core/util.js';
import { makeTempDir } from '../helpers/tmp.js';

const ROOT = makeTempDir('apc-allow-');
const runner = new CommandRunner({ defaultTimeoutMs: 60000 });

/** `git config <key> <value>` was the write; these are the shapes it comes in. */
const WRITE_CASES = [
  ['config', 'core.fsmonitor', '!node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"'],
  ['config', 'user.name', 'Someone Else'],
  ['config', '--global', 'core.pager', 'less'],
  ['config', '--add', 'remote.origin.url', 'https://example.invalid/x'],
  ['config', '--unset', 'core.editor'],
  ['config', '--replace-all', 'core.hooksPath', '/tmp/evil'],
  ['config', '-f', '.git/config', 'alias.lo', '!id'],
  ['config', '--edit'],
  ['config', 'core.fsmonitor'],
  ['config', 'core.hooksPath'],
  ['config', 'alias.x'],
  ['config', 'credential.https://example.invalid.helper', '!sh -c id'],
  ['config', 'sequence.editor', 'vi'],
  ['config', 'grep.lineNumber', 'true'],
  ['config', 'pager.blame', 'cat'],
  ['config', 'diff.foo.command', 'cp "$@" $TARGET'],
  ['config', 'remote.origin.proxy', 'nc proxy 8080'],
  ['config', 'ext.sh.transport', 'curl'],
];

const SAFE_READ_CASES = ['user.name', 'user.email', 'commit.gpgsign', 'core.ignorecase', 'init.defaultbranch'];

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

function makeRepo(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@commander.local');
  git(dir, 'config', 'user.name', 'Commander Test');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'baseline');
  return dir;
}

/**
 * A hook directory holding a real pre-commit hook that writes `marker` inside `dir`.
 * Returned as the absolute path git for Windows needs; the JS string inside the hook is
 * written with forward slashes so it survives the bundled sh unchanged.
 */
function plantHooks(dir, markerName) {
  const marker = `${toPosix(dir)}/${markerName}`.replace(/\\/g, '/');
  const hooks = `${toPosix(dir)}/evil-hooks`.replace(/\\/g, '/');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(
    path.join(hooks, 'pre-commit'),
    `#!/bin/sh\nnode -e "require('fs').writeFileSync('${marker}','executed')"\nexit 0\n`,
    'utf8',
  );
  try { fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755); } catch { /* windows: git runs it via sh anyway */ }
  return { hooks, marker };
}

describe('git config is decided by one function', () => {
  test('every writing or exec-capable shape is refused, with a reason that names the key', () => {
    for (const args of WRITE_CASES) {
      const verdict = gitConfigVerdict(args);
      assert.equal(verdict.allowed, false, `git ${args.join(' ')} must not be allowed`);
      assert.ok(verdict.reason.length > 10, `git ${args.join(' ')} needs an explainable refusal`);
      assert.equal(classifyCommand('git', args).allowed, false, `classifyCommand must refuse git ${args.join(' ')}`);
    }
  });

  test('reads of the handful of keys the analysis needs still work', () => {
    for (const key of SAFE_READ_CASES) {
      const verdict = gitConfigVerdict(['config', key]);
      assert.equal(verdict.allowed, true, `git config ${key} is a read of a safe key`);
      assert.equal(verdict.klass, COMMAND_CLASS.READ_ONLY);
    }
  });

  test('reading a key that is not on the read allowlist is refused, not silently trusted', () => {
    const verdict = gitConfigVerdict(['config', 'remote.origin.url']);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /GIT_CONFIG_READABLE_KEYS/);
  });

  test('the whole-config dump is refused, because it would carry other repos’ settings into a record', () => {
    for (const args of [['config', '--list'], ['config', '-l'], ['config', '--get-regexp', '.*']]) {
      assert.equal(gitConfigVerdict(args).allowed, false, `git ${args.join(' ')} must not be allowed`);
    }
  });
});

describe('package.json script classification is honest', () => {
  test('validation-shaped names keep the VALIDATION class', () => {
    for (const script of ['build', 'test', 'lint', 'typecheck', 'verify', 'test:unit', 'e2e']) {
      const v = packageScriptVerdict('npm', script);
      assert.equal(v.validation, true, `${script} should count as validation`);
      assert.equal(classifyCommand('npm', ['run', script]).klass, COMMAND_CLASS.VALIDATION);
    }
  });

  test('an arbitrary script is no longer stamped VALIDATION', () => {
    for (const script of ['exfiltrate', 'postinstall-backdoor', 'harvest-keys']) {
      const res = classifyCommand('npm', ['run', script]);
      assert.equal(res.allowed, true, `${script} may still be pinned by a person`);
      assert.equal(res.klass, COMMAND_CLASS.POTENTIALLY_MUTATING, `${script} must not be labelled validation`);
      assert.equal(res.scriptValidation, false);
    }
  });

  test('publishing and deploying stay refused by the deny patterns, not by the class', () => {
    for (const script of ['deploy', 'publish']) {
      const res = classifyCommand('npm', ['run', script]);
      assert.equal(res.allowed, false, `npm run ${script} must be refused`);
      assert.equal(res.klass, COMMAND_CLASS.DANGEROUS);
    }
  });
});

describe('the git-config → read-only-command chain cannot execute anything', () => {
  let repo;
  let marker;

  before(() => {
    repo = makeRepo('fsmonitor-chain');
    marker = `${toPosix(repo)}/MARKER.txt`.replace(/\\/g, '/');
  });

  test('step 1: the write is blocked before the process is spawned', async () => {
    const res = await runner.run({
      command: 'git',
      args: ['config', 'core.fsmonitor', `!node -e "require('fs').writeFileSync('${marker}','executed')"`],
      cwd: repo,
      purpose: 'attempted fsmonitor poisoning',
    });
    assert.equal(res.blocked, true);
    assert.equal(res.allowed, false);
    assert.equal(res.klass, COMMAND_CLASS.DANGEROUS);
    assert.match(res.blockReason, /fsmonitor/);
    assert.equal(res.exitCode, 127, 'a blocked command never runs, and the record says so');
    assert.equal(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8').includes('fsmonitor'), false,
      'the poisoning must not have reached .git/config at all');
  });

  test('step 2: the allowlisted read-only command still works, and nothing executed', async () => {
    const res = await runner.run({ command: 'git', args: ['status'], cwd: repo, purpose: 'read-only inspection' });
    assert.equal(res.blocked, false);
    assert.equal(res.exitCode, 0);
    assert.ok(!fs.existsSync(marker), 'the fsmonitor chain created a marker file');
  });

  test('core.hooksPath + git commit: refused', async () => {
    const dir = makeRepo('hookspath-chain-refused');
    const { hooks, marker: m } = plantHooks(dir, 'MARKER-hooks-refused.txt');
    const write = await runner.run({ command: 'git', args: ['config', 'core.hooksPath', hooks], cwd: dir, purpose: 'attempted hook redirect' });
    assert.equal(write.blocked, true);
    assert.match(write.blockReason, /hooksPath/);
    const commit = await runner.run({ command: 'git', args: ['commit', '-q', '--allow-empty', '-m', 'chained'], cwd: dir, purpose: 'the allowlisted second step' });
    assert.equal(commit.blocked, false, 'git commit itself stays allowed — the point is that the poison never landed');
    assert.ok(!fs.existsSync(m), 'the hook ran even though the config write was refused');
  });

  test('POSITIVE CONTROL: the same chain does execute when the write is not refused', async () => {
    // Written with a raw git (outside CommandRunner) exactly to show this machine runs the hook.
    // Without this, "nothing executed" above could just mean "hooks never work on git for
    // Windows". Verified by hand before writing this test: the marker appears.
    const dir = makeRepo('hookspath-chain-control');
    const { hooks, marker: m } = plantHooks(dir, 'MARKER-hooks-control.txt');
    git(dir, 'config', 'core.hooksPath', hooks);
    assert.equal(git(dir, 'config', '--get', 'core.hooksPath').trim(), hooks, 'the raw write must have landed');
    const commit = await runner.run({ command: 'git', args: ['commit', '-q', '--allow-empty', '-m', 'control'], cwd: dir, purpose: 'allowlisted command, poisoned config' });
    assert.equal(commit.blocked, false);
    assert.ok(fs.existsSync(m), 'CONTROL FAILED: git did not execute the planted hook on this machine, so the "chain refused" tests below prove nothing — re-check before trusting them');
    fs.rmSync(m, { force: true });
  });
});

describe('a folder added from outside does not run its own scripts', () => {
  let app;
  let projectId;
  let projectDir;
  let marker;

  before(() => {
    app = new App({ dataDir: path.join(ROOT, 'data-trust'), logLevel: 'error' });
    projectDir = path.join(ROOT, 'stranger-project');
    fs.mkdirSync(projectDir, { recursive: true });
    marker = `${toPosix(projectDir)}/SCRIPT-EXECUTED.txt`.replace(/\\/g, '/');
    fs.writeFileSync(path.join(projectDir, 'write-marker.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'stranger',
      version: '1.0.0',
      scripts: { build: 'node write-marker.js', test: 'node write-marker.js' },
    }, null, 2));
    fs.writeFileSync(path.join(projectDir, 'index.js'), 'export default 1;\n');
    const project = app.addProject({ workspacePath: projectDir, name: 'Stranger Project' });
    projectId = project.id;
  });

  after(() => { try { app.close(); } catch { /* noop */ } });

  test('the import itself lands untrusted', () => {
    const row = app.repo.get('projects', projectId);
    assert.equal(commandsAllowedFor(row).trusted, false);
    assert.equal(commandsAllowedFor(row).allowed, false);
    assert.match(commandsAllowedFor(row).reason, /可信/);
    // Requesting commands does not buy them: `runCommands:true` is a request, trust is the gate.
    assert.equal(commandsAllowedFor(row, true).allowed, false);
  });

  test('a full scan of the untrusted folder never invokes its package.json scripts', { timeout: 240000 }, async () => {
    const out = await app.orchestrator.fullScan(projectId, { runCommands: true, suites: ['unit'] });
    assert.ok(!fs.existsSync(marker), 'an untrusted folder’s build script was executed');
    assert.equal(out.commandsSkipped.code, 'workspace_untrusted');
    assert.match(out.commandsSkipped.reason, /package\.json/);
    // No build/test verdict exists at all — as opposed to a fake "pass" or a "fail" that would
    // blame the project for something Commander declined to run.
    assert.equal(out.build.build, null);
    assert.equal(out.tests.unit, null);
    // And the rest of the analysis is still real — trust gates execution, not reading.
    assert.equal(out.metadata.ok, true);
    assert.ok(out.metadata.fileCount >= 3);
  });

  test('trusting the folder is what turns execution on', { timeout: 240000 }, async () => {
    const { project, trust } = app.setProjectTrust(projectId, true);
    assert.equal(trust.trusted, true);
    assert.equal(trust.source, 'user');
    assert.equal(commandsAllowedFor(project).allowed, true);
    const out = await app.orchestrator.fullScan(projectId, { runCommands: true, suites: ['unit'] });
    assert.equal(out.commandsSkipped, null);
    assert.ok(fs.existsSync(marker), 'trusting the project did not actually run its build script');
    assert.equal(out.build.build.status, 'pass');
    fs.rmSync(marker, { force: true });
  });

  test('revoking trust stops it again, and the API surface agrees with the engine', { timeout: 240000 }, async () => {
    app.setProjectTrust(projectId, false);
    assert.equal(commandsAllowedFor(app.repo.get('projects', projectId)).allowed, false);
    const out = await app.orchestrator.fullScan(projectId, { runCommands: true, suites: ['unit'] });
    assert.ok(!fs.existsSync(marker), 'execution continued after trust was revoked');
    assert.equal(out.commandsSkipped.code, 'workspace_untrusted');
  });

  test('the deny list is applied by the runner, not only by the classifier', async () => {
    const blocked = await runner.run({ command: 'git', args: ['config', 'core.fsmonitor', 'true'], cwd: projectDir, purpose: 'direct runner check' });
    assert.equal(blocked.blocked, true);
    const missing = await runner.run({ command: 'git', args: ['config'], cwd: projectDir, purpose: 'no key at all' });
    assert.equal(missing.blocked, true);
  });
});
