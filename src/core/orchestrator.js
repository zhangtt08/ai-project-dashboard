/**
 * Orchestrator — the full analysis pipeline (requirements #42, #63, Stage 5-7).
 *
 * Every project mutation in the product flows through here. Steps 1-14 are deterministic;
 * step 15 (AI enrichment) is optional, opt-in and always schema-validated.
 */
import {
  JOB_TYPE, EVENT_TYPE, PROJECT_STATUS, PROJECT_HEALTH, TASK_STATUS, GATE_RESULT,
} from '../domain/constants.js';
import { newId, nowIso, truncate } from './util.js';
import { WorkspaceError } from '../domain/errors.js';
import { logger } from './logger.js';
import { evSnapshot, evFile } from './evidence.js';
import { classifyProject, identifyPurpose } from './categories.js';
import { buildSuggestions, summarizeSuggestions } from './engines/suggestions.js';

const log = logger.child('orchestrator');

const RUN_SEVERITY = ['pass', 'unknown', 'unsupported', 'skipped', 'timeout', 'error', 'fail'];

/**
 * The step list a full scan walks through. Progress is an index into THIS list, so the UI can
 * say "第 6/15 步：构建" — a statement about real code paths, not an estimated percentage.
 */
export const FULL_SCAN_STEPS = [
  '扫描文件', '读取 Git 状态', '解析规范文档', '提取任务', '规划阶段',
  '构建', 'Lint', '类型检查', '测试', '风险', '回归', '漂移',
  '健康与快照', '分类与建议', '写入项目记忆',
];

export class CancelledError extends Error {
  constructor(step) {
    super(`任务已取消（停在「${step}」）`);
    this.name = 'CancelledError';
    this.step = step;
  }
}

function makeProgress(ctx, steps) {
  const report = typeof ctx.report === 'function' ? ctx.report : () => {};
  let index = 0;
  const total = steps.length;
  return {
    step(label) {
      const i = Math.max(0, steps.indexOf(label));
      index = i + 1;
      report({ step: index, total, label, steps: total });
    },
    guard() {
      if (ctx.signal && ctx.signal.aborted) throw new CancelledError(steps[Math.max(0, index - 1)] || steps[0]);
    },
  };
}

/** Commands the user pinned by hand (metadata.manualCommands) win over detection. */
function projectManualCommands(project) {
  return (project && project.metadata && project.metadata.manualCommands) || {};
}

/** Aggregate the suites into the one signal a suggestion should quote. */
function pickWorstRun(runs) {  const list = (runs || []).filter(Boolean);
  if (!list.length) return { status: 'unknown', total: 0, failed: 0, passed: 0, command: '', suite: '' };
  const rank = (r) => RUN_SEVERITY.lastIndexOf(String(r.status || 'unknown'));
  const worst = list.slice().sort((a, b) => rank(b) - rank(a))[0];
  return {
    status: String(worst.status || 'unknown'),
    suite: worst.suite || '',
    command: worst.command || '',
    exitCode: worst.exitCode,
    total: list.reduce((a, r) => a + (Number(r.total) || 0), 0),
    passed: list.reduce((a, r) => a + (Number(r.passed) || 0), 0),
    failed: list.reduce((a, r) => a + (Number(r.failed) || 0), 0),
  };
}

export class Orchestrator {
  constructor(deps) {
    Object.assign(this, deps);
  }

  #project(projectId) {
    const p = this.repo.get('projects', projectId);
    if (!p) throw new Error(`project not found: ${projectId}`);
    return p;
  }

  /** Cheap scan: metadata + git only. */
  async quickScan(projectId, ctx = {}) {
    const project = this.#project(projectId);
    this.events.record(projectId, EVENT_TYPE.SCAN_STARTED, 'Quick scan started', { kind: 'quick' });
    const metadata = await this.scanner.scan(project.workspace_path, {
      userPatterns: project.ignore_patterns || [],
      signal: ctx.signal || null,
    });
    if (metadata.aborted) throw new CancelledError('扫描文件');
    // A scan that read nothing must not be recorded as an analysis: stamping last_analyzed_at or
    // overwriting the language/repo fields here would assert facts about a folder we cannot open.
    if (!metadata.ok) {
      this.events.record(projectId, EVENT_TYPE.SCAN_FAILED, `Quick scan failed: ${metadata.reason}`, { reason: metadata.reason }, { level: 'error' });
      throw new WorkspaceError(`workspace scan failed: ${metadata.reason}`, '项目目录已不存在或读不到——在「整理」里改成新位置后重新分析，或删除这条记录。');
    }
    metadata.manualCommands = projectManualCommands(project);
    const git = await this.gitAnalyzer.analyze(project.workspace_path, { includeDiff: true, recentCommitCount: 10 });
    const patch = {
      metadata,
      last_analyzed_at: nowIso(),
      primary_language: metadata.ok ? metadata.primaryLanguage : project.primary_language,
      framework: metadata.ok ? metadata.framework : project.framework,
      package_manager: metadata.ok ? metadata.packageManager : project.package_manager,
      repository_type: git.isRepository ? 'git' : (metadata.isGitRepositoryHint ? 'git-unavailable' : 'none'),
      updated_at: nowIso(),
    };
    const merged = { ...(project.metadata || {}), ...patch, metadata, git };
    if (metadata.ok) {
      const classification = classifyProject(metadata, { manualCategory: project.category_manual ? project.category : null });
      const specs = this.repo.list('specifications', { project_id: projectId });
      const suggestions = buildSuggestions({
        project,
        meta: metadata,
        git,
        build: null,
        gate: null,
        health: null,
        drift: null,
        risks: this.repo.list('risks', { project_id: projectId }),
        regressions: this.repo.list('regressions', { project_id: projectId }),
        tasks: this.taskLedger.summary(projectId),
        specs,
        prompts: this.repo.list('prompts', { project_id: projectId }),
        testRuns: {},
      });
      merged.classification = classification;
      merged.purpose = identifyPurpose(metadata, { specs, project });
      merged.suggestions = suggestions;
      merged.suggestionSummary = summarizeSuggestions(suggestions);
      merged.suggestedAt = nowIso();
      patch.category = classification.category;
      patch.category_manual = classification.manual ? 1 : 0;
    }
    this.repo.update('projects', projectId, { ...patch, metadata: merged });
    this.events.record(projectId, EVENT_TYPE.SCAN_COMPLETED, `Quick scan completed (${metadata.fileCount} files)`, { durationMs: metadata.durationMs });
    return { metadata, git };
  }

  /**
   * Full scan: scanner → git → specs → tasks → stages → build → tests → risks →
   * health → gate → snapshot → regressions → memory.
   */
  async fullScan(projectId, { runCommands = true, suites = ['unit', 'integration', 'e2e'] } = {}, ctx = {}) {
    const project = this.#project(projectId);
    const started = Date.now();
    const prog = makeProgress(ctx, FULL_SCAN_STEPS);
    this.events.record(projectId, EVENT_TYPE.SCAN_STARTED, 'Full scan started', { kind: 'full' });

    // 1. Scanner
    prog.step('扫描文件');
    const metadata = await this.scanner.scan(project.workspace_path, {
      userPatterns: project.ignore_patterns || [],
      signal: ctx.signal || null,
    });
    if (metadata.aborted) throw new CancelledError('扫描文件');
    if (!metadata.ok) {
      this.events.record(projectId, EVENT_TYPE.SCAN_FAILED, `Full scan failed: ${metadata.reason}`, { reason: metadata.reason }, { level: 'error' });
      throw new WorkspaceError(`workspace scan failed: ${metadata.reason}`, '项目目录已不存在或读不到——在「整理」里改成新位置后重新分析，或删除这条记录。');
    }
    metadata.manualCommands = projectManualCommands(project);

    // 2. Git
    prog.step('读取 Git 状态'); prog.guard();
    const git = await this.gitAnalyzer.analyze(project.workspace_path, { includeDiff: true, recentCommitCount: 15 });
    const gitSnapshot = this.repo.insert('git_snapshots', {
      id: newId('gts'),
      project_id: projectId,
      ts: git.ts,
      is_repository: git.isRepository,
      git_available: git.gitAvailable,
      branch: git.branch,
      commit_hash: git.commitHash,
      commit_subject: truncate(git.commitSubject, 300),
      commit_time: git.commitTime,
      working_tree_clean: git.workingTreeClean,
      modified: git.modified,
      added: git.added,
      deleted: git.deleted,
      untracked: git.untracked,
      renamed: git.renamed,
      diff_summary: { ...git.diffSummary, numstat: git.diffSummary.numstat.slice(0, 50) },
      recent_commits: git.recentCommits,
      error: git.error || '',
    });

    // 3. Specification
    prog.step('解析规范文档'); prog.guard();
    const specResult = await this.specManager.analyze({ root: project.workspace_path, metadata });
    this.repo.removeWhere('specifications', { project_id: projectId });
    this.repo.removeWhere('acceptance_criteria', { project_id: projectId });
    const savedSpecs = [];
    for (const s of specResult.specifications) {
      const row = this.repo.insert('specifications', {
        id: newId('spc'),
        project_id: projectId,
        path: s.path,
        kind: s.kind,
        title: s.title,
        parsed: s.parsed,
        content_hash: s.content_hash,
        byte_size: s.byte_size,
      });
      savedSpecs.push({ ...s, id: row.id });
    }
    const specIdMap = new Map(specResult.specifications.map((s, i) => [s.id, savedSpecs[i].id]));
    const savedCriteria = specResult.acceptanceCriteria.map((c) => this.repo.insert('acceptance_criteria', {
      id: newId('acc'),
      project_id: projectId,
      stage_id: null,
      spec_id: specIdMap.get(c.spec_id) || null,
      requirement_ref: c.requirement_ref,
      text: c.text,
      kind: c.kind,
      status: c.status,
      evidence: c.evidence,
    }));

    // 4. Tasks
    prog.step('提取任务'); prog.guard();
    const sessions = this.repo.list('agent_sessions', { project_id: projectId });
    const derived = this.taskLedger.derive({ specs: savedSpecs, criteria: savedCriteria, metadata, sessions });
    const taskSync = this.taskLedger.sync(projectId, derived);
    let tasks = this.repo.list('tasks', { project_id: projectId });

    // 5. Stages
    prog.step('规划阶段'); prog.guard();
    const planned = this.stageManager.plan({ specs: savedSpecs, tasks, acceptance: savedCriteria });
    const stageResult = this.stageManager.sync(projectId, planned);
    tasks = this.repo.list('tasks', { project_id: projectId });
    let stages = this.repo.list('stages', { project_id: projectId }, { orderBy: 'order_index' });
    const currentStage = this.stageManager.currentStage(stages, tasks);

    // 6. Build
    let build = null;
    let lint = null;
    let typecheck = null;
    if (runCommands) {
      prog.step('构建'); prog.guard();
      build = await this.buildAnalyzer.run({ root: project.workspace_path, metadata }, 'build', { signal: ctx.signal || null });
      if (build.cancelled) throw new CancelledError('构建');
      prog.step('Lint'); prog.guard();
      lint = await this.buildAnalyzer.run({ root: project.workspace_path, metadata }, 'lint', { signal: ctx.signal || null });
      if (lint.cancelled) throw new CancelledError('Lint');
      prog.step('类型检查'); prog.guard();
      typecheck = await this.buildAnalyzer.run({ root: project.workspace_path, metadata }, 'typecheck', { signal: ctx.signal || null });
      if (typecheck.cancelled) throw new CancelledError('类型检查');
      for (const [kind, res] of [['build', build], ['lint', lint], ['typecheck', typecheck]]) {
        this.repo.insert('build_results', {
          id: newId('bld'), project_id: projectId, kind,
          command: res.command || '(unsupported)', status: res.status, exit_code: res.exitCode,
          duration_ms: res.durationMs, stdout_summary: res.stdoutSummary,
          stderr_summary: res.stderrSummary, truncated: res.truncated,
          unsupported_reason: res.unsupportedReason || '', ts: res.ts,
        });
      }
    } else {
      const last = this.repo.list('build_results', { project_id: projectId, kind: 'build' }, { orderBy: 'ts DESC', limit: 1 })[0];
      build = last ? this.#storedBuild(last) : null;
    }

    // 7. Tests
    const tests = {};
    if (runCommands) {
      prog.step('测试'); prog.guard();
      for (const suite of suites) {
        const run = await this.testAnalyzer.runSuite({ root: project.workspace_path, metadata }, suite, { signal: ctx.signal || null });
        if (run.cancelled) throw new CancelledError(`测试（${suite}）`);
        this.#persistTestRun(projectId, run);
        tests[suite] = run;
      }
    } else {
      for (const suite of suites) {
        const last = this.repo.list('test_runs', { project_id: projectId, suite }, { orderBy: 'ts DESC', limit: 1 })[0];
        tests[suite] = last ? this.#storedRun(last) : null;
      }
    }

    // 8. Risks
    prog.step('风险'); prog.guard();
    const previousSnapshot = this.repo.list('project_snapshots', { project_id: projectId }, { orderBy: 'seq DESC', limit: 1 })[0] || null;
    const risksInput = {
      build, unit: tests.unit, integration: tests.integration, e2e: tests.e2e,
      git, metadata, previous: previousSnapshot, tasks, criteria: savedCriteria, regressions: [],
      project,
    };
    if (metadata) metadata.e2eMockLeak = await this.#detectMockLeak(project.workspace_path, metadata);
    let risks = this.riskEngine.detect(risksInput);
    this.#persistRisks(projectId, risks);
    risks = this.repo.list('risks', { project_id: projectId }, { orderBy: 'created_at DESC' });

    // 9. Regression (needs previous snapshot, computed before risks for accuracy on 2nd pass)
    prog.step('回归'); prog.guard();
    const failedCases = Object.values(tests).filter(Boolean).flatMap((r) => (r.cases || []).map((c) => ({ ...c, suite: r.suite })));
    const gate = this.acceptanceGate.evaluate({
      stage: currentStage, build, unit: tests.unit, integration: tests.integration, e2e: tests.e2e,
      risks, tasks, criteria: savedCriteria,
    });
    const regressions = this.regressionDetector.detect({
      previous: previousSnapshot,
      current: {
        git, build, unit: tests.unit, integration: tests.integration, e2e: tests.e2e,
        risks, metadata, stageId: currentStage ? currentStage.id : null, stageName: currentStage ? currentStage.name : '',
        criteria: savedCriteria, gate,
        previousStageCompleted: previousSnapshot ? previousSnapshot.stage_name !== (currentStage ? currentStage.name : null) : false,
        currentStageStatus: currentStage ? currentStage.status : null,
      },
    });
    for (const r of regressions) {
      const existing = this.repo.list('regressions', { project_id: projectId, fingerprint: r.fingerprint });
      if (existing.length) continue;
      this.repo.insert('regressions', {
        id: newId('reg'), project_id: projectId, ts: nowIso(), type: r.type, severity: r.severity, title: r.title,
        before: r.before, after: r.after, evidence: r.evidence, suggested_action: r.suggested_action, acknowledged: false,
        fingerprint: r.fingerprint,
      });
      this.events.record(projectId, EVENT_TYPE.REGRESSION_DETECTED, `Regression: ${r.title}`, { type: r.type, severity: r.severity });
    }
    const openRegressions = this.repo.list('regressions', { project_id: projectId }, { orderBy: 'ts DESC', limit: 20 });

    // Re-evaluate risks with the regression list included for completeness.
    risks = this.riskEngine.detect({ ...risksInput, regressions: openRegressions });
    this.#persistRisks(projectId, risks);
    risks = this.repo.list('risks', { project_id: projectId }, { orderBy: 'created_at DESC' });

    // 10. Drift
    prog.step('漂移'); prog.guard();
    const drift = this.driftDetector.detect({
      specs: savedSpecs, criteria: savedCriteria, tasks, git, metadata, previous: previousSnapshot,
      unit: tests.unit, e2e: tests.e2e,
    });

    // 11. Health + progress
    prog.step('健康与快照'); prog.guard();
    const health = this.healthEngine.evaluate({
      build, unit: tests.unit, integration: tests.integration, e2e: tests.e2e,
      risks, tasks, git, gate, regressions: openRegressions, metadata, criteria: savedCriteria,
    });
    const progress = this.progressEngine.compute({ stages, tasks, criteria: savedCriteria });
    this.repo.insert('health_results', {
      id: newId('hlt'), project_id: projectId, ts: nowIso(), status: health.status, score: health.score, reasons: health.reasons,
    });

    // 12. Snapshot
    const seq = (previousSnapshot ? previousSnapshot.seq : 0) + 1;
    const snapshot = this.repo.insert('project_snapshots', {
      id: newId('snp'),
      project_id: projectId,
      ts: nowIso(),
      seq,
      git: { branch: git.branch, head: git.commitShort, clean: git.workingTreeClean, changed: git.changedFileCount, untracked: (git.untracked || []).length },
      build: build ? { status: build.status, command: build.command, exitCode: build.exitCode, durationMs: build.durationMs } : { status: 'unknown' },
      unit: tests.unit ? this.#runSnapshot(tests.unit) : { status: 'unknown' },
      integration: tests.integration ? this.#runSnapshot(tests.integration) : { status: 'unknown' },
      e2e: tests.e2e ? this.#runSnapshot(tests.e2e) : { status: 'unknown' },
      task_summary: this.taskLedger.summary(projectId),
      risk_summary: { total: risks.length, open: risks.filter((r) => r.status === 'open').length, bySeverity: this.#countBy(risks, 'severity') },
      stage_id: currentStage ? currentStage.id : null,
      stage_name: currentStage ? currentStage.name : '',
      health: health.status,
      progress,
      gate: { result: gate.result, explanation: gate.explanation, failedChecks: gate.failedChecks },
      file_fingerprint: metadata.fileFingerprint,
      file_count: metadata.fileCount,
    });
    // roleCounts are needed by drift detection on the next run.
    this.repo.update('project_snapshots', snapshot.id, { task_summary: { ...snapshot.task_summary, roleCounts: metadata.roleCounts } });

    // 13. Project row
    const status = deriveProjectStatus({ health, gate, tasks, build });
    const mergedMeta = {
      ...(project.metadata || {}),
      metadata,
      git,
      gitSnapshotId: gitSnapshot.id,
      gate,
      drift,
      health,
      progress,
      tests: { unit: this.#runSnapshot(tests.unit), integration: this.#runSnapshot(tests.integration), e2e: this.#runSnapshot(tests.e2e) },
      build: build ? { status: build.status, command: build.command, exitCode: build.exitCode, durationMs: build.durationMs, unsupportedReason: build.unsupportedReason, ts: build.ts } : null,
      lint: lint ? { status: lint.status, command: lint.command } : null,
      typecheck: typecheck ? { status: typecheck.status, command: typecheck.command } : null,
      specSummary: { count: savedSpecs.length, criteria: savedCriteria.length, unmet: savedCriteria.filter((c) => c.status === 'unmet').length, paths: savedSpecs.map((s) => s.path) },
      taskSync,
      nextAction: null,
      lastScanDurationMs: Date.now() - started,
      lastScanAt: nowIso(),
      lastSnapshotId: snapshot.id,
      lastSnapshotSeq: seq,
    };
    // A next action is ALWAYS derived deterministically so the product answers
    // "what should the next agent do?" without needing an API key.
    const nextAction = this.nextActionEngine
      ? this.nextActionEngine.decide({
        build, unit: tests.unit, integration: tests.integration, e2e: tests.e2e,
        risks, regressions: openRegressions, drift, gate, tasks, stages, currentStage,
        specs: savedSpecs, metadata, git, failedCases,
      })
      : null;
    mergedMeta.nextAction = nextAction;

    prog.step('分类与建议'); prog.guard();
    // 13b. 项目分类 / 用途识别 / 可优化建议 — derived only from the evidence gathered above.
    //      A category the user set by hand always wins over the inferred one.
    const classification = classifyProject(metadata, {
      manualCategory: project.category_manual ? project.category : null,
      specs: savedSpecs,
    });
    const testRuns = pickWorstRun([tests.unit, tests.integration, tests.e2e]);
    const suggestions = buildSuggestions({
      project,
      meta: metadata,
      git,
      build,
      gate,
      health,
      drift,
      risks,
      regressions: openRegressions,
      tasks: this.taskLedger.summary(projectId),
      specs: savedSpecs,
      prompts: this.repo.list('prompts', { project_id: projectId }),
      testRuns,
    });
    mergedMeta.classification = classification;
    mergedMeta.purpose = identifyPurpose(metadata, { specs: savedSpecs, project });
    mergedMeta.suggestions = suggestions;
    mergedMeta.suggestionSummary = summarizeSuggestions(suggestions);
    mergedMeta.suggestedAt = nowIso();

    this.repo.update('projects', projectId, {
      metadata: mergedMeta,
      category: classification.category,
      category_manual: classification.manual ? 1 : 0,
      health: health.status,
      status,
      current_stage_id: currentStage ? currentStage.id : null,
      progress,
      last_analyzed_at: nowIso(),
      primary_language: metadata.primaryLanguage,
      framework: metadata.framework,
      package_manager: metadata.packageManager,
      repository_type: git.isRepository ? 'git' : (metadata.isGitRepositoryHint ? 'git-unavailable' : 'none'),
    });

    // 14. Memory version
    prog.step('写入项目记忆'); prog.guard();
    const memoryResult = this.memoryStore.version(projectId, this.memoryStore.compose({
      project: { ...project, id: projectId, name: project.name, description: project.description },
      metadata, git, specs: savedSpecs, criteria: savedCriteria, tasks, stages,
      risks, regressions: openRegressions, gate, health, progress,
    }), { author: 'system', note: `auto-versioned after full scan #${seq}` });

    // 15. Timeline
    this.events.record(projectId, EVENT_TYPE.SNAPSHOT_CREATED, `Snapshot #${seq} created`, { snapshotId: snapshot.id, health: health.status, gate: gate.result });
    for (const r of risks.filter((x) => x.severity === 'critical' || x.severity === 'high').slice(0, 5)) {
      this.events.record(projectId, EVENT_TYPE.RISK_DETECTED, `Risk (${r.severity}): ${r.title}`, { code: r.code });
    }
    this.events.record(projectId, EVENT_TYPE.SCAN_COMPLETED, `Full scan completed in ${Date.now() - started}ms`, {
      files: metadata.fileCount, health: health.status, gate: gate.result, regressions: regressions.length,
    });
    this.events.record(projectId, EVENT_TYPE.GATE_EVALUATED, `Acceptance gate: ${gate.result}`, { explanation: gate.explanation });
    if (drift.verdict === 'possible_drift') {
      this.events.record(projectId, EVENT_TYPE.DRIFT_DETECTED, `Possible drift detected (${drift.drifts.length} signal(s))`, { count: drift.drifts.length });
    }
    this.events.diffAndEmit(projectId, previousSnapshot, { build, unit: tests.unit, integration: tests.integration, e2e: tests.e2e });

    if (this.search) this.search.reindexProject(projectId);

    log.info('full_scan_complete', {
      projectId, files: metadata.fileCount, health: health.status, gate: gate.result,
      durationMs: Date.now() - started, tasks: tasks.length, risks: risks.length, regressions: regressions.length,
    });

    return {
      projectId,
      metadata,
      git,
      specs: savedSpecs,
      criteria: savedCriteria,
      tasks,
      stages,
      currentStage,
      build: { build, lint, typecheck },
      tests,
      risks,
      regressions: openRegressions,
      drift,
      health,
      progress,
      gate,
      snapshot,
      nextAction,
      memory: memoryResult.memory,
      memoryCreated: memoryResult.created,
      failedCases,
      durationMs: Date.now() - started,
    };
  }

  /** Re-derive recommendations from stored data without re-running commands. */
  analysisContext(projectId) {
    const project = this.#project(projectId);
    const meta = project.metadata || {};
    return {
      project,
      metadata: meta.metadata || null,
      git: meta.git || null,
      build: meta.build ? { ...meta.build, status: meta.build.status } : null,
      tests: meta.tests || {},
      gate: meta.gate || null,
    };
  }

  #runSnapshot(run) {
    if (!run) return { status: 'unknown', total: 0, passed: 0, failed: 0, skipped: 0, framework: 'unknown', confidence: 'unknown', ts: null };
    return {
      status: run.status, total: run.total, passed: run.passed, failed: run.failed,
      skipped: run.skipped, framework: run.framework, confidence: run.parseConfidence, command: run.command,
      // When this run actually happened — the attention list shows per-item ages, and
      // "when did we observe this" must not be invented.
      ts: run.ts || run.finishedAt || null,
    };
  }

  #storedRun(row) {
    return {
      suite: row.suite, framework: row.framework, command: row.command, status: row.status,
      total: row.total, passed: row.passed, failed: row.failed, skipped: row.skipped,
      durationMs: row.duration_ms, exitCode: row.exit_code, parseConfidence: row.parse_confidence,
      cases: this.repo.list('test_case_results', { test_run_id: row.id }).map((c) => ({ name: c.name, file: c.file, status: c.status, errorSummary: c.error_summary, suite: row.suite })),
      ts: row.ts, rawTail: row.raw_tail,
    };
  }

  #storedBuild(row) {
    return {
      kind: row.kind, command: row.command, status: row.status, exitCode: row.exit_code,
      durationMs: row.duration_ms, stdoutSummary: row.stdout_summary, stderrSummary: row.stderr_summary,
      truncated: row.truncated, unsupportedReason: row.unsupported_reason, ts: row.ts,
    };
  }

  #persistTestRun(projectId, run) {
    const row = this.repo.insert('test_runs', {
      id: newId('tst'), project_id: projectId, suite: run.suite, framework: run.framework, command: run.command,
      status: run.status, total: run.total, passed: run.passed, failed: run.failed, skipped: run.skipped,
      duration_ms: run.durationMs, exit_code: run.exitCode, parse_confidence: run.parseConfidence,
      raw_tail: truncate(run.rawTail, 3000), ts: run.ts,
    });
    for (const c of run.cases || []) {
      this.repo.insert('test_case_results', {
        id: newId('tcr'), test_run_id: row.id, project_id: projectId, suite: run.suite,
        name: c.name.slice(0, 300), file: c.file || '', status: c.status, duration_ms: c.durationMs || 0,
        error_summary: truncate(c.errorSummary || '', 400),
      });
    }
    return row;
  }

  #persistRisks(projectId, risks) {
    const existing = this.repo.list('risks', { project_id: projectId });
    const byCode = new Map(existing.map((r) => [r.code, r]));
    const seen = new Set();
    for (const r of risks) {
      seen.add(r.code);
      const found = byCode.get(r.code);
      if (found) {
        this.repo.update('risks', found.id, {
          title: r.title, severity: r.severity, description: r.description,
          suggested_action: r.suggested_action, confidence: r.confidence, evidence: r.evidence,
          status: found.status === 'resolved' ? 'resolved' : 'open', fingerprint: r.fingerprint,
        });
      } else {
        this.repo.insert('risks', {
          id: newId('rsk'), project_id: projectId, code: r.code, title: r.title, severity: r.severity,
          description: r.description, suggested_action: r.suggested_action, status: 'open',
          source: r.source, confidence: r.confidence, evidence: r.evidence, fingerprint: r.fingerprint,
        });
      }
    }
    for (const old of existing) {
      if (seen.has(old.code)) continue;
      if (old.status === 'open') this.repo.update('risks', old.id, { status: 'resolved' });
    }
  }

  async #detectMockLeak(root, metadata) {
    try {
      const { scanForMockLeak, MOCK_LEAK_RE } = await import('./engines/risk.js');
      const { readWorkspaceText } = await import('./fs-safe.js');
      const suspects = scanForMockLeak(root, this.#filesOf(metadata));
      const hits = [];
      for (const p of suspects) {
        const res = await readWorkspaceText(root, p, { maxBytes: 128 * 1024 });
        if (!res.ok) continue;
        const lines = res.text.split(/\r?\n/);
        const hit = lines.findIndex((l) => MOCK_LEAK_RE.test(l) && !/^\s*(\/\/|\*)/.test(l));
        if (hit >= 0) hits.push(`${p}:${hit + 1}`);
        if (hits.length >= 5) break;
      }
      return hits;
    } catch {
      return [];
    }
  }

  #filesOf(metadata) {
    const out = [];
    for (const f of metadata.topLevelFiles || []) out.push({ path: f, role: 'source', sizeBytes: 0 });
    for (const f of metadata.largestFiles || []) out.push({ path: f.path, role: /(^|\/)(tests?|e2e)\//.test(f.path) ? 'test' : 'source', sizeBytes: f.sizeBytes });
    for (const f of metadata.markdownDocs || []) out.push({ path: f.path, role: 'docs', sizeBytes: f.bytes });
    return out;
  }

  #countBy(rows, key) {
    const out = {};
    for (const r of rows) out[r[key]] = (out[r[key]] || 0) + 1;
    return out;
  }

  registerHandlers(queue) {
    queue.register(JOB_TYPE.QUICK_SCAN, async (payload, ctx = {}) => this.quickScan(payload.projectId, ctx));
    queue.register(JOB_TYPE.FULL_SCAN, async (payload, ctx = {}) => {
      const result = await this.fullScan(payload.projectId, { runCommands: payload.runCommands !== false, suites: payload.suites }, ctx);
      return { health: result.health.status, gate: result.gate.result, durationMs: result.durationMs, snapshotSeq: result.snapshot.seq };
    });
    queue.register(JOB_TYPE.GIT, async (payload) => {
      const project = this.#project(payload.projectId);
      const git = await this.gitAnalyzer.analyze(project.workspace_path, { includeDiff: true, recentCommitCount: 15 });
      const meta = { ...(project.metadata || {}), git };
      this.repo.update('projects', payload.projectId, { metadata: meta, last_analyzed_at: nowIso() });
      return { branch: git.branch, head: git.commitShort, clean: git.workingTreeClean };
    });
    queue.register(JOB_TYPE.BUILD, async (payload, ctx = {}) => {
      const project = this.#project(payload.projectId);
      const metadata = (project.metadata && project.metadata.metadata) || (await this.scanner.scan(project.workspace_path, {}));
      metadata.manualCommands = projectManualCommands(project);
      const result = await this.buildAnalyzer.run({ root: project.workspace_path, metadata }, payload.kind || 'build', { signal: ctx.signal || null });
      if (result.cancelled) throw new CancelledError(`命令 ${result.command}`);
      this.repo.insert('build_results', {
        id: newId('bld'), project_id: payload.projectId, kind: result.kind, command: result.command || '(unsupported)',
        status: result.status, exit_code: result.exitCode, duration_ms: result.durationMs,
        stdout_summary: result.stdoutSummary, stderr_summary: result.stderrSummary,
        truncated: result.truncated, unsupported_reason: result.unsupportedReason || '', ts: result.ts,
      });
      const meta = { ...(project.metadata || {}) };
      meta.build = { status: result.status, command: result.command, exitCode: result.exitCode, durationMs: result.durationMs, unsupportedReason: result.unsupportedReason, ts: result.ts };
      this.repo.update('projects', payload.projectId, { metadata: meta });
      return { status: result.status, exitCode: result.exitCode, durationMs: result.durationMs };
    });
    queue.register(JOB_TYPE.TEST, async (payload, ctx = {}) => {
      const project = this.#project(payload.projectId);
      const metadata = (project.metadata && project.metadata.metadata) || (await this.scanner.scan(project.workspace_path, {}));
      metadata.manualCommands = projectManualCommands(project);
      const run = await this.testAnalyzer.runSuite({ root: project.workspace_path, metadata }, payload.suite || 'unit', { signal: ctx.signal || null });
      if (run.cancelled) throw new CancelledError(`测试（${payload.suite || 'unit'}）`);
      this.#persistTestRun(payload.projectId, run);
      const meta = { ...(project.metadata || {}), tests: { ...((project.metadata || {}).tests || {}) } };
      meta.tests[run.suite] = this.#runSnapshot(run);
      this.repo.update('projects', payload.projectId, { metadata: meta });
      return { status: run.status, passed: run.passed, total: run.total, failed: run.failed };
    });
    queue.register(JOB_TYPE.RISK, async (payload, ctx = {}) => this.quickScan(payload.projectId, ctx));
    queue.register(JOB_TYPE.AI_ANALYSIS, async (payload) => {
      // AI enrichment is additive: with the provider off (or not wired) this is a
      // graceful skip, never a failed job.
      if (!this.aiService) return { skipped: true, reason: 'AI service is not wired in this deployment' };
      try {
        return await this.aiService.enrichProject(payload.projectId, payload);
      } catch (err) {
        return { skipped: true, reason: err.message };
      }
    });
    return queue;
  }
}

export function deriveProjectStatus({ health, gate, tasks, build }) {
  if (health && health.status === PROJECT_HEALTH.CRITICAL) return PROJECT_STATUS.BLOCKED;
  if (gate && gate.result === GATE_RESULT.PASS) return PROJECT_STATUS.READY;
  if (build && build.status === 'fail') return PROJECT_STATUS.BLOCKED;
  if (tasks.some((t) => t.status === TASK_STATUS.BLOCKED)) return PROJECT_STATUS.BLOCKED;
  const inProgress = tasks.some((t) => t.status === TASK_STATUS.IN_PROGRESS);
  if (gate && gate.result === GATE_RESULT.FAIL) return PROJECT_STATUS.TESTING;
  if (inProgress) return PROJECT_STATUS.DEVELOPING;
  if (tasks.length) return PROJECT_STATUS.DEVELOPING;
  return PROJECT_STATUS.PLANNING;
}

export { evSnapshot, evFile };
