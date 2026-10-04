/**
 * App container — wires every layer into one object graph.
 *
 * This is the single composition root. Nothing else constructs a Database, a
 * CommandRunner or an AI provider.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getDb, openDatabase } from '../db/database.js';
import { Repository } from '../db/repositories.js';
import { logger, logFileFor } from './logger.js';
import { CommandRunner, describeSecurityModel } from './command-runner.js';
import { ProjectScanner } from './scanner.js';
import { GitAnalyzer } from './git-analyzer.js';
import { BuildAnalyzer } from './analyzers/build-analyzer.js';
import { TestAnalyzer } from './analyzers/test-analyzer.js';
import { analyzeChanges } from './analyzers/change-analyzer.js';
import { SpecificationManager } from './engines/spec-manager.js';
import { TaskLedger } from './engines/task-ledger.js';
import { StageManager } from './engines/stage-manager.js';
import { evaluateGate } from './engines/acceptance-gate.js';
import { ProjectHealthEngine, ProjectProgressEngine } from './engines/health.js';
import { analyzeRisks, riskSummary } from './engines/risk.js';
import { detectRegressions, regressionSummary } from './engines/regression.js';
import { detectDrift } from './engines/drift.js';
import { ProjectMemoryStore, AdrStore } from './engines/memory.js';
import { NextActionEngine } from './engines/next-action.js';
import { PromptGenerator } from './engines/prompt-generator.js';
import { buildHandoffPackage } from './engines/handoff.js';
import { classifyProject, identifyPurpose, CATEGORY_KEYS, categoryLabel } from './categories.js';
import { buildSuggestions, summarizeSuggestions } from './engines/suggestions.js';
import { discoverProjects as scanDiskForProjects, defaultRoots } from './discovery.js';
import { assessPurgeTarget, purgeDirectory, formatBytes } from './source-purge.js';
import { EventLog } from './events.js';
import { SearchService } from './search.js';
import { AnalysisQueue, WorkspaceWatcher } from './jobs.js';
import { Orchestrator } from './orchestrator.js';
import { AgentSessionService } from './agent-sessions.js';
import { ProviderRegistry } from './ai/provider.js';
import { MockAIProvider } from './ai/mock-provider.js';
import { OpenAICompatibleProvider } from './ai/openai-provider.js';
import { StructuredRunner } from './ai/structured.js';
import { AIService } from './ai/service.js';
import { ensureDemoProjects, demoProjectDefinitions } from '../demo/fixture-factory.js';
import { EVENT_TYPE, PROJECT_STATUS, PROJECT_HEALTH, DEFAULT_SCAN_LIMITS, SENSITIVE_PATTERNS } from '../domain/constants.js';
import { newId, nowIso, toPosix } from './util.js';
import { expandShortPath } from './fs-safe.js';
import { WorkspaceError, ConflictError, NotFoundError } from '../domain/errors.js';

/** Thin adapters so engines expose a uniform `.detect()/.evaluate()` surface. */
class RiskEngine { detect(input) { return analyzeRisks(input); } }
class AcceptanceGate { evaluate(input) { return evaluateGate(input); } }
class RegressionDetector { detect(input) { return detectRegressions(input); } }
class DriftDetector { detect(input) { return detectDrift(input); } }

const SUITE_LABEL_ZH = { unit: '单元测试', e2e: '端到端测试', integration: '集成测试' };

export class App {
  constructor({ dataDir = null, dbFile = null, logLevel = null } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data');
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (logLevel) logger.configure({ level: logLevel });
    logger.configure({ file: logFileFor(this.dataDir) });

    this.dbFile = dbFile || path.join(this.dataDir, 'commander.db');
    this.db = dbFile === ':memory:' ? openDatabase(':memory:') : getDb(this.dbFile);
    this.repo = new Repository(this.db);

    // Infrastructure
    this.runner = new CommandRunner({ defaultTimeoutMs: DEFAULT_SCAN_LIMITS.defaultCommandTimeoutMs });
    this.events = new EventLog({ repo: this.repo });
    this.search = new SearchService({ db: this.db, repo: this.repo });
    this.queue = new AnalysisQueue({ repo: this.repo, concurrency: 2, events: this.events });
    this.watcher = new WorkspaceWatcher({
      events: this.events,
      queue: this.queue,
      autoQuickScan: this.repo.getSetting('watcher.autoQuickScan') === 'true',
    });

    // Analysis
    this.scanner = new ProjectScanner();
    this.gitAnalyzer = new GitAnalyzer({ runner: this.runner });
    this.buildAnalyzer = new BuildAnalyzer({ runner: this.runner, buildTimeoutMs: DEFAULT_SCAN_LIMITS.buildTimeoutMs });
    this.testAnalyzer = new TestAnalyzer({ runner: this.runner, testTimeoutMs: DEFAULT_SCAN_LIMITS.testTimeoutMs });

    // Engines
    this.specManager = new SpecificationManager();
    this.taskLedger = new TaskLedger({ repo: this.repo });
    this.stageManager = new StageManager({ repo: this.repo });
    this.acceptanceGate = new AcceptanceGate();
    this.healthEngine = new ProjectHealthEngine();
    this.progressEngine = new ProjectProgressEngine();
    this.riskEngine = new RiskEngine();
    this.regressionDetector = new RegressionDetector();
    this.driftDetector = new DriftDetector();
    this.memoryStore = new ProjectMemoryStore({ repo: this.repo });
    this.adrStore = new AdrStore({ repo: this.repo });
    this.nextActionEngine = new NextActionEngine();

    // AI
    this.providerRegistry = new ProviderRegistry();
    this.mockProvider = new MockAIProvider();
    this.providerRegistry.register(this.mockProvider, { active: true });
    this.#configureProviderFromSettings();
    this.structured = new StructuredRunner({ registry: this.providerRegistry, mockProvider: this.mockProvider });
    this.promptGenerator = new PromptGenerator({ structured: this.structured, memoryStore: this.memoryStore });

    // Orchestration
    this.orchestrator = new Orchestrator({
      repo: this.repo,
      scanner: this.scanner,
      gitAnalyzer: this.gitAnalyzer,
      buildAnalyzer: this.buildAnalyzer,
      testAnalyzer: this.testAnalyzer,
      specManager: this.specManager,
      taskLedger: this.taskLedger,
      stageManager: this.stageManager,
      riskEngine: this.riskEngine,
      healthEngine: this.healthEngine,
      progressEngine: this.progressEngine,
      acceptanceGate: this.acceptanceGate,
      regressionDetector: this.regressionDetector,
      driftDetector: this.driftDetector,
      memoryStore: this.memoryStore,
      nextActionEngine: this.nextActionEngine,
      events: this.events,
      search: this.search,
    });
    this.orchestrator.registerHandlers(this.queue);

    this.aiService = new AIService({
      repo: this.repo,
      structured: this.structured,
      memoryStore: this.memoryStore,
      taskLedger: this.taskLedger,
      orchestratorRef: this.orchestrator,
    });

    this.agentSessions = new AgentSessionService({ repo: this.repo, events: this.events, eventType: EVENT_TYPE.AGENT_SESSION_IMPORTED });
  }

  startBackground() {
    this.queue.start();
    const autostart = this.repo.getSetting('watcher.enabled') !== 'false';
    if (autostart) {
      for (const p of this.repo.list('projects', { archived_at: null })) {
        if (!p.watch_paused) this.watcher.watch(p);
      }
    }
    return this;
  }

  stopBackground() {
    this.queue.stop();
    this.watcher.unwatchAll();
  }

  #configureProviderFromSettings() {
    const kind = this.repo.getSetting('ai.provider');
    if (kind !== 'openai-compatible') return;
    const provider = new OpenAICompatibleProvider({
      name: 'openai-compatible',
      baseUrl: this.repo.getSetting('ai.baseUrl') || process.env.OPENAI_BASE_URL || '',
      apiKey: this.repo.getSetting('ai.apiKey') || process.env.OPENAI_API_KEY || '',
      model: this.repo.getSetting('ai.model') || 'gpt-4o-mini',
    });
    this.providerRegistry.register(provider);
    if (provider.isConfigured()) this.providerRegistry.setActive(provider.name);
  }

  updateProviderSettings(settings) {
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith('ai.')) this.repo.setSetting(k, v);
    }
    if (settings['ai.apiKey'] !== undefined && String(settings['ai.apiKey']).trim() === '') {
      // do not clobber a stored key with an empty string coming from a masked form
      const current = this.repo.getSetting('ai.apiKey');
      if (current) this.repo.setSetting('ai.apiKey', current);
    }
    this.#configureProviderFromSettings();
    if (settings['ai.provider'] === 'mock') this.providerRegistry.setActive('mock');
    return this.providerRegistry.describe();
  }

  // ───────────────────────────── Workspace Registry (#10) ─────────────────────────────

  addProject({ workspacePath, name = null, description = '', ignorePatterns = [], demo = false, category = null }) {
    const abs = expandShortPath(path.resolve(workspacePath));
    if (!fs.existsSync(abs)) throw new WorkspaceError(`workspace path does not exist: ${abs}`, '请选择一个当前存在的本地目录。');
    if (!fs.statSync(abs).isDirectory()) throw new WorkspaceError(`workspace path is not a directory: ${abs}`, '路径指向的是文件，需要选择一个文件夹。');
    const existing = this.repo.list('projects', { workspace_path: toPosix(abs) });
    if (existing.length) throw new ConflictError(`this workspace is already registered`, `「${existing[0].name}」已经管理了 ${abs}。`);

    const project = this.repo.insert('projects', {
      id: newId('prj'),
      name: name || path.basename(abs),
      description,
      workspace_path: toPosix(abs),
      repository_type: fs.existsSync(path.join(abs, '.git')) ? 'git' : 'unknown',
      status: PROJECT_STATUS.PLANNING,
      health: PROJECT_HEALTH.UNKNOWN,
      is_demo: !!demo,
      watch_paused: false,
      ignore_patterns: ignorePatterns,
      category: CATEGORY_KEYS.includes(category) ? category : 'uncategorized',
      category_manual: CATEGORY_KEYS.includes(category) ? 1 : 0,
      metadata: {},
      progress: { value: null, percent: null, reason: '尚未进行任何分析' },
    });
    this.events.record(project.id, EVENT_TYPE.PROJECT_ADDED, `Project added: ${project.name}`, { path: toPosix(abs) });
    if (!project.watch_paused) this.watcher.watch(project);
    return project;
  }

  renameProject(projectId, name) {
    return this.repo.update('projects', projectId, { name });
  }

  setDescription(projectId, description) {
    return this.repo.update('projects', projectId, { description });
  }

  setIgnorePatterns(projectId, patterns) {
    return this.repo.update('projects', projectId, { ignore_patterns: patterns });
  }

  /**
   * Pin a build/test/typecheck command by hand when detection comes up empty — the one
   * executable way out of "该项目没有配置 build 命令". Keys are the detect-command kinds;
   * an empty/absent value clears that kind's override. The stored scanner metadata is updated
   * in place so the detail summary reflects the pin immediately, without waiting for a rescan.
   * Execution still flows through CommandRunner's allowlist, so a pinned command cannot bypass
   * the safety model.
   */
  setManualCommands(projectId, commands) {
    const project = this.getProject(projectId);
    const allowed = ['build', 'lint', 'typecheck', 'test', 'integrationTest', 'e2e'];
    const clean = {};
    for (const k of allowed) {
      const raw = commands && commands[k];
      if (raw === undefined) continue;
      const s = String(raw).trim().slice(0, 400);
      if (s) clean[k] = s;
    }
    const meta = { ...(project.metadata || {}) };
    meta.manualCommands = clean;
    if (meta.metadata && typeof meta.metadata === 'object') {
      meta.metadata = { ...meta.metadata, manualCommands: clean };
    }
    this.repo.update('projects', projectId, { metadata: meta });
    return clean;
  }

  /** Manual 分类 wins over inference until the user clears it back to auto. */
  setCategory(projectId, category) {
    if (category === null || category === '' || category === 'auto') {
      return this.repo.update('projects', projectId, { category_manual: 0 });
    }
    if (!CATEGORY_KEYS.includes(category)) {
      throw new WorkspaceError(`unknown category: ${category}`, `可选分类：${CATEGORY_KEYS.join('、')}`);
    }
    return this.repo.update('projects', projectId, { category, category_manual: 1 });
  }

  /**
   * Repoint a project after its folder moved or was restored elsewhere. Verdicts Commander had
   * cached about the old location are cleared together with the path — keeping them would present
   * conclusions about a directory this record no longer points at.
   */
  setWorkspacePath(projectId, rawPath) {
    const next = expandShortPath(path.resolve(String(rawPath || '').trim()));
    if (!fs.existsSync(next)) throw new WorkspaceError(`目录不存在，无法指向它：${next}`, '项目移动后请填写新的位置；如果不再需要，可以直接删除这条记录。');
    if (!fs.statSync(next).isDirectory()) throw new WorkspaceError(`路径指向的是文件，不是目录：${next}`, '请选择一个文件夹。');
    const clash = this.repo.list('projects', {}).find((p) => p.id !== projectId && toPosix(p.workspace_path) === toPosix(next));
    if (clash) throw new ConflictError(`这个目录已经由「${clash.name}」管理：${next}`, '请先删除重复的那条记录，或换一个位置。');

    const before = this.getProject(projectId);
    this.watcher.unwatch(projectId);
    const updated = this.repo.update('projects', projectId, {
      workspace_path: toPosix(next),
      repository_type: fs.existsSync(path.join(next, '.git')) ? 'git' : 'unknown',
      health: PROJECT_HEALTH.UNKNOWN,
      // An inferred category describes the old folder's contents; a manual one is the user's.
      category: before.category_manual ? before.category : 'uncategorized',
      metadata: {},
      progress: { value: null, percent: null, reason: '路径已更新，尚未重新分析' },
      last_analyzed_at: null,
    });
    this.events.record(projectId, EVENT_TYPE.WORKSPACE_CHANGED, `Workspace path relinked to ${next}`, { from: before.workspace_path, to: toPosix(next) });
    if (!updated.watch_paused) this.watcher.watch(updated);
    return updated;
  }

  /**
   * 失效路径的重新定位计划。只探测磁盘，不写任何东西 —— 返回的是给人确认的提案。
   *
   * Why this exists: when a whole folder tree is moved (Desktop/项目/…), every record breaks at
   * once and the panel answers 9 identical critical rows with no way forward. The honest remedy
   * is to look for where those folders actually are now and offer it, one click per project.
   */
  async relocationPlan() {
    const all = this.repo.list('projects', {});
    const claimed = new Map(all.map((p) => [toPosix(p.workspace_path).toLowerCase(), p.name]));
    const configured = this.#searchRoots();
    const projects = all.filter((p) => !p.archived_at).map((p) => ({ id: p.id, name: p.name, workspacePath: p.workspace_path }));
    const { planRelocations: plan } = await import('./workspace-resolver.js');
    return plan(projects, { roots: configured, claimed });
  }

  /**
   * Apply confirmed relocations. Writes go through `setWorkspacePath` — the same single path a
   * manual edit uses, including its existence check and its clearing of stale verdicts. Nothing
   * here is a second rulebook: one write path, so the two entry points cannot drift.
   */
  async applyRelocations(moves) {
    const results = [];
    for (const move of moves) {
      const projectId = String(move && move.projectId || '');
      const project = this.repo.get('projects', projectId);
      if (!project) { results.push({ projectId, ok: false, reason: '项目记录不存在' }); continue; }
      const target = String(move && move.newPath || '').trim();
      if (!target) { results.push({ projectId, name: project.name, ok: false, reason: '没有给出新路径' }); continue; }
      try {
        this.setWorkspacePath(projectId, target);
        let rescan = null;
        try { await this.orchestrator.quickScan(projectId); rescan = 'ok'; } catch (err) { rescan = err.message; }
        const after = this.repo.get('projects', projectId);
        results.push({
          projectId, name: project.name, ok: true,
          from: toPosix(project.workspace_path), to: toPosix(after.workspace_path),
          onDisk: fs.existsSync(after.workspace_path), quickScan: rescan,
        });
      } catch (err) {
        results.push({ projectId, name: project.name, ok: false, reason: err.message, hint: err.hint || null });
      }
    }
    return {
      applied: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
      at: nowIso(),
    };
  }

  #searchRoots() {
    const raw = this.repo.getSetting('workspace.searchRoots');
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.map(String).slice(0, 12);
    } catch { /* fall back to the default roots */ }
    return null;
  }

  /** Import + classify. Publishing runs in the background: a project must appear in the UI
   * the moment it is added, and a slow or unreachable GitHub must never stall an import —
   * first-run discovery can queue twenty projects at once.
   */
  async addProjectAndClassify(workspacePath, { name = null, description = '', category = null, ignorePatterns = [], awaitPublish = false } = {}) {
    const project = this.addProject({ workspacePath, name, description, category, ignorePatterns });
    try { await this.orchestrator.quickScan(project.id); } catch { /* 分类留给后续完整分析 */ }
    const publish = this.publishToGithub(project.id, { silent: true }).catch(() => null);
    if (awaitPublish) await publish;
    return this.getProject(project.id);
  }

  githubSettings() {
    return {
      'github.token': this.repo.getSetting('github.token') || '',
      'github.enabled': this.repo.getSetting('github.enabled') || '',
      'github.owner': this.repo.getSetting('github.owner') || '',
    };
  }

  /**
   * Create the user's private repository and push the project to it.
   *
   * The token reaches git only through GIT_CONFIG_* env vars, so it never lands in argv,
   * in the command history, in the database, or in the project's own .git/config.
   */
  async publishToGithub(projectId, { silent = false } = {}) {
    const project = this.getProject(projectId);
    const settings = this.githubSettings();
    const token = settings['github.token'];
    const enabled = settings['github.enabled'] === 'true';

    if (!token || !enabled) {
      const result = {
        ok: false,
        stage: 'disabled',
        reason: !token ? '未配置 GitHub 令牌，无法自动上传。' : 'GitHub 自动上传已在设置中关闭。',
        at: nowIso(),
      };
      if (!silent) this.#rememberGithub(projectId, result);
      return result;
    }

    const { publishProject, gitAuthEnv, validateToken } = await import('./github-publisher.js');
    // A commit needs an author, and many machines have no global user.name/user.email.
    // Derive one from the GitHub account instead of failing the import.
    let owner = settings['github.owner'];
    if (!owner) {
      const who = await validateToken({ settings });
      if (who.ok) {
        owner = who.username;
        this.repo.setSetting('github.owner', owner);
      } else {
        const blocked = { ok: false, stage: 'no-token', reason: who.reason, at: nowIso() };
        this.#rememberGithub(projectId, blocked);
        return blocked;
      }
    }
    const identity = { name: owner, email: `${owner}@users.noreply.github.com` };
    settings['github.owner'] = owner;
    const runner = this.runner;
    const result = await publishProject({
      project,
      cwd: project.workspace_path,
      name: project.name,
      description: project.description,
      identity,
      settings,
      repo: this.repo,
      logger: logger.child('github'),
      // Auth and commit identity live in different env namespaces, so they merge cleanly.
      // Spreading the request's own env last is what keeps prepareRepository's GIT_AUTHOR_*
      // vars alive — replacing env outright silently breaks every commit.
      // Bounded well under the publisher's 120s default: an upload that can't reach
      // GitHub should report a reason quickly, not occupy the queue for two minutes.
      timeoutMs: 45000,
      git: { run: (req) => runner.run({ ...req, env: { ...gitAuthEnv(token), ...(req.env || {}) } }) },
      files: {
        async exists(dir, file) { return fs.existsSync(path.join(dir, file)); },
        async createIfMissing(dir, file, content) {
          const full = path.join(dir, file);
          if (fs.existsSync(full)) return { ok: true, created: false };
          fs.writeFileSync(full, content, 'utf8');
          return { ok: true, created: true };
        },
      },
    });
    this.#rememberGithub(projectId, result);
    return result;
  }

  #rememberGithub(projectId, result) {
    const stored = this.repo.get('projects', projectId);
    if (!stored) return;
    const meta = stored.metadata || {};
    // The publisher's result is already token-free; spread it verbatim.
    this.repo.update('projects', projectId, { metadata: { ...meta, github: { ...result, attemptedAt: nowIso() } } });
  }

  /** What a source-purging delete *would* remove, with every blocker surfaced. */
  assessDeletion(projectId) {
    const project = this.getProject(projectId);
    const assessed = assessPurgeTarget(project.workspace_path, { ownDataDir: this.dataDir });
    return {
      projectId,
      projectName: project.name,
      workspacePath: project.workspace_path,
      recordOnlyIsAlwaysSafe: true,
      ...assessed,
      humanSize: formatBytes(assessed.totalBytes || 0),
    };
  }

  /**
   * Delete the Commander record, and optionally wipe the source directory as well.
   *
   * ADR-009 keeps the *analysis* pipeline read-only toward workspaces; this is the one
   * user-initiated exception, so it requires the caller to echo back the folder name.
   */
  deleteProject(projectId, { purgeSource = false, confirmToken = null } = {}) {
    const project = this.getProject(projectId);
    let purge = null;
    if (purgeSource) {
      const assessed = assessPurgeTarget(project.workspace_path, { ownDataDir: this.dataDir });
      if (!assessed.ok) {
        throw new WorkspaceError(`拒绝删除源文件：${assessed.reason}`, `路径 ${assessed.display || project.workspace_path}`);
      }
      purge = purgeDirectory(assessed, { confirmToken });
    }
    const stats = this.deleteProjectRecord(projectId);
    return { ...stats, sourcePurged: purge };
  }

  /** 这台电脑上有哪些项目 — walk the search roots and report every project directory. */
  discover({ roots = null, maxDepth = 3, limit = 300 } = {}) {
    let configured = roots;
    if (!configured) {
      const raw = this.repo.getSetting('workspace.searchRoots');
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length) configured = arr.map(String).slice(0, 12);
        } catch { /* fall through to defaults */ }
      }
    }
    const rootsUsed = (configured && configured.length ? configured : defaultRoots()).map((r) => path.resolve(r));
    const managed = new Set(this.repo.list('projects', {}).map((p) => toPosix(p.workspace_path).toLowerCase()));
    const result = scanDiskForProjects({
      roots: rootsUsed,
      maxDepth: Number(maxDepth) || 3,
      limit: Number(limit) || 300,
      isManaged: (abs) => managed.has(toPosix(abs).toLowerCase()),
    });
    return { ...result, configuredRoots: rootsUsed.map(toPosix), usingDefaults: !configured || !configured.length };
  }

  pauseWatch(projectId) {
    this.watcher.unwatch(projectId);
    return this.repo.update('projects', projectId, { watch_paused: true });
  }

  resumeWatch(projectId) {
    const p = this.repo.get('projects', projectId);
    if (!p) throw new NotFoundError('project', projectId);
    this.repo.update('projects', projectId, { watch_paused: false });
    return this.watcher.watch(this.repo.get('projects', projectId));
  }

  archiveProject(projectId) {
    this.watcher.unwatch(projectId);
    this.events.record(projectId, EVENT_TYPE.PROJECT_ARCHIVED, 'Project archived', {});
    return this.repo.update('projects', projectId, { archived_at: nowIso(), status: PROJECT_STATUS.ARCHIVED, watch_paused: true });
  }

  unarchiveProject(projectId) {
    return this.repo.update('projects', projectId, { archived_at: null, status: PROJECT_STATUS.PLANNING, watch_paused: false });
  }

  /**
   * Remove the Commander record ONLY. The real source directory is never touched (ADR-009).
   */
  deleteProjectRecord(projectId) {
    const project = this.repo.get('projects', projectId);
    if (!project) throw new NotFoundError('project', projectId);
    this.watcher.unwatch(projectId);
    const stats = {
      sourceDirectoryUntouched: project.workspace_path,
      deletedRecords: {
        tasks: this.repo.count('tasks', { project_id: projectId }),
        risks: this.repo.count('risks', { project_id: projectId }),
        snapshots: this.repo.count('project_snapshots', { project_id: projectId }),
        prompts: this.repo.count('prompts', { project_id: projectId }),
        events: this.repo.count('project_events', { project_id: projectId }),
      },
    };
    this.events.record(projectId, EVENT_TYPE.NOTE, 'Project record deleted (source directory untouched)', stats);
    for (const table of ['acceptance_criteria', 'specifications', 'tasks', 'stages', 'milestones', 'risks', 'regressions', 'health_results', 'project_snapshots', 'git_snapshots', 'build_results', 'test_case_results', 'test_runs', 'prompts', 'executions', 'agent_sessions', 'project_memory', 'architecture_decisions', 'artifacts', 'analysis_jobs', 'evidence_refs']) {
      this.repo.removeWhere(table, { project_id: projectId });
    }
    this.repo.remove('projects', projectId);
    return stats;
  }

  /**
   * Derive 分类 / 用途 / 建议 for projects scanned before those features existed, using
   * only the metadata already in the database. Runs at startup so the dashboard is
   * populated the moment the app opens — no manual re-scan required.
   */
  backfillClassification() {
    let touched = 0;
    for (const project of this.repo.list('projects', {})) {
      const meta = project.metadata || {};
      const scan = meta.metadata;
      if (!scan || scan.ok !== true || meta.classification) continue;
      const specs = this.repo.list('specifications', { project_id: project.id });
      const classification = classifyProject(scan, { manualCategory: project.category_manual ? project.category : null, specs });
      const runs = ['unit', 'integration', 'e2e'].map((k) => meta.tests && meta.tests[k]).filter(Boolean)
        .reduce((worst, r) => ((r.failed || 0) > (worst?.failed || 0) ? r : worst), null) || {};
      const suggestions = buildSuggestions({
        project,
        meta: scan,
        git: meta.git || null,
        build: meta.build || null,
        gate: meta.gate || null,
        health: meta.health || null,
        drift: meta.drift || null,
        risks: this.repo.list('risks', { project_id: project.id }),
        regressions: this.repo.list('regressions', { project_id: project.id }),
        tasks: this.taskLedger.summary(project.id),
        specs,
        prompts: this.repo.list('prompts', { project_id: project.id }),
        testRuns: {
          status: runs.status || 'unknown',
          total: runs.total || 0,
          failed: runs.failed || 0,
          command: runs.command || '',
        },
      });
      this.repo.update('projects', project.id, {
        category: classification.category,
        category_manual: classification.manual ? 1 : 0,
        metadata: {
          ...meta,
          classification,
          purpose: identifyPurpose(scan, { specs, project }),
          suggestions,
          suggestionSummary: summarizeSuggestions(suggestions),
          suggestedAt: nowIso(),
        },
      });
      touched += 1;
    }
    return touched;
  }

  listProjects({ includeArchived = false } = {}) {
    const rows = this.repo.list('projects', {}, { orderBy: 'updated_at DESC' });
    return includeArchived ? rows : rows.filter((p) => !p.archived_at);
  }

  getProject(projectId) {
    const p = this.repo.get('projects', projectId);
    if (!p) throw new NotFoundError('project', projectId);
    return p;
  }

  // ───────────────────────────── Demo Mode (#50) ─────────────────────────────

  seedDemoProjects({ rebuild = false } = {}) {
    const base = path.join(this.dataDir, 'demo-projects');
    fs.mkdirSync(base, { recursive: true });
    if (rebuild) {
      for (const def of demoProjectDefinitions(base)) {
        for (const p of this.repo.list('projects', { workspace_path: toPosix(def.dir) })) this.deleteProjectRecord(p.id);
      }
    }
    const created = ensureDemoProjects(base);
    const out = [];
    for (const def of created) {
      const existing = this.repo.list('projects', { workspace_path: toPosix(def.dir) })[0];
      if (existing) { out.push({ project: existing, alreadyPresent: true }); continue; }
      const project = this.addProject({ workspacePath: def.dir, name: def.name, description: def.description, demo: true });
      for (const adr of AdrStore.seedFromProject({ ...project, primaryLanguage: 'unknown', framework: 'unknown', packageManager: 'unknown' })) {
        this.adrStore.create(project.id, adr);
      }
      out.push({ project, alreadyPresent: false });
    }
    return out;
  }

  async seedDemoAndAnalyze({ rebuild = false, runCommands = true } = {}) {
    const seeded = this.seedDemoProjects({ rebuild });
    const results = [];
    for (const s of seeded) {
      if (s.alreadyPresent) { results.push({ projectId: s.project.id, skipped: true }); continue; }
      const r = await this.orchestrator.fullScan(s.project.id, { runCommands, suites: ['unit', 'integration', 'e2e'] });
      this.queue.enqueue({ projectId: s.project.id, type: 'ai_analysis', payload: { projectId: s.project.id }, priority: 6, timeoutMs: 60000 });
      results.push({ projectId: s.project.id, health: r.health.status, gate: r.gate.result, files: r.metadata.fileCount });
    }
    await this.queue.drain({ timeoutMs: 30000 });
    return results;
  }

  // ───────────────────────────── Aggregations (Dashboard/Attention) ─────────────────────────────

  dashboard() {
    const projects = this.listProjects();
    const counts = { total: projects.length, healthy: 0, warning: 0, critical: 0, unknown: 0, blocked: 0, missing: 0, archived: this.repo.list('projects', {}).filter((p) => p.archived_at).length };
    for (const p of projects) {
      // A folder that no longer exists cannot be assessed, so no cached health verdict applies.
      // It counts as critical — the same way attentionCenter reports it — instead of inheriting
      // an old colour that would claim the workspace was read.
      if (!fs.existsSync(p.workspace_path)) { counts.critical += 1; counts.missing += 1; }
      else counts[p.health] = (counts[p.health] || 0) + 1;
      if (p.status === PROJECT_STATUS.BLOCKED) counts.blocked += 1;
    }
    const cards = projects.map((p) => this.projectCard(p));
    return { counts, cards, generatedAt: nowIso() };
  }

  projectCard(project) {
    const meta = project.metadata || {};
    // One source of truth for what is known right now: when the folder is gone, cached
    // classification/purpose/advice is dropped rather than presented as a current verdict.
    const view = this.suggestionsView(project);
    const tasks = this.repo.list('tasks', { project_id: project.id });
    const risks = this.repo.list('risks', { project_id: project.id });
    const regressions = this.repo.list('regressions', { project_id: project.id }, { orderBy: 'ts DESC', limit: 5 });
    return {
      id: project.id,
      name: project.name,
      workspacePath: project.workspace_path,
      description: project.description,
      status: project.status,
      // A colour computed from files we can no longer read is not a current verdict.
      health: view.workspaceMissing ? PROJECT_HEALTH.UNKNOWN : project.health,
      isDemo: !!project.is_demo,
      watchPaused: !!project.watch_paused,
      currentStage: (meta.stages && meta.stages.current) || meta.currentStageName || (this.repo.get('stages', project.current_stage_id || '') || {}).name || null,
      progress: project.progress || meta.progress || { value: null, reason: 'not computed' },
      build: meta.build || null,
      unit: (meta.tests && meta.tests.unit) || null,
      e2e: (meta.tests && meta.tests.e2e) || null,
      integration: (meta.tests && meta.tests.integration) || null,
      git: meta.git ? { isRepository: meta.git.isRepository, branch: meta.git.branch, head: meta.git.commitShort, clean: meta.git.workingTreeClean, changed: meta.git.changedFileCount, untracked: (meta.git.untracked || []).length } : null,
      gate: meta.gate || null,
      drift: meta.drift ? { verdict: meta.drift.verdict, count: (meta.drift.drifts || []).length } : null,
      lastActivity: this.events.lastActivity(project.id) || project.updated_at,
      lastAnalyzedAt: project.last_analyzed_at,
      nextAction: meta.nextAction || null,
      category: project.category || 'uncategorized',
      categoryLabel: categoryLabel(project.category),
      categoryManual: !!project.category_manual,
      classification: view.classification,
      purpose: view.purpose,
      suggestionSummary: view.summary,
      suggestionCount: view.suggestions.length,
      taskSummary: { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length, blocked: tasks.filter((t) => t.status === 'blocked').length },
      riskSummary: riskSummary(risks),
      regressionSummary: regressionSummary(regressions),
      primaryLanguage: project.primary_language,
      framework: project.framework,
      // A folder can be moved or deleted outside Commander. Stale verdicts must never be
      // presented as current, so the UI needs to know the workspace is unreadable now.
      workspaceMissing: view.workspaceMissing,
    };
  }

  /**
   * Cached verdicts are claims about the last state Commander actually read. Once the folder is
   * gone, replaying the old list would present advice about a directory that no longer exists,
   * so the panel reports the one thing that is true now.
   */
  suggestionsView(project) {
    const meta = project.metadata || {};
    const base = {
      projectId: project.id,
      category: project.category,
      classification: meta.classification || null,
      purpose: meta.purpose || null,
      suggestions: meta.suggestions || [],
      summary: meta.suggestionSummary || null,
      generatedAt: meta.suggestedAt || null,
      workspaceMissing: false,
    };
    if (fs.existsSync(project.workspace_path)) return base;
    return {
      ...base,
      classification: null,
      purpose: null,
      summary: null,
      generatedAt: null,
      workspaceMissing: true,
      suggestions: [{
        id: 'workspace-missing',
        title: '项目目录已不存在，无法给出当前的优化建议',
        why: `Commander 只根据真实读到的文件下结论。${project.workspace_path} 现在不在磁盘上，之前缓存的 ${base.suggestions.length} 条建议描述的是 ${project.last_analyzed_at || '未知时间'} 的状态，继续展示会误导。`,
        action: '如果项目只是移动了位置，请在项目详情页的「设置」标签里改成新路径后重新分析；如果已经不需要了，可以直接删除这条记录。',
        evidence: `workspace_path=${project.workspace_path} 不存在；上次分析时间 ${project.last_analyzed_at || '无记录'}`,
        impact: 'high', effort: 'low', area: '整理',
      }],
    };
  }

  attentionCenter() {
    const items = [];
    for (const project of this.listProjects()) {
      const card = this.projectCard(project);
      // When Commander observed this. Each item prefers the timestamp of the record that
      // triggered it; the analysis time is the honest floor, never a made-up age.
      const observed = project.last_analyzed_at || card.lastActivity || project.updated_at || null;
      if (card.workspaceMissing) {
        items.push({ projectId: project.id, projectName: project.name, kind: 'workspace_missing', severity: 'critical', at: observed, title: `${project.name}：项目目录已不存在`, detail: `${project.workspace_path} —— 面板上的结论来自 ${project.last_analyzed_at ? '上次分析的缓存' : '从未成功分析'}，不代表磁盘现状。` });
        continue;
      }
      const health = project.metadata && project.metadata.health;
      if (card.health === PROJECT_HEALTH.CRITICAL) {
        items.push({ projectId: project.id, projectName: project.name, kind: 'critical_health', severity: 'critical', at: (health && health.ts) || observed, title: `${project.name} 处于危急状态`, detail: (health && health.reasons || []).slice(0, 2).map((r) => r.message).join(' ') || '健康状态为危急。' });
      }
      if (card.build && (card.build.status === 'fail' || card.build.status === 'timeout')) {
        items.push({ projectId: project.id, projectName: project.name, kind: 'build_fail', severity: 'critical', at: card.build.ts || observed, title: `${project.name}：构建${card.build.status === 'fail' ? '失败' : '超时'}`, detail: card.build.command || '' });
      }
      for (const suite of ['unit', 'e2e', 'integration']) {
        const run = card[suite];
        if (!run) continue;
        const suiteZh = SUITE_LABEL_ZH[suite] || suite;
        if (run.status === 'fail' && run.total > 0) {
          items.push({ projectId: project.id, projectName: project.name, kind: 'test_fail', severity: 'high', at: run.ts || observed, title: `${project.name}：${suiteZh} ${run.failed}/${run.total} 个用例失败`, detail: run.command || '' });
        } else if (run.status === 'fail' || run.status === 'error') {
          // The command exited badly without a parseable summary, so no test result is
          // known. Reporting "0/0 failing" would assert a fact the evidence contradicts.
          items.push({ projectId: project.id, projectName: project.name, kind: 'test_error', severity: 'medium', at: run.ts || observed, title: `${project.name}：${suiteZh} 执行异常，未能解析出用例结果`, detail: run.command || '' });
        }
      }
      if (card.regressionSummary.count) {
        items.push({ projectId: project.id, projectName: project.name, kind: 'regression', severity: 'high', at: card.regressionSummary.latestTs || observed, title: `${project.name}：${card.regressionSummary.count} 项回归`, detail: `最严重程度：${card.regressionSummary.worst}` });
      }
      if (card.taskSummary.blocked) {
        items.push({ projectId: project.id, projectName: project.name, kind: 'blocked_task', severity: 'high', at: observed, title: `${project.name}：${card.taskSummary.blocked} 个任务被阻塞`, detail: '' });
      }
      if (card.git && !card.git.clean && (card.git.changed + card.git.untracked) > 25) {
        items.push({ projectId: project.id, projectName: project.name, kind: 'dirty_workspace', severity: 'medium', at: observed, title: `${project.name}：${card.git.changed + card.git.untracked} 个文件未提交`, detail: '' });
      }
      const openRisks = card.riskSummary.bySeverity.critical + card.riskSummary.bySeverity.high;
      if (openRisks > 0) {
        items.push({ projectId: project.id, projectName: project.name, kind: 'risk', severity: card.riskSummary.bySeverity.critical ? 'critical' : 'high', at: card.riskSummary.latestOpenAt || observed, title: `${project.name}：${openRisks} 个高危或危急风险`, detail: '' });
      }
      if (card.drift && card.drift.verdict === 'possible_drift') {
        items.push({ projectId: project.id, projectName: project.name, kind: 'drift', severity: 'medium', at: observed, title: `${project.name}：可能存在规范漂移`, detail: `${card.drift.count} 个信号` });
      }
      const pendingReview = this.repo.list('prompts', { project_id: project.id, status: 'generated' });
      if (pendingReview.length) {
        const newest = pendingReview.map((p) => p.created_at).filter(Boolean).sort().pop();
        items.push({ projectId: project.id, projectName: project.name, kind: 'pending_review', severity: 'low', at: newest || observed, title: `${project.name}：${pendingReview.length} 条已生成提示词尚未执行`, detail: '' });
      }
    }
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    return { items: items.sort((a, b) => rank[a.severity] - rank[b.severity]), generatedAt: nowIso() };
  }

  securityModel() {
    return {
      commandRunner: describeSecurityModel(),
      transport: {
        bind: '127.0.0.1 only —— 非回环的 --host 直接拒绝启动（src/server/cli.js）',
        hostAllowlist: 'Host 必须是 127.0.0.1 / localhost / [::1] 加上本机实际监听端口；判据用 req.socket.localPort，不拿请求自带的 Host 去对照 Origin（那是 DNS rebinding 的成因）',
        originPolicy: '带 Origin 或 Referer 的请求必须与本服务同源同端口；跨源写入一律 403。没有 access-control-allow-origin：这个 API 不向任何第三方页面开放',
        localToken: process.env.COMMANDER_LOCAL_TOKEN
          ? '已启用：非 GET 请求必须带 x-commander-token / Authorization: Bearer / ?token=，用 timingSafeEqual 比对；令牌镜像在数据目录 local-token.txt（0600）'
          : '未启用：设置环境变量 COMMANDER_LOCAL_TOKEN 后，所有非 GET 请求都要带本机令牌（浏览器界面不受影响，它本来就是同源）',
        decisionFunction: 'src/server/local-guard.js:guardRequest —— 一处判定，测试见 tests/integration/local-guard.test.js',
      },
      sensitiveFiles: {
        policy: '敏感文件的内容绝不会被读取、存储、记录日志或发送给任何 AI 提供方。',
        patterns: SENSITIVE_PATTERNS.map((p) => ({ pattern: p.pattern, rule: p.rule })),
      },
      managedWorkspace: '只读 —— Commander 没有任何向受管工作区写入的代码路径（ADR-009）。',
      aiDataBoundary: '仅发送路径、计数、统计、少量片段与失败信息。密钥在发送前会被脱敏。',
      secretsStorage: 'API 密钥保存在本地 SQLite 的设置表中，绝不会回传给前端。',
    };
  }

  systemInfo() {
    return {
      version: '0.9.0',
      nodeVersion: process.version,
      platform: process.platform,
      dataDir: toPosix(this.dataDir),
      dbFile: toPosix(this.dbFile),
      ftsAvailable: this.db.ftsAvailable,
      os: `${os.type()} ${os.release()}`,
      queue: this.queue.stats(),
      watcher: this.watcher.status(),
      providers: this.providerRegistry.describe(),
      aiStats: this.structured.describeStats(),
      search: this.search.describe(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  close() {
    this.stopBackground();
    this.db.close();
  }
}

export { openDatabase, Repository };
