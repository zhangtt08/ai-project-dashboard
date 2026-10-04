/**
 * Security integration tests — requirement #11 / #15 / ADR-004 / ADR-009.
 * Proves, against a real fixture workspace, that Commander:
 *   1. never reads sensitive file contents (they never appear in the DB, logs or AI requests)
 *   2. never writes to a managed workspace (file mtimes unchanged after a full scan)
 *   3. refuses destructive commands
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../../src/core/app.js';
import { createFixtureProject } from '../../src/demo/fixture-factory.js';
import { logger } from '../../src/core/logger.js';
import { makeTempDir } from '../helpers/tmp.js';

const SECRET_MARKERS = [
  'sk_live_THIS_MUST_NEVER_BE_READ',
  'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'postgres://user:pass@localhost/shop',
];

let app;
let dir;
let projectId;
let mtimesBefore;

before(async () => {
  const root = makeTempDir('apc-sec-');
  app = new App({ dataDir: path.join(root, 'data'), logLevel: 'error' });
  dir = path.join(root, 'target-workspace');
  createFixtureProject(dir, 'healthy');
  // trusted: this fixture's own build/test output is part of what is searched for leaks below
  // ("a secret must not reach the database even through command stdout"), so the scan has to be
  // allowed to run it. The fixture directory is written by this test — see src/core/trust.js for
  // where trust may come from; the refusal path is covered in command-allowlist.test.js.
  const project = app.addProject({ workspacePath: dir, name: 'Security target', trusted: true, trustedSource: 'test' });
  projectId = project.id;

  mtimesBefore = snapshotMtimes(dir);
  await app.orchestrator.fullScan(projectId, { runCommands: true, suites: ['unit', 'e2e'] });
});

after(() => { try { app.close(); } catch { /* noop */ } });

function snapshotMtimes(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).replace(/\\/g, '/')] = fs.statSync(p).mtimeMs;
    }
  };
  walk(root);
  return out;
}

function dumpDatabase() {
  const tables = ['projects', 'tasks', 'risks', 'issues', 'project_events', 'specifications',
    'acceptance_criteria', 'project_memory', 'prompts', 'evidence_refs', 'health_results',
    'project_snapshots', 'git_snapshots', 'build_results', 'test_runs', 'analysis_jobs', 'app_settings'];
  const parts = [];
  for (const t of tables) {
    try {
      for (const row of app.repo.list(t, t === 'projects' ? { id: projectId } : { project_id: projectId })) {
        parts.push(JSON.stringify(row));
      }
    } catch { /* optional table */ }
  }
  return parts.join('\n');
}

describe('sensitive file contents never leave the workspace', () => {
  test('the database contains no secret material', () => {
    const dump = dumpDatabase();
    for (const marker of SECRET_MARKERS) {
      assert.ok(!dump.includes(marker), `secret leaked into the database: ${marker.slice(0, 24)}…`);
    }
  });

  test('the log stream contains no secret material', () => {
    const logs = logger.recent(500).map((r) => JSON.stringify(r)).join('\n');
    for (const marker of SECRET_MARKERS) {
      assert.ok(!logs.includes(marker), 'secret leaked into logs');
    }
  });

  test('sensitive files are reported as present, with metadata only', () => {
    const meta = app.getProject(projectId).metadata.metadata;
    assert.equal(meta.sensitiveCount, 2);
    assert.deepEqual(meta.sensitiveFiles.map((f) => f.path).sort(), ['.env', 'src/config/secrets.json']);
    for (const f of meta.sensitiveFiles) {
      assert.deepEqual(Object.keys(f).sort(), ['path', 'rule', 'sizeBytes'], 'only metadata may be recorded');
      assert.ok(!JSON.stringify(f).includes('sk_live'));
    }
  });

  test('AI enrichment requests never include secret material', async () => {
    const captured = [];
    const original = app.providerRegistry.active().generate.bind(app.providerRegistry.active());
    const provider = app.providerRegistry.active();
    provider.generate = async (args) => { captured.push(JSON.stringify(args)); return original(args); };
    try {
      await app.aiService.summarize(projectId);
      await app.aiService.enrichRisks(projectId);
    } finally {
      provider.generate = original;
    }
    const sent = captured.join('\n');
    for (const marker of SECRET_MARKERS) {
      assert.ok(!sent.includes(marker), 'secret leaked into an AI request');
    }
  });

  test('the scanner read-audit shows zero reads of sensitive paths', () => {
    const meta = app.getProject(projectId).metadata.metadata;
    assert.equal(meta.readAudit.skippedSensitive >= 2, true);
  });
});

describe('a managed workspace is read-only', () => {
  test('a full scan does not modify a single file', async () => {
    const after = snapshotMtimes(dir);
    const changed = Object.keys(after).filter((k) => after[k] !== mtimesBefore[k]);
    assert.deepEqual(changed, [], `these files were modified by Commander: ${changed.join(', ')}`);
  });

  test('no write/delete/rename API exists on the workspace-facing modules', async () => {
    const fsSafe = await import('../../src/core/fs-safe.js');
    const exports1 = Object.keys(fsSafe);
    for (const banned of ['writeFile', 'writeFileSync', 'rm', 'rmSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'copyFile', 'mkdir', 'mkdirSync', 'appendFile', 'createWriteStream']) {
      assert.ok(!exports1.includes(banned), `fs-safe must not export ${banned}`);
    }
    // The CommandRunner deny list is enforced at the classification layer.
    const { classifyCommand } = await import('../../src/core/command-runner.js');
    for (const [bin, args] of [['rm', ['-rf', '.']], ['git', ['reset', '--hard']], ['git', ['clean', '-fd']], ['npm', ['install', 'x']]]) {
      assert.equal(classifyCommand(bin, args).allowed, false, `${bin} ${args.join(' ')} must be blocked`);
    }
  });

  test('Commander keeps its writes inside its own data directory', () => {
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else files.push(p);
      }
    };
    walk(app.dataDir);
    assert.ok(files.length > 0);
    assert.ok(files.every((f) => !f.startsWith(path.resolve(dir))), 'no Commander artifact may live inside a managed workspace');
  });
});

describe('degraded environments are handled honestly', () => {
  test('a workspace that is not a git repository reports it instead of failing', async () => {
    const root2 = makeTempDir('apc-nogit-');
    const dir2 = path.join(root2, 'nogit');
    createFixtureProject(dir2, 'not_a_repo');
    const project = app.addProject({ workspacePath: dir2, name: 'No git' });
    const out = await app.orchestrator.fullScan(project.id, { runCommands: false, suites: [] });
    assert.equal(out.git.isRepository, false);
    assert.match(out.git.error, /not a git repository/);
    assert.equal(out.git.gitAvailable, true);
    const events = app.events.timeline(project.id);
    assert.equal(events.some((e) => e.level === 'error' && /scan_failed/.test(e.type)), false);
  });

  test('an empty directory scans cleanly and reports unknown health', async () => {
    const dir3 = makeTempDir('apc-empty-');
    const project = app.addProject({ workspacePath: dir3, name: 'Empty' });
    const out = await app.orchestrator.fullScan(project.id, { runCommands: false, suites: [] });
    assert.equal(out.metadata.fileCount, 0);
    assert.equal(out.health.status, 'unknown');
    assert.equal(out.progress.percent, null);
  });
});
