/**
 * Versioned SQL migrations. Never "drop & recreate" to upgrade (requirement #53).
 * Each migration is append-only; once shipped, never edit — add a new one.
 */

export const MIGRATIONS = [
  {
    version: 1,
    name: 'core_domain_model',
    up: [
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        workspace_path TEXT NOT NULL UNIQUE,
        repository_type TEXT NOT NULL DEFAULT 'unknown',
        primary_language TEXT NOT NULL DEFAULT 'unknown',
        framework TEXT NOT NULL DEFAULT 'unknown',
        package_manager TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'planning',
        health TEXT NOT NULL DEFAULT 'unknown',
        current_stage_id TEXT,
        progress_json TEXT NOT NULL DEFAULT '{"value":null,"reason":"not computed"}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_analyzed_at TEXT,
        archived_at TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        watch_paused INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        ignore_patterns_json TEXT NOT NULL DEFAULT '[]'
      );`,

      `CREATE TABLE IF NOT EXISTS stages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'not_started',
        order_index INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        confidence TEXT NOT NULL DEFAULT 'unknown',
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        due_at TEXT,
        created_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'p2',
        status TEXT NOT NULL DEFAULT 'todo',
        source TEXT NOT NULL DEFAULT 'manual',
        confidence TEXT NOT NULL DEFAULT 'unknown',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        fingerprint TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS specifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'other',
        title TEXT NOT NULL DEFAULT '',
        parsed_json TEXT NOT NULL DEFAULT '{}',
        content_hash TEXT NOT NULL DEFAULT '',
        byte_size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, path)
      );`,

      `CREATE TABLE IF NOT EXISTS acceptance_criteria (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage_id TEXT,
        spec_id TEXT,
        requirement_ref TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'statement',
        status TEXT NOT NULL DEFAULT 'unknown',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS agent_providers (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'generic_cli',
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'manual',
        adapter TEXT NOT NULL DEFAULT 'manual_import',
        external_id TEXT NOT NULL DEFAULT '',
        is_mock INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unknown',
        summary TEXT NOT NULL DEFAULT '',
        transcript_excerpt TEXT NOT NULL DEFAULT '',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        execution_result_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage_id TEXT,
        next_action_id TEXT,
        agent_key TEXT NOT NULL DEFAULT 'generic_cli',
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        expected_result TEXT NOT NULL DEFAULT '',
        actual_result TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'generated',
        provider TEXT NOT NULL DEFAULT 'mock',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        prompt_id TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        started_at TEXT,
        finished_at TEXT,
        result_summary TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS git_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        is_repository INTEGER NOT NULL DEFAULT 0,
        git_available INTEGER NOT NULL DEFAULT 1,
        branch TEXT NOT NULL DEFAULT '',
        commit_hash TEXT NOT NULL DEFAULT '',
        commit_subject TEXT NOT NULL DEFAULT '',
        commit_time TEXT NOT NULL DEFAULT '',
        working_tree_clean INTEGER NOT NULL DEFAULT 1,
        modified_json TEXT NOT NULL DEFAULT '[]',
        added_json TEXT NOT NULL DEFAULT '[]',
        deleted_json TEXT NOT NULL DEFAULT '[]',
        untracked_json TEXT NOT NULL DEFAULT '[]',
        renamed_json TEXT NOT NULL DEFAULT '[]',
        diff_summary_json TEXT NOT NULL DEFAULT '{}',
        recent_commits_json TEXT NOT NULL DEFAULT '[]',
        error TEXT NOT NULL DEFAULT ''
      );`,

      `CREATE TABLE IF NOT EXISTS build_results (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'build',
        command TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        exit_code INTEGER,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        stdout_summary TEXT NOT NULL DEFAULT '',
        stderr_summary TEXT NOT NULL DEFAULT '',
        truncated INTEGER NOT NULL DEFAULT 0,
        unsupported_reason TEXT NOT NULL DEFAULT '',
        ts TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS test_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        suite TEXT NOT NULL DEFAULT 'unit',
        framework TEXT NOT NULL DEFAULT 'unknown',
        command TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unknown',
        total INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        parse_confidence TEXT NOT NULL DEFAULT 'unknown',
        raw_tail TEXT NOT NULL DEFAULT '',
        ts TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS test_case_results (
        id TEXT PRIMARY KEY,
        test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        suite TEXT NOT NULL DEFAULT 'unit',
        name TEXT NOT NULL,
        file TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unknown',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT NOT NULL DEFAULT ''
      );`,

      `CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'bug',
        severity TEXT NOT NULL DEFAULT 'medium',
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        source TEXT NOT NULL DEFAULT 'manual',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS risks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'low',
        description TEXT NOT NULL DEFAULT '',
        suggested_action TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        source TEXT NOT NULL DEFAULT 'deterministic',
        confidence TEXT NOT NULL DEFAULT 'high',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        fingerprint TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS regressions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        title TEXT NOT NULL DEFAULT '',
        before_json TEXT NOT NULL DEFAULT '{}',
        after_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        suggested_action TEXT NOT NULL DEFAULT '',
        acknowledged INTEGER NOT NULL DEFAULT 0
      );`,

      `CREATE TABLE IF NOT EXISTS health_results (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        score INTEGER NOT NULL DEFAULT 0,
        reasons_json TEXT NOT NULL DEFAULT '[]'
      );`,

      `CREATE TABLE IF NOT EXISTS project_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        git_json TEXT NOT NULL DEFAULT '{}',
        build_json TEXT NOT NULL DEFAULT '{}',
        unit_json TEXT NOT NULL DEFAULT '{}',
        integration_json TEXT NOT NULL DEFAULT '{}',
        e2e_json TEXT NOT NULL DEFAULT '{}',
        task_summary_json TEXT NOT NULL DEFAULT '{}',
        risk_summary_json TEXT NOT NULL DEFAULT '{}',
        stage_id TEXT,
        stage_name TEXT NOT NULL DEFAULT '',
        health TEXT NOT NULL DEFAULT 'unknown',
        progress_json TEXT NOT NULL DEFAULT '{}',
        gate_json TEXT NOT NULL DEFAULT '{}',
        file_fingerprint TEXT NOT NULL DEFAULT '',
        file_count INTEGER NOT NULL DEFAULT 0
      );`,

      `CREATE TABLE IF NOT EXISTS project_memory (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content_json TEXT NOT NULL DEFAULT '{}',
        author TEXT NOT NULL DEFAULT 'system',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(project_id, version)
      );`,

      `CREATE TABLE IF NOT EXISTS architecture_decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        context TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT '',
        consequences TEXT NOT NULL DEFAULT '',
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'file',
        name TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS project_events (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );`,

      `CREATE TABLE IF NOT EXISTS evidence_refs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_table TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ref TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS analysis_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 5,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        timeout_ms INTEGER NOT NULL DEFAULT 600000,
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );`,

      `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
       CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status);
       CREATE INDEX IF NOT EXISTS idx_stages_project ON stages(project_id, order_index);
       CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id, severity);
       CREATE INDEX IF NOT EXISTS idx_events_project ON project_events(project_id, ts);
       CREATE INDEX IF NOT EXISTS idx_snapshots_project ON project_snapshots(project_id, seq);
       CREATE INDEX IF NOT EXISTS idx_testruns_project ON test_runs(project_id, suite, ts);
       CREATE INDEX IF NOT EXISTS idx_builds_project ON build_results(project_id, kind, ts);
       CREATE INDEX IF NOT EXISTS idx_regressions_project ON regressions(project_id, ts);
       CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id, created_at);
       CREATE INDEX IF NOT EXISTS idx_jobs_status ON analysis_jobs(status, priority);
       CREATE INDEX IF NOT EXISTS idx_evidence_owner ON evidence_refs(owner_table, owner_id);
       CREATE INDEX IF NOT EXISTS idx_ac_project ON acceptance_criteria(project_id);`,
    ],
  },
];

/**
 * v3: `regressions.fingerprint` was missing from the initial schema, which made the
 * "do not record the same regression twice" guard impossible. Migrations are append-only,
 * so this is added as a new version rather than by editing v1 (requirement #53).
 */
export const MIGRATION_3 = {
  version: 3,
  name: 'regression_fingerprint',
  up: [
    `ALTER TABLE regressions ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';`,
    `CREATE INDEX IF NOT EXISTS idx_regressions_fp ON regressions(project_id, fingerprint);`,
    `CREATE INDEX IF NOT EXISTS idx_evidence_type ON evidence_refs(project_id, type);`,
  ],
};

/**
 * v4: 项目分类 (category) must be a real column, not metadata — the Projects view groups
 * and filters on it, and a user-set category must survive re-analysis.
 */
export const MIGRATION_4 = {
  version: 4,
  name: 'project_category',
  up: [
    `ALTER TABLE projects ADD COLUMN category TEXT NOT NULL DEFAULT 'uncategorized';`,
    `ALTER TABLE projects ADD COLUMN category_manual INTEGER NOT NULL DEFAULT 0;`,
    `CREATE INDEX IF NOT EXISTS idx_projects_category ON projects(category);`,
  ],
};

/**
 * v5: 分析队列要能报告进度。
 *
 * A scan that runs for minutes with no signal is indistinguishable from one that hung, so the
 * queue persists which step it is on. `started_at` already exists; the missing piece is the
 * step label, which has to survive a page reload — hence a column, not in-memory state.
 */
export const MIGRATION_5 = {
  version: 5,
  name: 'job_progress',
  up: [
    `ALTER TABLE analysis_jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}';`,
  ],
};

/**
 * v6: 命令执行的信任闸门。
 *
 * A full scan runs the build/test commands it *detects*, which for a folder someone else
 * maintained means running their package.json. The column makes that a recorded decision
 * instead of a default: new imports land at 0 (analysis only), and the rows that already
 * existed when this shipped are marked trusted with `trusted_source='migration'` — they were
 * chosen by this person on this machine, and silently switching every tracked project (and
 * Commander's own self-scan) to "no build, no tests" would be a change nobody agreed to.
 * That backfill is the whole origin of the existing trust; see src/core/trust.js.
 */
export const MIGRATION_6 = {
  version: 6,
  name: 'project_command_trust',
  up: [
    `ALTER TABLE projects ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;`,
    `ALTER TABLE projects ADD COLUMN trusted_at TEXT;`,
    `ALTER TABLE projects ADD COLUMN trusted_source TEXT;`,
    `UPDATE projects SET trusted = 1, trusted_source = 'migration' WHERE trusted = 0;`,
    `CREATE INDEX IF NOT EXISTS idx_projects_trusted ON projects(trusted);`,
  ],
};

/** FTS5 is optional — probed at runtime, with LIKE fallback (KNOWN_ISSUES TODO-P2-005). */
export const FTS_MIGRATION = {
  version: 2,
  name: 'search_index_fts5',
  up: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        project_id UNINDEXED, entity_table UNINDEXED, entity_id UNINDEXED,
        title, body, tokenize='unicode61'
     );`,
  ],
};

export function allMigrations({ ftsAvailable }) {
  const core = [...MIGRATIONS, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6];
  return ftsAvailable ? [...MIGRATIONS, FTS_MIGRATION, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6] : core;
}
