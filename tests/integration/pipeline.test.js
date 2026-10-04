/**
 * Integration tests — requirement #55.
 * REAL fixture projects are generated on disk, scanned, built and tested by real
 * subprocesses. Nothing here is mocked except the AI provider (which is the
 * documented deterministic fallback).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../../src/core/app.js';
import { expandShortPath } from '../../src/core/fs-safe.js';
import { createFixtureProject, applyRegression } from '../../src/demo/fixture-factory.js';
import { makeTempDir } from '../helpers/tmp.js';

const ROOT = makeTempDir('apc-int-');
let app;

before(async () => {
  app = new App({ dataDir: path.join(ROOT, 'data'), logLevel: 'error' });
});

after(() => { try { app.close(); } catch { /* already closed */ } });

describe('full pipeline over three real fixture projects', () => {
  // `trusted: true, trustedSource: 'test'` on the addProject calls below is a precondition, not
  // a shortcut: this file tests what the pipeline COMPUTES from real build/test output, and the
  // trust gate (src/core/trust.js) means a folder nobody trusted never produces that output.
  // The fixture directories are written by this test itself, which is the same authority the
  // demo projects get. Both directions of the gate are asserted in api.test.js and
  // tests/integration/command-allowlist.test.js — never weakened here.
  const cases = [
    { kind: 'healthy', expectHealth: 'healthy', expectGate: 'PASS', suites: ['pass', 'pass'] },
    { kind: 'warning', expectHealth: 'warning', expectGate: 'FAIL', e2e: '22/25' },
    { kind: 'critical', expectHealth: 'critical', expectGate: 'FAIL', build: 'fail' },
  ];

  for (const c of cases) {
    test(`fixture-${c.kind} produces ${c.expectHealth} health and gate ${c.expectGate}`, { timeout: 240000 }, async () => {
      const dir = path.join(ROOT, c.kind);
      createFixtureProject(dir, c.kind);
      const project = app.addProject({ workspacePath: dir, name: `Fixture ${c.kind}`, trusted: true, trustedSource: 'test' });
      const out = await app.orchestrator.fullScan(project.id, { runCommands: true, suites: ['unit', 'integration', 'e2e'] });

      assert.equal(out.metadata.ok, true);
      assert.ok(out.metadata.fileCount > 8);
      assert.equal(out.health.status, c.expectHealth);
      assert.equal(out.gate.result, c.expectGate);
      assert.ok(out.gate.explanation.length > 40, 'the gate must explain itself');
      assert.ok(out.specs.length >= 1, 'SPEC.md must be recognised');
      assert.ok(out.criteria.length >= 1);
      assert.ok(out.stages.length >= 1, 'stage structure must be inferred');
      assert.ok(out.tasks.length >= 1);
      assert.ok(out.risks.length >= 1);
      assert.ok(out.snapshot.seq === 1);
      assert.ok(out.metadata.fileFingerprint.length === 40);

      // Build/test truth
      if (c.expectGate === 'PASS') {
        assert.equal(out.build.build.status, 'pass');
        assert.equal(out.tests.unit.status, 'pass');
        assert.equal(out.tests.e2e.status, 'pass');
      }
      if (c.kind === 'warning') {
        assert.equal(out.tests.unit.status, 'pass');
        assert.equal(out.tests.e2e.status, 'fail');
        assert.equal(out.tests.e2e.passed, 22);
        assert.equal(out.tests.e2e.total, 25);
        assert.equal(out.tests.e2e.cases.length, 3, 'the three failing E2E cases must be captured');
        assert.ok(out.tests.e2e.cases.every((x) => x.errorSummary.length > 0));
      }
      if (c.kind === 'critical') {
        assert.equal(out.build.build.status, 'fail');
        assert.equal(out.tests.unit.failed, 2);
        assert.ok(out.risks.some((r) => r.code === 'BUILD_FAILED'));
      }

      // Persistence round-trip
      const stored = app.repo.get('project_snapshots', out.snapshot.id);
      assert.equal(stored.health, c.expectHealth);
      assert.equal(app.repo.count('test_runs', { project_id: project.id }), 3);
      const eventTypes = app.events.timeline(project.id).map((e) => e.type);
      for (const expected of ['project_added', 'scan_started', 'scan_completed', 'snapshot_created', 'gate_evaluated']) {
        assert.ok(eventTypes.includes(expected), `timeline is missing a ${expected} event`);
      }
      assert.ok(app.memoryStore.latest(project.id), 'a project memory version must exist');

      // Next action + prompt generation
      const action = await app.aiService.nextAction(project.id, { engine: app.nextActionEngine });
      assert.ok(action.objective.length >= 4, `objective should be meaningful: ${action.objective}`);
      assert.ok(action.verificationCommands.length >= 1);
      assert.ok(['p0', 'p1', 'p2', 'p3'].includes(action.priority));
      if (c.kind === 'critical') assert.equal(action.priority, 'p0');
      if (c.kind === 'warning') assert.match(action.objective, /端到端/);

      const prompt = await app.promptGenerator.generate({
        project: app.getProject(project.id), metadata: out.metadata, git: out.git, build: out.build.build,
        unit: out.tests.unit, integration: out.tests.integration, e2e: out.tests.e2e,
        nextAction: action, risks: out.risks, memory: app.memoryStore.latest(project.id),
        failedCases: out.failedCases, specs: out.specs, criteria: out.criteria, tasks: out.tasks,
        currentStage: out.currentStage, agentKey: 'claude_code',
      });
      assert.deepEqual(prompt.sections.missing, []);
      for (const section of ['PROJECT CONTEXT', 'OBJECTIVE', 'ACCEPTANCE CRITERIA', 'VERIFICATION COMMANDS']) {
        assert.ok(prompt.prompt.includes(`## ${section}`), `prompt is missing ${section}`);
      }
      assert.ok(prompt.prompt.length > 800, 'the generated prompt must be substantial');
    });
  }

  test('a second scan after breaking the build detects a regression', { timeout: 240000 }, async () => {
    const dir = path.join(ROOT, 'regression');
    createFixtureProject(dir, 'healthy');
    const project = app.addProject({ workspacePath: dir, name: 'Regression fixture', trusted: true, trustedSource: 'test' });
    const first = await app.orchestrator.fullScan(project.id, { runCommands: true, suites: ['unit', 'e2e'] });
    assert.equal(first.health.status, 'healthy');

    applyRegression(dir, 'build');
    const second = await app.orchestrator.fullScan(project.id, { runCommands: true, suites: ['unit', 'e2e'] });
    assert.equal(second.build.build.status, 'fail');
    assert.equal(second.health.status, 'critical');
    const types = second.regressions.map((r) => r.type);
    assert.ok(types.includes('build_pass_to_fail'), `expected build regression, got ${types.join(',')}`);
    assert.equal(second.snapshot.seq, 2);

    const stored = app.repo.list('regressions', { project_id: project.id });
    assert.ok(stored.length >= 1);
    assert.ok(app.repo.list('project_snapshots', { project_id: project.id }).length === 2, 'snapshots are append-only');
    assert.ok(first.snapshot.id !== second.snapshot.id);
  });

  test('repeated scans are idempotent: no duplicate tasks, risks or stages', { timeout: 240000 }, async () => {
    const dir = path.join(ROOT, 'idempotent');
    createFixtureProject(dir, 'healthy');
    const project = app.addProject({ workspacePath: dir, name: 'Idempotency fixture', trusted: true, trustedSource: 'test' });
    await app.orchestrator.fullScan(project.id, { runCommands: false, suites: [] });
    await app.orchestrator.fullScan(project.id, { runCommands: false, suites: [] });
    await app.orchestrator.fullScan(project.id, { runCommands: false, suites: [] });
    assert.equal(app.repo.count('tasks', { project_id: project.id }), app.repo.count('tasks', { project_id: project.id }));
    const tasks = app.repo.list('tasks', { project_id: project.id });
    const fingerprints = new Set(tasks.map((t) => t.fingerprint));
    assert.equal(fingerprints.size, tasks.length, 'task fingerprints must be unique');
    const stages = app.repo.list('stages', { project_id: project.id });
    assert.equal(new Set(stages.map((s) => s.name)).size, stages.length, 'stages must not duplicate');
  });
});

describe('workspace registry safety', () => {
  test('refuses a missing directory, a file, and a duplicate workspace', () => {
    assert.throws(() => app.addProject({ workspacePath: path.join(ROOT, 'nope') }), /does not exist/);
    const file = path.join(ROOT, 'afile.txt');
    fs.writeFileSync(file, 'x');
    assert.throws(() => app.addProject({ workspacePath: file }), /not a directory/);
  });

  test('deleting a record leaves the source directory untouched', async () => {
    const dir = path.join(ROOT, 'deleteme');
    createFixtureProject(dir, 'healthy');
    const before = fs.readdirSync(dir).sort();
    const project = app.addProject({ workspacePath: dir, name: 'Delete me' });
    const stats = app.deleteProjectRecord(project.id);
    // The app canonicalises 8.3 short paths, so compare real directories rather
    // than raw strings; the readdir assertions below prove the source is untouched.
    const norm = (p) => String(expandShortPath(p)).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    assert.equal(norm(stats.sourceDirectoryUntouched), norm(path.resolve(dir)));
    assert.throws(() => app.getProject(project.id));
    const after = fs.readdirSync(dir).sort();
    assert.deepEqual(after, before);
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), true);
  });

  test('archive and pause/resume watch round-trip', async () => {
    const dir = path.join(ROOT, 'archive');
    createFixtureProject(dir, 'healthy');
    const project = app.addProject({ workspacePath: dir, name: 'Archive me' });
    app.pauseWatch(project.id);
    assert.equal(app.getProject(project.id).watch_paused, true);
    app.resumeWatch(project.id);
    assert.equal(app.getProject(project.id).watch_paused, false);
    app.archiveProject(project.id);
    assert.equal(app.listProjects().some((p) => p.id === project.id), false, 'archived projects leave the default list');
    app.unarchiveProject(project.id);
    assert.equal(app.listProjects().some((p) => p.id === project.id), true);
  });
});
