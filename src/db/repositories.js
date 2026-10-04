/**
 * Repository layer — the only place that knows SQL column shapes.
 * All queries parameterized (no string interpolation of values).
 */
import { CommanderError } from '../domain/errors.js';
import { newId, nowIso } from '../core/util.js';

class RepoError extends CommanderError {
  constructor(message) {
    super(message, { code: 'repository_error', status: 500, expose: false });
  }
}

/** json columns are stored as TEXT and transparently (de)serialized. */
const JSON_COLS = {
  projects: ['progress_json', 'metadata_json', 'ignore_patterns_json'],
  specifications: ['parsed_json'],
  tasks: ['evidence_json'],
  acceptance_criteria: ['evidence_json'],
  agent_providers: ['config_json'],
  agent_sessions: ['changed_files_json', 'execution_result_json'],
  prompts: ['evidence_json'],
  executions: ['evidence_json'],
  git_snapshots: ['modified_json', 'added_json', 'deleted_json', 'untracked_json', 'renamed_json', 'diff_summary_json', 'recent_commits_json'],
  issues: ['evidence_json'],
  risks: ['evidence_json'],
  regressions: ['before_json', 'after_json', 'evidence_json'],
  health_results: ['reasons_json'],
  project_snapshots: ['git_json', 'build_json', 'unit_json', 'integration_json', 'e2e_json', 'task_summary_json', 'risk_summary_json', 'progress_json', 'gate_json'],
  project_memory: ['content_json'],
  artifacts: ['meta_json'],
  project_events: ['payload_json'],
  analysis_jobs: ['payload_json', 'result_json', 'progress_json'],
};

/** boolean columns stored as INTEGER 0/1. */
const BOOL_COLS = {
  projects: ['is_demo', 'watch_paused'],
  git_snapshots: ['is_repository', 'git_available', 'working_tree_clean'],
  build_results: ['truncated'],
  agent_sessions: ['is_mock'],
  regressions: ['acknowledged'],
  agent_providers: ['enabled'],
};

export const TABLES = Object.freeze(Object.keys({
  projects: 1, stages: 1, milestones: 1, tasks: 1, specifications: 1, acceptance_criteria: 1,
  agent_providers: 1, agent_sessions: 1, prompts: 1, executions: 1, git_snapshots: 1,
  build_results: 1, test_runs: 1, test_case_results: 1, issues: 1, risks: 1, regressions: 1,
  health_results: 1, project_snapshots: 1, project_memory: 1, architecture_decisions: 1,
  artifacts: 1, project_events: 1, evidence_refs: 1, analysis_jobs: 1,
}));

const ID_PREFIX = {
  projects: 'prj', stages: 'stg', milestones: 'mls', tasks: 'tsk', specifications: 'spc',
  acceptance_criteria: 'acc', agent_providers: 'agp', agent_sessions: 'ags', prompts: 'prm',
  executions: 'exe', git_snapshots: 'gts', build_results: 'bld', test_runs: 'tst',
  test_case_results: 'tcr', issues: 'iss', risks: 'rsk', regressions: 'reg', health_results: 'hlt',
  project_snapshots: 'snp', project_memory: 'mem', architecture_decisions: 'adr', artifacts: 'art',
  project_events: 'evt', evidence_refs: 'evd', analysis_jobs: 'job',
};

function mapOut(table, row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of JSON_COLS[table] || []) {
    const short = col.replace(/_json$/, '');
    const raw = out[col];
    delete out[col];
    try { out[short] = raw == null ? null : JSON.parse(raw); } catch { out[short] = null; }
  }
  for (const col of BOOL_COLS[table] || []) out[col] = out[col] === 1 || out[col] === true;
  return out;
}

function mapIn(table, obj) {
  const jsonCols = JSON_COLS[table] || [];
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const col = jsonCols.includes(`${k}_json`) ? `${k}_json` : k;
    if (v === undefined) continue;
    out[col] = v;
  }
  return out;
}

export class Repository {
  constructor(db) {
    this.db = db;
    this._columns = new Map();
  }

  columns(table) {
    if (!this._columns.has(table)) {
      this._columns.set(table, new Set(this.db.all(`PRAGMA table_info(${table})`).map((r) => r.name)));
    }
    return this._columns.get(table);
  }

  hasColumn(table, col) { return this.columns(table).has(col); }

  insert(table, obj) {
    assertTable(table);
    const id = obj.id || newId(ID_PREFIX[table] || 'row');
    const record = mapIn(table, { ...obj, id });
    if (record.created_at === undefined && this.hasColumn(table, 'created_at')) record.created_at = nowIso();
    if (record.updated_at === undefined && this.hasColumn(table, 'updated_at')) record.updated_at = record.created_at || nowIso();
    const cols = Object.keys(record);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    try {
      this.db.run(sql, cols.map((c) => record[c]));
    } catch (err) {
      throw new RepoError(`insert into ${table} failed: ${err.message}`);
    }
    return this.get(table, id);
  }

  insertMany(table, rows) {
    if (!rows.length) return [];
    return this.db.transaction(() => rows.map((r) => this.insert(table, r)));
  }

  update(table, id, patch) {
    assertTable(table);
    const record = mapIn(table, patch);
    if (this.hasColumn(table, 'updated_at')) record.updated_at = nowIso();
    const cols = Object.keys(record);
    if (!cols.length) return this.get(table, id);
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    this.db.run(sql, [...cols.map((c) => record[c]), id]);
    return this.get(table, id);
  }

  upsert(table, conflictCols, obj) {
    assertTable(table);
    const existing = this.list(table, Object.fromEntries(conflictCols.map((c) => [c, obj[c]])), { limit: 1 })[0];
    if (existing) return this.update(table, existing.id, obj);
    return this.insert(table, obj);
  }

  get(table, id) {
    assertTable(table);
    return mapOut(table, this.db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]));
  }

  /** app_settings uses `key` as primary key. */
  getSetting(key) {
    const row = this.db.get('SELECT * FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    this.db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, raw, nowIso()],
    );
    return raw;
  }

  list(table, where = {}, opts = {}) {
    assertTable(table);
    const { whereSql, params } = buildWhere(where);
    const orderBy = opts.orderBy ? ` ORDER BY ${sanitizeOrderBy(opts.orderBy)}` : '';
    const limit = opts.limit ? ` LIMIT ${Number(opts.limit)}` : '';
    const offset = opts.offset ? ` OFFSET ${Number(opts.offset)}` : '';
    const rows = this.db.all(`SELECT * FROM ${table}${whereSql}${orderBy}${limit}${offset}`, params);
    return rows.map((r) => mapOut(table, r));
  }

  count(table, where = {}) {
    assertTable(table);
    const { whereSql, params } = buildWhere(where);
    const row = this.db.get(`SELECT COUNT(*) AS c FROM ${table}${whereSql}`, params);
    return row ? Number(row.c) : 0;
  }

  remove(table, id) {
    assertTable(table);
    this.db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    return true;
  }

  removeWhere(table, where) {
    assertTable(table);
    const { whereSql, params } = buildWhere(where);
    this.db.run(`DELETE FROM ${table}${whereSql}`, params);
    return true;
  }

  raw(sql, params = []) { return this.db.all(sql, params); }
}

function assertTable(table) {
  if (!TABLES.includes(table)) throw new RepoError(`unknown table: ${table}`);
}

const ORDER_BY_RE = /^[a-zA-Z0-9_., ]+( (ASC|DESC))?(, *[a-zA-Z0-9_]+( (ASC|DESC))?)*$/i;
function sanitizeOrderBy(clause) {
  if (!ORDER_BY_RE.test(clause)) throw new RepoError(`unsafe order by: ${clause}`);
  return clause;
}

function buildWhere(where) {
  const entries = Object.entries(where).filter(([, v]) => v !== undefined);
  if (!entries.length) return { whereSql: '', params: [] };
  const parts = [];
  const params = [];
  for (const [k, v] of entries) {
    if (!/^[a-zA-Z0-9_]+$/.test(k)) throw new RepoError(`unsafe column: ${k}`);
    if (v === null) { parts.push(`${k} IS NULL`); continue; }
    if (Array.isArray(v)) {
      parts.push(`${k} IN (${v.map(() => '?').join(', ')})`);
      params.push(...v);
      continue;
    }
    parts.push(`${k} = ?`);
    params.push(v);
  }
  return { whereSql: ` WHERE ${parts.join(' AND ')}`, params };
}

export { mapOut, mapIn };
