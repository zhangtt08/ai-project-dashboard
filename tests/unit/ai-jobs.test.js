import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Database } from '../../src/db/database.js';
import { MIGRATIONS, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, FTS_MIGRATION } from '../../src/db/migrations.js';
import { Repository } from '../../src/db/repositories.js';
import { StructuredRunner, extractJson } from '../../src/core/ai/structured.js';
import { ProviderRegistry, AIProvider, maskSecrets, excerpt } from '../../src/core/ai/provider.js';
import { MockAIProvider } from '../../src/core/ai/mock-provider.js';
import { OpenAICompatibleProvider } from '../../src/core/ai/openai-provider.js';
import { s, validate } from '../../src/domain/schema.js';
import { AnalysisQueue, WorkspaceWatcher } from '../../src/core/jobs.js';
import { EventLog } from '../../src/core/events.js';
import { SearchService } from '../../src/core/search.js';
import { ManualImportAdapter, MockAgentAdapter, parseTranscript, AgentSessionService } from '../../src/core/agent-sessions.js';
import { ProjectSummarySchema } from '../../src/domain/ai-schemas.js';
import { JOB_TYPE, JOB_STATUS, EVENT_TYPE } from '../../src/domain/constants.js';
import { sleep } from '../../src/core/util.js';
import { makeTempDir } from '../helpers/tmp.js';

const freshRepo = () => {
  const db = openDatabase(':memory:');
  return { db, repo: new Repository(db) };
};

class ScriptedProvider extends AIProvider {
  constructor(responses) {
    super({ name: 'scripted', kind: 'openai-compatible', model: 'test-model' });
    this.responses = [...responses];
    this.calls = 0;
  }
  isConfigured() { return true; }
  async generate() {
    this.calls += 1;
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return { text: next, model: this.model, provider: this.name };
  }
}

describe('extractJson', () => {
  test('parses plain, fenced and chatty responses', () => {
    assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```').value, { a: 1 });
    assert.deepEqual(extractJson('Sure! Here you go: {"a":1} — hope that helps').value, { a: 1 });
  });
  test('rejects nonsense without throwing', () => {
    assert.equal(extractJson('').ok, false);
    assert.equal(extractJson('no json at all').ok, false);
    assert.equal(extractJson('{"a": ').ok, false);
  });
});

describe('StructuredRunner', () => {
  const schema = s.object({ value: s.string({ min: 1 }), confidence: s.enum(['high', 'medium', 'low', 'unknown']).optional() });

  test('returns validated data from the active provider', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ScriptedProvider(['{"value":"ok","confidence":"high"}']), { active: true });
    const runner = new StructuredRunner({ registry, mockProvider: new MockAIProvider() });
    const res = await runner.run({ schemaName: 'x', schema, prompt: 'p' });
    assert.equal(res.data.value, 'ok');
    assert.equal(res.attempts, 1);
    assert.equal(res.fallbackUsed, false);
    assert.equal(res.validationOk, true);
  });

  test('retries once on invalid JSON and succeeds on the second attempt', async () => {
    const registry = new ProviderRegistry();
    const provider = new ScriptedProvider(['not json', '{"value":"fixed"}']);
    registry.register(provider, { active: true });
    const runner = new StructuredRunner({ registry, mockProvider: new MockAIProvider() });
    const res = await runner.run({ schemaName: 'x', schema, prompt: 'p', maxRetries: 1 });
    assert.equal(res.data.value, 'fixed');
    assert.equal(res.attempts, 2);
    assert.equal(provider.calls, 2);
    assert.equal(runner.describeStats().retries, 1);
  });

  test('falls back to the deterministic Mock provider when validation keeps failing', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ScriptedProvider(['{"value":1}', '{"value":2}']), { active: true });
    const mock = new MockAIProvider();
    const runner = new StructuredRunner({ registry, mockProvider: mock });
    const res = await runner.run({ schemaName: 'projectSummary', schema: ProjectSummarySchema, prompt: 'p', maxRetries: 1, context: { metadata: {} } });
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.provider, 'mock');
    assert.ok(res.data.summary.length > 0);
    assert.equal(runner.describeStats().fallbacks, 1);
  });

  test('falls back when the provider throws', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ScriptedProvider([new Error('upstream 500')]), { active: true });
    const runner = new StructuredRunner({ registry, mockProvider: new MockAIProvider() });
    const res = await runner.run({ schemaName: 'projectSummary', schema: ProjectSummarySchema, prompt: 'p', context: { metadata: {} } });
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.provider, 'mock');
  });

  test('uses the mock provider directly when nothing is configured', async () => {
    const registry = new ProviderRegistry();
    registry.register(new MockAIProvider(), { active: true });
    const runner = new StructuredRunner({ registry, mockProvider: new MockAIProvider() });
    const res = await runner.run({ schemaName: 'healthCheck', schema: s.object({ ok: s.boolean() }), prompt: 'p' });
    assert.equal(res.data.ok, true);
    assert.equal(res.provider, 'mock');
  });

  test('never returns unvalidated data: a mock result is validated too, and an unusable schema throws', async () => {
    const registry = new ProviderRegistry();
    const broken = new MockAIProvider();
    broken.generate = async () => ({ object: { nope: true }, provider: 'mock', model: 'm' });
    registry.register(new ScriptedProvider(['garbage']), { active: true });
    const runner = new StructuredRunner({ registry, mockProvider: broken });
    await assert.rejects(
      () => runner.run({ schemaName: 'x', schema, prompt: 'p', maxRetries: 0 }),
      (err) => err.code === 'schema_mismatch',
      'a schema that cannot be satisfied by an empty document must fail loudly, not silently',
    );
  });
});

describe('Providers', () => {
  test('maskSecrets removes keys, tokens and private key blocks', () => {
    const text = 'key sk-abcdefghijklmnopqrstuvwxyz123 token=abcdef123456\n-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----';
    const masked = maskSecrets(text);
    assert.ok(!masked.includes('sk-abcdefghijklmnopqrstuvwxyz123'));
    assert.ok(!masked.includes('ABCDEF'));
    assert.ok(masked.includes('[REDACTED'));
  });

  test('excerpt caps how much text reaches a prompt', () => {
    assert.equal(excerpt('abc', 10), 'abc');
    assert.match(excerpt('x'.repeat(100), 10), /omitted/);
  });

  test('the registry only ever claims configured providers', () => {
    const registry = new ProviderRegistry();
    registry.register(new MockAIProvider());
    const unconfigured = new OpenAICompatibleProvider({ baseUrl: '', apiKey: '' });
    registry.register(unconfigured);
    const described = registry.describe();
    assert.equal(described.find((p) => p.name === 'mock').configured, true);
    assert.equal(described.find((p) => p.name === unconfigured.name).configured, false);
    assert.throws(() => registry.setActive('nope'));
  });

  test('an unconfigured OpenAI-compatible provider refuses to run', async () => {
    const provider = new OpenAICompatibleProvider({ baseUrl: '', apiKey: '' });
    await assert.rejects(() => provider.generate({ prompt: 'x' }), /not configured/);
  });
});

describe('Database + Repository', () => {
  test('migrations are idempotent and versioned', () => {
    const db = openDatabase(':memory:');
    const first = db.migrate();
    assert.deepEqual(first.applied, []);
    const versions = db.all('SELECT version FROM schema_migrations ORDER BY version').map((r) => Number(r.version));
    // v5 (`job_progress`) is part of the registry: the queue persists which step a running scan is
    // on, and that has to survive a page reload. v6 (`project_command_trust`) is the column that
    // records whether a scan may execute this folder's scripts — including the documented
    // backfill that keeps rows which already existed trusted. Keep this list in step with
    // `allMigrations()`.
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);
    assert.equal(db.ftsAvailable, true);
  });

  test('v6 really converts the rows that already existed, and a fresh row is not trusted', () => {
    // Replay of the upgrade path, not a reading of the SQL text: build the pre-v6 schema, insert
    // a row the way the running app would, then apply MIGRATION_6 over it. This is the whole
    // answer to "where does the existing trust come from" — the migration, recorded per row as
    // trusted_source='migration' — and the other half is the shipped default of 0.
    const db = new Database({ file: ':memory:' });
    for (const m of [MIGRATIONS[0], FTS_MIGRATION, MIGRATION_3, MIGRATION_4, MIGRATION_5]) {
      for (const stmt of m.up) db.exec(stmt);
    }
    const repo = new Repository(db);
    const before = repo.insert('projects', { name: 'Old', workspace_path: '/old' });
    assert.equal(repo.hasColumn('projects', 'trusted'), false, 'the pre-v6 schema must not have the column yet');

    for (const stmt of MIGRATION_6.up) db.exec(stmt);
    const after = repo.get('projects', before.id);
    assert.equal(after.trusted, true, 'MIGRATION_6 is what marks the rows that already existed');
    assert.equal(after.trusted_source, 'migration');

    const fresh = repo.insert('projects', { name: 'New', workspace_path: '/new' });
    assert.equal(fresh.trusted, false, 'a row created after the upgrade has no trust until someone decides');
    assert.equal(fresh.trusted_source, null);
    db.close();
  });

  test('JSON and boolean columns round-trip', () => {
    const { repo } = freshRepo();
    const p = repo.insert('projects', { name: 'X', workspace_path: '/x', is_demo: true, metadata: { a: [1, 2] }, progress: { percent: 12.5 }, ignore_patterns: ['a', 'b'] });
    const read = repo.get('projects', p.id);
    assert.equal(read.is_demo, true);
    assert.deepEqual(read.metadata, { a: [1, 2] });
    assert.equal(read.progress.percent, 12.5);
    assert.deepEqual(read.ignore_patterns, ['a', 'b']);
  });

  test('rejects unsafe identifiers and unknown tables', () => {
    const { repo } = freshRepo();
    assert.throws(() => repo.list('not_a_table'));
    assert.throws(() => repo.list('tasks', { 'id; DROP TABLE tasks': 1 }));
    assert.throws(() => repo.list('tasks', {}, { orderBy: 'id; DROP TABLE tasks' }));
  });

  test('app_settings upsert works by key', () => {
    const { repo } = freshRepo();
    repo.setSetting('ai.provider', 'mock');
    repo.setSetting('ai.provider', 'openai-compatible');
    assert.equal(repo.getSetting('ai.provider'), 'openai-compatible');
    assert.equal(repo.getSetting('missing'), null);
  });

  test('foreign keys cascade on project delete', () => {
    const { repo } = freshRepo();
    const p = repo.insert('projects', { name: 'X', workspace_path: '/cascade' });
    repo.insert('tasks', { project_id: p.id, title: 't' });
    assert.equal(repo.count('tasks', { project_id: p.id }), 1);
    repo.remove('projects', p.id);
    assert.equal(repo.count('tasks', { project_id: p.id }), 0);
  });
});

describe('AnalysisQueue', () => {
  test('respects the concurrency limit and completes jobs', async () => {
    const { repo } = freshRepo();
    const queue = new AnalysisQueue({ repo, concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    queue.register(JOB_TYPE.RISK, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active -= 1;
      return { ok: true };
    });
    queue.start(10);
    for (let i = 0; i < 6; i += 1) queue.enqueue({ projectId: null, type: JOB_TYPE.RISK, priority: i });
    const drained = await queue.drain({ timeoutMs: 8000 });
    queue.stop();
    assert.equal(drained, true);
    assert.ok(maxActive <= 2, `concurrency limit violated (saw ${maxActive})`);
    assert.equal(queue.stats().byStatus.completed, 6);
  });

  test('retries a failing job up to max_attempts then fails it', async () => {
    const { repo } = freshRepo();
    const queue = new AnalysisQueue({ repo, concurrency: 1 });
    let attempts = 0;
    queue.register(JOB_TYPE.GIT, async () => { attempts += 1; throw new Error('flaky'); });
    queue.start(5);
    queue.enqueue({ projectId: null, type: JOB_TYPE.GIT, maxAttempts: 3 });
    await queue.drain({ timeoutMs: 5000 });
    queue.stop();
    assert.equal(attempts, 3);
    assert.equal(queue.stats().byStatus.failed, 1);
  });

  test('cancels a queued job', async () => {
    const { repo } = freshRepo();
    const queue = new AnalysisQueue({ repo, concurrency: 1 });
    queue.register(JOB_TYPE.TEST, async () => { await sleep(50); return {}; });
    const job = queue.enqueue({ projectId: null, type: JOB_TYPE.TEST });
    queue.cancel(job.id);
    assert.equal(repo.get('analysis_jobs', job.id).status, JOB_STATUS.CANCELLED);
  });

  test('fails a job that has no handler instead of hanging', async () => {
    const { repo } = freshRepo();
    const queue = new AnalysisQueue({ repo, concurrency: 1 });
    queue.start(5);
    queue.enqueue({ projectId: null, type: JOB_TYPE.BUILD });
    await queue.drain({ timeoutMs: 3000 });
    queue.stop();
    assert.equal(queue.stats().byStatus.failed, 1);
  });

  test('honours the per-job timeout', async () => {
    const { repo } = freshRepo();
    const queue = new AnalysisQueue({ repo, concurrency: 1 });
    queue.register(JOB_TYPE.AI_ANALYSIS, async () => { await sleep(2000); return {}; });
    queue.start(5);
    queue.enqueue({ projectId: null, type: JOB_TYPE.AI_ANALYSIS, timeoutMs: 80, maxAttempts: 1 });
    await queue.drain({ timeoutMs: 4000 });
    queue.stop();
    const jobs = queue.list({ status: JOB_STATUS.FAILED });
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].error, /timed out/);
  });
});

describe('WorkspaceWatcher', () => {
  test('emits a debounced workspace_changed event and never calls an LLM', async () => {
    const { repo } = freshRepo();
    const events = new EventLog({ repo });
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = makeTempDir('apc-watch-');
    const project = repo.insert('projects', { name: 'W', workspace_path: dir });
    const watcher = new WorkspaceWatcher({ events, debounceMs: 30 });

    const res = watcher.watch({ id: project.id, workspace_path: dir });
    assert.equal(res.watching, true);
    assert.deepEqual(watcher.status().watching, [project.id]);

    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    await sleep(500);
    watcher.unwatchAll();
    assert.deepEqual(watcher.status().watching, []);

    const recorded = events.timeline(project.id);
    assert.ok(recorded.some((e) => e.type === EVENT_TYPE.WORKSPACE_CHANGED), 'expected a workspace_changed event');
    assert.ok(!recorded.some((e) => /llm|ai/i.test(e.type)), 'the watcher must never trigger AI work');
  });

  test('does not queue a scan on every keystroke (rate limited)', async () => {
    const { repo } = freshRepo();
    const events = new EventLog({ repo });
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = makeTempDir('apc-watch2-');
    const project = repo.insert('projects', { name: 'W2', workspace_path: dir });
    const watcher = new WorkspaceWatcher({ events, debounceMs: 25 });
    watcher.watch({ id: project.id, workspace_path: dir });
    for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(dir, 'f.ts'), `export const v = ${i};\n`);
    await sleep(600);
    watcher.unwatchAll();
    const changes = events.timeline(project.id).filter((e) => e.type === EVENT_TYPE.WORKSPACE_CHANGED);
    assert.ok(changes.length <= 4, `debounce failed: ${changes.length} events for 12 rapid writes`);
  });

  test('reports a watch failure instead of throwing', () => {
    const { repo } = freshRepo();
    const events = new EventLog({ repo });
    const watcher = new WorkspaceWatcher({ events });
    const res = watcher.watch({ id: 'x', workspace_path: 'C:////////definitely-not-here-' + Math.random() });
    assert.equal(res.watching, false);
    assert.ok(res.error);
  });
});

describe('SearchService', () => {
  test('indexes and finds entities with FTS5', () => {
    const { db, repo } = freshRepo();
    const search = new SearchService({ db, repo });
    const p = repo.insert('projects', { name: 'Checkout Service', description: 'handles payments', workspace_path: '/checkout' });
    const t = repo.insert('tasks', { project_id: p.id, title: 'Fix checkout rounding bug' });
    search.indexEntity('projects', p);
    search.indexEntity('tasks', t);
    const res = search.query('checkout');
    assert.equal(res.fts, true);
    assert.ok(res.results.some((r) => r.table === 'tasks'));
    assert.deepEqual(search.query('').results, []);
  });

  test('falls back to LIKE when FTS is unavailable', () => {
    const { db, repo } = freshRepo();
    const search = new SearchService({ db, repo });
    search.fts = false;
    const p = repo.insert('projects', { name: 'Alpha Project', workspace_path: '/alpha' });
    const res = search.query('Alpha');
    assert.equal(res.fts, false);
    assert.ok(res.results.some((r) => r.id === p.id));
    assert.match(res.note, /substring matching/);
  });
});

describe('Agent adapters', () => {
  const transcript = [
    'Agent: Claude Code',
    '$ npm test',
    '      Tests  6 passed (6)',
    'exit code 0',
    '$ npm run test:e2e',
    '  22 passed (18.4s)',
    '  3 failed',
    'exit code 1',
    'Edited file: src/planner/weekly.js',
    'Status: partial',
  ].join('\n');

  test('parseTranscript extracts commands, exit codes and files', () => {
    const parsed = parseTranscript(transcript);
    assert.equal(parsed.commands.length, 2);
    assert.deepEqual(parsed.exitCodes, [0, 1]);
    assert.ok(parsed.editedFiles.includes('src/planner/weekly.js'));
    assert.ok(parsed.notes.some((n) => /failure language/.test(n)));
  });

  test('ManualImportAdapter implements the frozen interface and is marked real', async () => {
    const a = new ManualImportAdapter({ transcript, provider: 'claude_code' });
    assert.equal(a.isMock, false);
    const info = await a.getSessionInfo();
    assert.equal(info.provider, 'claude_code');
    assert.equal(info.status, 'failed');
    assert.ok((await a.getChangedFiles()).length > 0);
    const exec = await a.getExecutionResult();
    assert.equal(exec.commands.length, 2);
    assert.ok(a.capabilities().transcript);
  });

  test('MockAgentAdapter announces itself as mock', async () => {
    const a = new MockAgentAdapter({ projectName: 'x' });
    assert.equal(a.isMock, true);
    assert.equal(a.capabilities().mock, true);
    const info = await a.getSessionInfo();
    assert.equal(info.provider, 'mock');
    assert.match(info.summary, /MOCK/);
  });

  test('AgentSessionService persists the session and links prompt → execution', async () => {
    const { repo } = freshRepo();
    const events = new EventLog({ repo });
    const p = repo.insert('projects', { name: 'P', workspace_path: '/agent' });
    const prompt = repo.insert('prompts', { project_id: p.id, content: 'do x' });
    const service = new AgentSessionService({ repo, events, eventType: EVENT_TYPE.AGENT_SESSION_IMPORTED });
    const session = await service.importSession(p.id, { adapter: new ManualImportAdapter({ transcript }) });
    assert.equal(session.provider, 'manual');
    assert.equal(session.is_mock, false);
    assert.equal(session.changed_files.length > 0, true);
    const execution = service.linkPromptExecution(p.id, prompt.id, session.id, { status: 'failed', summary: 'e2e still failing' });
    assert.equal(execution.prompt_id, prompt.id);
    assert.equal(repo.get('prompts', prompt.id).status, 'executed');
    assert.equal(events.timeline(p.id).some((e) => e.type === EVENT_TYPE.AGENT_SESSION_IMPORTED), true);
  });
});

describe('schema helper for AI output', () => {
  test('validate flags an AI payload missing required keys', () => {
    const res = validate(ProjectSummarySchema, { summary: '' });
    assert.equal(res.ok, false);
  });
});
