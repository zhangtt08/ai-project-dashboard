/**
 * API integration tests — the same HTTP surface the web UI consumes.
 * A real server is started on an ephemeral port and exercised with fetch.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { App } from '../../src/core/app.js';
import { buildRouter } from '../../src/server/routes.js';
import { createHttpServer } from '../../src/server/http-server.js';
import { createFixtureProject } from '../../src/demo/fixture-factory.js';
import { makeTempDir } from '../helpers/tmp.js';

const ROOT = makeTempDir('apc-api-');
let app, server, baseUrl, fixtureDir;

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${p}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  app = new App({ dataDir: path.join(ROOT, 'data'), logLevel: 'error' });
  server = createHttpServer({ router: buildRouter(app), app });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  fixtureDir = path.join(ROOT, 'fixture');
  createFixtureProject(fixtureDir, 'warning');
});

after(() => { try { app.close(); server.close(); } catch { /* noop */ } });

describe('meta and health endpoints', () => {
  test('HTTP boundary rejects cross-site writes and oversized bodies with a usable response', async () => {
    const crossSite = await fetch(`${baseUrl}/api/diagnostics/parse-test`, {
      method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(crossSite.status, 403);
    const large = await fetch(`${baseUrl}/api/diagnostics/parse-test`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stdout: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(large.status, 413);
    assert.equal(large.headers.get('connection'), 'close');
    assert.equal((await request('GET', '/api/health')).status, 200);
  });

  test('GET /api/health reports version', async () => {
    const res = await request('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.ok, true);
  });

  test('GET /api/system exposes the runtime shape without secrets', async () => {
    const res = await request('GET', '/api/system');
    assert.equal(res.status, 200);
    assert.match(res.json.data.nodeVersion, /^v/);
    assert.ok(res.json.data.providers.every((p) => !('apiKey' in p) && !('config' in p)));
  });

  test('GET /api/security documents the safety model', async () => {
    const res = await request('GET', '/api/security');
    assert.equal(res.json.data.commandRunner.shellEnabled, false);
    assert.ok(res.json.data.commandRunner.alwaysBlocked.includes('rm'));
  });
});

describe('project lifecycle over HTTP', () => {
  let projectId;

  test('adding a workspace returns a project card', async () => {
    const res = await request('POST', '/api/projects', { workspacePath: fixtureDir, name: 'API fixture' });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.name, 'API fixture');
    assert.equal(res.json.data.health, 'unknown');
    projectId = res.json.data.id;
  });

  test('adding the same workspace twice is a conflict with a hint', async () => {
    const res = await request('POST', '/api/projects', { workspacePath: fixtureDir });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'conflict');
    assert.ok(res.json.error.hint);
  });

  test('adding a missing directory is a 400 with a helpful hint', async () => {
    const res = await request('POST', '/api/projects', { workspacePath: path.join(ROOT, 'ghost') });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /does not exist/);
  });

  test('a malformed JSON body is rejected without leaking a stack', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
        let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve({ status: r.statusCode, text: t }));
      });
      req.on('error', reject);
      req.write('{not json');
      req.end();
    });
    assert.equal(res.status, 400);
    const stackFrame = new RegExp('[/\\\\][A-Za-z0-9.@_-]+\\\\.js:[0-9]+:[0-9]+');
    assert.ok(!stackFrame.test(res.text), 'a stack frame leaked to the client');
  });

  test('a workspace added from outside starts untrusted, and trusting it is what enables commands', async () => {
    // Precondition for the two scan tests below, not a convenience: since the trust gate,
    // runCommands for a freshly imported folder is refused (see src/core/trust.js). Assert the
    // refusal first, then make the decision — so this file proves both directions instead of
    // quietly depending on an auto-trusted import.
    const before = await request('GET', `/api/projects/${projectId}/trust`);
    assert.equal(before.status, 200);
    assert.equal(before.json.data.trusted, false);
    assert.equal(before.json.data.wouldRunCommands, false);

    const untrusted = await request('POST', `/api/projects/${projectId}/scan-sync`, { mode: 'full', runCommands: true });
    assert.equal(untrusted.status, 200);
    assert.equal(untrusted.json.data.commandsSkipped.code, 'workspace_untrusted');
    assert.equal(untrusted.json.data.build, null, 'an untrusted folder must not have executed its build');

    const noConfirm = await request('POST', `/api/projects/${projectId}/trust`, { trusted: true });
    assert.equal(noConfirm.status, 400, 'granting trust without an explicit confirm must be refused');

    const granted = await request('POST', `/api/projects/${projectId}/trust`, { trusted: true, confirm: true });
    assert.equal(granted.status, 200);
    assert.equal(granted.json.data.trust.trusted, true);
    assert.equal(granted.json.data.trust.source, 'user');
  });

  test('the quick scan endpoint returns real git + file counts', async () => {
    const res = await request('POST', `/api/projects/${projectId}/scan-sync`, { mode: 'quick' });
    assert.equal(res.status, 200);
    assert.ok(res.json.data.files > 8);
    assert.equal(res.json.data.git.clean, true);
  });

  test('the full scan endpoint runs build and tests for real', { timeout: 240000 }, async () => {
    const res = await request('POST', `/api/projects/${projectId}/scan-sync`, { mode: 'full', runCommands: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.mode, 'full');
    assert.equal(res.json.data.build, 'pass');
    assert.equal(res.json.data.unit, '2/2');
    assert.equal(res.json.data.e2e, '22/25');
    assert.equal(res.json.data.gate, 'FAIL');
    assert.ok(res.json.data.snapshotSeq >= 1);
  });

  test('project detail aggregates every tab payload', async () => {
    const res = await request('GET', `/api/projects/${projectId}/detail`);
    const d = res.json.data;
    assert.equal(d.project.health, 'warning');
    assert.ok(d.gate.explanation.includes('无法推进'));
    assert.ok(d.nextAction.objective.length > 5);
    assert.ok(d.commands.some((c) => c.kind === 'build' && c.supported));
    assert.equal(d.metadata.sensitiveCount, 0);
    assert.ok(d.memoryVersion >= 1);
  });

  test('tasks, stages, tests, builds, git, risks and timeline endpoints respond', async () => {
    for (const p of ['/tasks', '/stages', '/tests', '/builds', '/git', '/risks', '/regressions', '/specs', '/memory', '/decisions', '/prompts', '/sessions', '/timeline', '/changes', '/snapshots', '/next-action']) {
      const res = await request('GET', `/api/projects/${projectId}${p}`);
      assert.equal(res.status, 200, `${p} failed`);
      assert.ok(res.json.data !== undefined, `${p} returned no data`);
    }
  });

  test('next-action can be recomputed without AI and stays deterministic', async () => {
    const a = await request('POST', `/api/projects/${projectId}/next-action`, { useAI: false });
    const b = await request('POST', `/api/projects/${projectId}/next-action`, { useAI: false });
    assert.equal(a.json.data.rule, b.json.data.rule);
    assert.equal(a.json.data.objective, b.json.data.objective);
  });

  test('prompt generation returns a prompt with all ten sections', { timeout: 60000 }, async () => {
    const res = await request('POST', `/api/projects/${projectId}/prompts`, { agentKey: 'generic_cli' });
    assert.equal(res.status, 200);
    const { prompt, meta } = res.json.data;
    assert.deepEqual(meta.sections.missing, []);
    for (const s of ['PROJECT CONTEXT', 'OBJECTIVE', 'DO NOT BREAK', 'VERIFICATION COMMANDS', 'COMPLETION REQUIREMENTS']) {
      assert.ok(prompt.content.includes(`## ${s}`));
    }
  });

  test('handoff package is complete and exportable', async () => {
    const res = await request('GET', `/api/projects/${projectId}/handoff`);
    assert.deepEqual(res.json.data.missingSections, []);
    const exp = await request('POST', `/api/projects/${projectId}/handoff/export`, {});
    assert.equal(exp.status, 200);
    assert.ok(exp.json.data.bytes > 500);
    const file = await request('GET', exp.json.data.url);
    assert.equal(file.status, 200);
    assert.match(file.text, /## Next Action/);
  });

  test('agent session import parses a real transcript', async () => {
    const transcript = '$ npm test\nexit code 0\n$ npm run test:e2e\n  22 passed (18.4s)\n  3 failed\nexit code 1\nEdited file: src/planner/weekly.js\n';
    const res = await request('POST', `/api/projects/${projectId}/sessions/import`, { transcript, provider: 'claude_code' });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.status, 'failed');
    assert.ok(res.json.data.changed_files.includes('src/planner/weekly.js'));
    assert.equal(res.json.data.is_mock, false);
  });

  test('demo seeding produces three analysed projects', { timeout: 300000 }, async () => {
    const res = await request('POST', '/api/demo/seed', { runCommands: true });
    assert.equal(res.status, 200);
    const dash = await request('GET', '/api/dashboard');
    assert.ok(dash.json.data.counts.total >= 4);
    assert.ok(dash.json.data.counts.healthy >= 1);
    assert.ok(dash.json.data.counts.critical >= 1);
    const attention = await request('GET', '/api/attention');
    assert.ok(attention.json.data.items.length > 0);
  });

  test('search finds indexed content', { timeout: 300000 }, async () => {
    const res = await request('GET', '/api/search?q=checkout');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.data.results));
  });

  test('settings round-trip without exposing the API key', async () => {
    const saved = await request('PATCH', '/api/settings', { 'ai.provider': 'mock', 'ai.model': 'test-model' });
    assert.equal(saved.status, 200);
    const read = await request('GET', '/api/settings');
    assert.equal(read.json.data['ai.provider'], 'mock');
    assert.ok(read.json.data['ai.apiKey'] !== 'secret-value');
  });

  test('deleting removes the record only unless the source purge is confirmed', async () => {
    // A throwaway project: deleting the shared fixture here would break later tests.
    const dir = makeTempDir('apc-ro-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ro', version: '1.0.0' }));
    const created = await request('POST', '/api/projects', { workspacePath: dir });
    assert.equal(created.status, 200);

    const recordOnly = await request('DELETE', `/api/projects/${created.json.data.id}`);
    assert.equal(recordOnly.status, 200);
    assert.equal(recordOnly.json.data.sourcePurged, null);
    assert.ok(recordOnly.json.data.sourceDirectoryUntouched);
    assert.ok(fs.existsSync(dir), 'record-only must not touch the source directory');
  });

  test('a source purge requires the echoed confirmation token and really deletes', async () => {
    const dir = makeTempDir('apc-purge-');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'purge-me', version: '1.0.0' }));

    const created = await request('POST', '/api/projects', { workspacePath: dir, scan: false });
    assert.equal(created.status, 200);
    const id = created.json.data.id;

    const assessed = await request('GET', `/api/projects/${id}/deletion`);
    assert.equal(assessed.status, 200);
    assert.equal(assessed.json.data.ok, true);
    assert.ok(assessed.json.data.fileCount >= 2);

    // Wrong token -> refused, and the directory must survive.
    const refused = await request('DELETE', `/api/projects/${id}?purge=true&confirm_token=nope`);
    assert.equal(refused.status, 400);
    assert.ok(fs.existsSync(dir), 'a refused purge must not delete anything');

    // Correct token -> the folder is really gone.
    const token = path.basename(dir);
    const done = await request('DELETE', `/api/projects/${id}?purge=true&confirm_token=${encodeURIComponent(token)}`);
    assert.equal(done.status, 200);
    assert.equal(done.json.data.sourcePurged.removed, true);
    assert.ok(!fs.existsSync(dir), 'the source directory must be removed after a confirmed purge');
  });

  test('import classifies the project and produces evidence-backed suggestions', async () => {
    const dir = makeTempDir('apc-classify-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'my-agent', version: '1.0.0', dependencies: { openai: '^4.0.0' },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'index.js'), [
      '// TODO: wire the tool loop',
      '// TODO: stream assistant output',
      '// TODO: persist the transcript',
      '// FIXME: retry on 429',
      '// TODO: add a cancellation path',
      'export default 1;',
    ].join('\n'));

    const created = await request('POST', '/api/projects', { workspacePath: dir });
    assert.equal(created.status, 200);
    const id = created.json.data.id;
    assert.equal(created.json.data.category, 'ai-agent', 'AI dependency must classify as 智能体');
    assert.ok(created.json.data.categoryLabel);

    const sugg = await request('GET', `/api/projects/${id}/suggestions`);
    assert.equal(sugg.status, 200);
    const items = sugg.json.data.suggestions;
    assert.ok(items.length >= 2);
    assert.ok(items.every((s) => typeof s.evidence === 'string' && s.evidence.length > 0), 'every suggestion must cite evidence');
    assert.ok(items.some((s) => s.id === 'no-readme'));
    assert.ok(items.some((s) => s.id === 'todo-debt' || s.title.includes('TODO')));
  });

  test('discovery reports project directories on this machine', async () => {
    const res = await request('GET', `/api/discovery?depth=2&limit=50&roots=${encodeURIComponent(path.dirname(fixtureDir))}`);
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.ok(Array.isArray(data.projects));
    assert.ok(data.projects.length >= 1, 'the fixture project must be discoverable');
    assert.ok(data.projects.every((p) => !/node_modules/.test(p.path)));
    assert.ok(data.projects.some((p) => p.managed === true), 'the registered fixture must be marked managed');
  });

  test('unknown routes return a structured 404', async () => {
    const res = await request('GET', '/api/definitely-not-a-route');
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'not_found');
  });
});

describe('manual command override', () => {
  let id;

  test('a pinned build command persists and shows as manual in detail', async () => {
    const cmdDir = path.join(ROOT, 'cmd-fixture');
    createFixtureProject(cmdDir, 'warning');
    const add = await request('POST', '/api/projects', { workspacePath: cmdDir, name: 'cmd fixture' });
    assert.equal(add.status, 200);
    id = add.json.data.id;
    // Running a pinned command is execution, so it needs the same recorded decision a scan does.
    const trust = await request('POST', `/api/projects/${id}/trust`, { trusted: true, confirm: true });
    assert.equal(trust.status, 200);
    const set = await request('POST', `/api/projects/${id}/commands`, { commands: { build: 'npm run build' } });
    assert.equal(set.status, 200);
    assert.equal(set.json.data.manualCommands.build, 'npm run build');

    const detail = await request('GET', `/api/projects/${id}/detail`);
    const row = detail.json.data.commands.find((c) => c.kind === 'build');
    assert.ok(row, 'detail must list the build kind');
    assert.equal(row.manual, true);
    assert.equal(row.source, 'manual');
    assert.equal(row.supported, true);
  });

  test('an unknown kind is rejected with a structured validation error', async () => {
    const res = await request('POST', `/api/projects/${id}/commands/run`, { kind: 'rm -rf /' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'validation_error');
  });

  test('a valid kind enqueues a run job; clearing the pin restores detection', async () => {
    const run = await request('POST', `/api/projects/${id}/commands/run`, { kind: 'build' });
    assert.equal(run.status, 200);
    assert.match(run.json.data.jobId, /^job_/);

    const clear = await request('PATCH', `/api/projects/${id}`, { commands: { build: '' } });
    assert.equal(clear.status, 200);
    const after = await request('GET', `/api/projects/${id}/detail`);
    const row = after.json.data.commands.find((c) => c.kind === 'build');
    assert.ok(!row.manual, 'cleared pin must fall back to auto-detection');
  });
});

describe('static frontend', () => {
  test('the SPA shell is served', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<div id="app-shell">/);
    assert.match(res.text, /AI Project Commander/);
  });

  test('path traversal is blocked', async () => {
    const res = await request('GET', '/..%2f..%2fpackage.json');
    assert.ok([403, 404].includes(res.status));
  });
});
