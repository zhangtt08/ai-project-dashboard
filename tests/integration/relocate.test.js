/**
 * 失效路径的重新定位 —— the remedy for "整个项目树挪了一次位置，面板上 N 条记录同时打不开".
 *
 * Exercised over HTTP because that is what the dashboard's batch button calls. The assertions are
 * about facts: a recorded path either exists or does not, a candidate either carries a marker or
 * does not, and an ambiguous name must never be auto-applied.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { App } from '../../src/core/app.js';
import { buildRouter } from '../../src/server/routes.js';
import { createHttpServer } from '../../src/server/http-server.js';
import { expandShortPath } from '../../src/core/fs-safe.js';
import { toPosix } from '../../src/core/util.js';
import { makeTempDir } from '../helpers/tmp.js';

// 临时目录要取应用侧同一形态的长名：os.tmpdir() 在 Windows 上给出 8.3 短名（ADMINI~1），
// 而 app.setWorkspacePath/addProject 写回的是 expandShortPath 展开过的长名（Administrator）。
// 注意 fs.realpathSync（Node 实现）在这台机器上并不会展开 8.3 短名 —— 实测原样返回 ADMINI~1；
// 仓库里唯一的正规换形工具是 fs-safe.expandShortPath（内部用 realpathSync.native），
// 断言与夹具都按它来量，否则测的是临时目录的短名形态而不是 relocation 本身。
const ROOT = expandShortPath(makeTempDir('apc-relocate-'));
const OPEN = [];

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function stored(p) { return toPosix(expandShortPath(path.resolve(p))); }

function request(baseUrl, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
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

/** A real project folder the resolver can find, with the markers that make it a project. */
function seedFolder(dir, name) {
  mkdirp(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node -e 0' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  return dir;
}

let app;
let server;
let baseUrl;

before(async () => {
  app = new App({ dataDir: path.join(ROOT, 'data'), dbFile: ':memory:' });
  OPEN.push(app);
  // Auto-publish would reach for the network; this test is about the local record.
  app.repo.setSetting('github.enabled', 'false');
  app.stopBackground();

  server = createHttpServer({ router: buildRouter(app), app });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const a of OPEN) { try { a.close(); } catch { /* already closed */ } }
  try { server.close(); } catch { /* noop */ }
});

describe('relocation preview', () => {
  const roots = path.join(ROOT, 'roots');
  const oldParent = path.join(roots, 'old');
  const newParent = path.join(roots, 'new');

  before(() => {
    // Everything below is registered against a search root the test controls.
    app.repo.setSetting('workspace.searchRoots', JSON.stringify([roots]));
  });

  test('a moved folder is offered as the unique new location', async () => {
    const dir = seedFolder(path.join(newParent, 'moved-app'), 'moved-app');
    mkdirp(oldParent);
    const p = app.addProject({ workspacePath: dir, name: 'Moved App' });
    // 把记录指回一个已经不存在的旧路径，新位置留在盘上等人确认。
    // （这里原来还 rmSync 了 dir —— 那等于把"新位置"本身删掉了，
    //  于是预览永远报 not_found，测的是夹具自己造的空场景而不是移动识别。）
    const gone = path.join(oldParent, 'moved-app');
    mkdirp(path.dirname(gone));
    app.repo.update('projects', p.id, { workspace_path: toPosix(gone) });

    const res = await request(baseUrl, 'GET', '/api/projects/relocate/preview');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json), ['data'], 'the envelope must stay {data: …}');
    const item = res.json.data.items.find((i) => i.projectId === p.id);
    assert.ok(item, 'the broken record must appear in the plan');
    assert.equal(item.state, 'unique', `expected one candidate, got ${JSON.stringify(item.candidates)}`);
    assert.equal(toPosix(item.candidates[0].path), toPosix(path.join(newParent, 'moved-app')));
    assert.equal(item.candidates[0].usable, true);
    assert.ok(item.candidates[0].markers.includes('package.json'), 'the suggestion must name the marker that justifies it');
  });

  test('two same-named folders are reported as ambiguous and never auto-applied', async () => {
    const a = seedFolder(path.join(newParent, 'twins'), 'twins');
    const b = seedFolder(path.join(roots, 'elsewhere', 'twins'), 'twins');
    mkdirp(oldParent);
    const gone = path.join(oldParent, 'twins');
    const p = app.addProject({ workspacePath: a, name: 'Twins' });
    // 两个同名文件夹都得留在盘上，否则"歧义"这个判据根本没被构造出来。
    app.repo.update('projects', p.id, { workspace_path: toPosix(gone) });

    const res = await request(baseUrl, 'GET', '/api/projects/relocate/preview');
    const item = res.json.data.items.find((i) => i.projectId === p.id);
    assert.equal(item.state, 'ambiguous', `both ${a} and ${b} exist — guessing is not allowed`);
    assert.equal(item.candidates.filter((c) => c.usable).length, 2);
    // The summary is what the dashboard header quotes; it must count this as needing a human.
    assert.ok(res.json.data.summary.ambiguous >= 1);
    assert.equal(res.json.data.summary.unique + res.json.data.summary.ambiguous + res.json.data.summary.notFound, res.json.data.summary.missing);
  });

  test('an empty same-named folder is not offered as a target', async () => {
    mkdirp(path.join(roots, 'nothinghere', 'lonely'));
    mkdirp(oldParent);
    const gone = toPosix(path.join(oldParent, 'lonely'));
    const p = app.repo.insert('projects', { id: 'prj_lonely', name: 'Lonely', workspace_path: gone });
    const res = await request(baseUrl, 'GET', '/api/projects/relocate/preview');
    const item = res.json.data.items.find((i) => i.projectId === p.id);
    assert.equal(item.state, 'not_found', 'a directory with no marker is not evidence of the project');
    assert.ok(item.candidates.every((c) => !c.usable));
    assert.match(item.candidates[0].reason, /空目录|标记/);
  });

  test('a readable workspace is reported as present and never listed as broken', async () => {
    const dir = seedFolder(path.join(newParent, 'healthy-app'), 'healthy-app');
    const p = app.addProject({ workspacePath: dir, name: 'Healthy App' });
    const res = await request(baseUrl, 'GET', '/api/projects/relocate/preview');
    const item = res.json.data.items.find((i) => i.projectId === p.id);
    assert.equal(item.state, 'present');
    assert.equal(item.candidates, undefined, 'a folder that exists gets no relocation advice');
  });
});

describe('relocation apply', () => {
  const roots = path.join(ROOT, 'apply-roots');

  before(() => { app.repo.setSetting('workspace.searchRoots', JSON.stringify([roots])); });

  test('applying a move rewrites the path through the one existing write path and rescans', async () => {
    mkdirp(path.join(roots, 'parent'));
    const dir = seedFolder(path.join(roots, 'parent', 'carry-app'), 'carry-app');
    const p = app.addProject({ workspacePath: dir, name: 'Carry App' });
    const gone = toPosix(path.join(roots, 'parent', 'gone', 'carry-app'));
    app.repo.update('projects', p.id, { workspace_path: gone });
    assert.equal(fs.existsSync(gone), false);

    const res = await request(baseUrl, 'POST', '/api/projects/relocate', { moves: [{ projectId: p.id, newPath: toPosix(dir) }] });
    assert.equal(res.status, 200);
    const out = res.json.data;
    assert.equal(out.applied, 1, JSON.stringify(out.results));
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].onDisk, true, 'the applied path must be re-checked against the disk, not trusted');
    assert.equal(out.results[0].quickScan, 'ok', 'a re-located project is re-read immediately');

    const after = app.getProject(p.id);
    // 应用侧写回的是 expandShortPath 展开过的长名（setWorkspacePath 的既有约定，
    // 见 src/core/app.js:272 —— 短名进 fs.watch 会让整个 Node 进程挂掉），
    // 断言按同一把尺 stored() 量，不用 fs.realpathSync（它在这台机器上不展开 8.3）。
    assert.equal(after.workspace_path, stored(dir));
    assert.equal(after.metadata && after.metadata.metadata && after.metadata.metadata.ok, true, 'the new folder was really read');
    assert.equal(after.last_analyzed_at ? true : false, true, 're-location clears the old verdicts and stamps a new analysis');
  });

  test('a move to a path that does not exist is refused with an executable reason', async () => {
    const p = app.repo.list('projects', {}).find((x) => x.name === 'Carry App');
    const res = await request(baseUrl, 'POST', '/api/projects/relocate', { moves: [{ projectId: p.id, newPath: toPosix(path.join(roots, 'no-such-place')) }] });
    assert.equal(res.status, 400, 'WorkspaceError maps to a 400, not a 500');
    assert.match(res.json.error.message, /目录不存在|does not exist/);
    // 本仓库的错误信封只有 {code,message}（没有 details 字段），所以"哪一条为什么没成"
    // 必须写进 message 本身：调用方拿到的不是"失败了"，而是"哪条、为什么"。
    assert.match(res.json.error.message, /Carry App/, '回执要点名是哪一条');
  });

  test('an empty move list is refused instead of doing nothing silently', async () => {
    const res = await request(baseUrl, 'POST', '/api/projects/relocate', { moves: [] });
    // 本仓库把 ValidationError 统一映射成 400 + code=validation_error（见 src/server/routes.js 的错误映射），
    // 不是 422：断言跟着仓库既有的约定走，否则这条测试测的是自己发明的状态码。
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'validation_error');
  });

  test('one bad move does not stop the others from reporting', async () => {
    mkdirp(path.join(roots, 'ok-two'));
    fs.writeFileSync(path.join(roots, 'ok-two', 'package.json'), '{"name":"ok-two"}', 'utf8');
    const good = app.addProject({ workspacePath: path.join(roots, 'ok-two'), name: 'OK Two' });
    const goodTarget = good.workspace_path;
    app.repo.update('projects', good.id, { workspace_path: toPosix(path.join(roots, 'ghost')) });
    const res = await request(baseUrl, 'POST', '/api/projects/relocate', {
      moves: [
        { projectId: 'prj_missing_record', newPath: goodTarget },
        { projectId: good.id, newPath: goodTarget },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.applied, 1);
    assert.equal(res.json.data.failed, 1);
    assert.match(res.json.data.results[0].reason, /不存在/);
    assert.equal(res.json.data.results[1].ok, true);
  });
});
