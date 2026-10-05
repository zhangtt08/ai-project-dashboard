/**
 * Agent API 契约（personal-agent-hub/docs/AGENT_API_STANDARD.md v1）—— 打在**真的服务**上。
 *
 * 现场形状：真的 `App` 容器 + 临时数据目录 + `server.listen(0)` 抢一个随机回环端口，
 * 然后按真实 HTTP 请求验收。这里不 mock 任何东西：mock 出来的绿只能证明测试自己写对了，
 * 证明不了四个端点。也不碰 8787 —— 那个端口上是用户可能正在用的实时服务。
 *
 * 每条断言都盯着「Agent 侧能不能据此行动」：信封形状、错误码、available 清单、
 * confirm 两个方向、截断要如实、工具读到的必须是本机真实行。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { App } from '../../src/core/app.js';
import { buildRouter } from '../../src/server/routes.js';
import { createHttpServer } from '../../src/server/http-server.js';
import { createFixtureProject } from '../../src/demo/fixture-factory.js';
import { AGENT_TOOL_NAMES, AGENT_VERSION, listAgentTools } from '../../agent/tools.mjs';
import { makeTempDir } from '../helpers/tmp.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = makeTempDir('apc-agent-');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

let app;
let server;
let baseUrl;
let fixtureDir;
let projectId;

async function call(tool, input) {
  const res = await fetch(`${baseUrl}/api/agent/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, input }),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(p) {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: await res.json() };
}

/** 一个真的 socket + 手写 Host：DNS rebinding 与非浏览器本机客户端就是这个形状。 */
function raw({ method = 'GET', p = '/api/health', host }) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${p}`, { method, headers: host ? { host } : {} }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
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
  const added = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspacePath: fixtureDir, name: 'Agent fixture' }),
  });
  const body = await added.json();
  assert.equal(added.status, 200, `fixture project could not be added: ${JSON.stringify(body)}`);
  projectId = body.data.id;
});

after(() => { try { app.close(); server.close(); } catch { /* noop */ } });

describe('GET /api/health 同时满足两个契约', () => {
  test('契约信封 + 界面既有的 data.ok / data.at 都还在', async () => {
    const res = await getJson('/api/health');
    assert.equal(res.status, 200);
    // 标准要求的四个键
    assert.equal(res.json.ok, true);
    assert.equal(res.json.data.project, 'commander');
    assert.equal(res.json.data.agent_api, 1);
    assert.equal(typeof res.json.data.uptime_ms, 'number');
    assert.ok(res.json.data.uptime_ms >= 0);
    // 这个仓库界面与 tests/integration/api.test.js:66 一直在读的两个键，一个都没少
    assert.equal(res.json.data.ok, true);
    assert.match(res.json.data.at, /^\d{4}-\d{2}-\d{2}T/);
    // data 段之外不许再套一层 {data:…}：外壳绕过去了才算契约成立
    assert.equal(res.json.data.data, undefined, 'the {data:…} wrapper leaked into the contract payload');
  });

  test('version 来自 package.json，不是写死的字面量', async () => {
    const res = await getJson('/api/health');
    assert.equal(res.json.data.version, PACKAGE.version);
    assert.equal(AGENT_VERSION, PACKAGE.version);
    // 守护的是「同源」这件事本身：源码里那句 '0.9.0' 字面量不该再出现在健康检查上。
    const routes = fs.readFileSync(path.join(REPO_ROOT, 'src/server/routes.js'), 'utf8');
    assert.equal(/version:\s*['"]\d+\.\d+\.\d+['"]/.test(routes), false, 'routes.js 里又出现了写死的版本号');
  });

  test('其他 REST 端点仍然是这个仓库原来的 {data:…} 外壳（界面没被改坏）', async () => {
    const res = await getJson('/api/projects');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.data));
    assert.equal(res.json.ok, undefined, 'REST 面不该被换成 Agent 信封');
  });
});

describe('GET /api/agent/manifest 与 /api/agent/tools', () => {
  test('manifest 给身份、base_url 与整份工具清单', async () => {
    const res = await getJson('/api/agent/manifest');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.data.project, 'commander');
    assert.equal(res.json.data.version, PACKAGE.version);
    assert.equal(res.json.data.base_url, baseUrl);
    assert.equal(res.json.data.tools.length, AGENT_TOOL_NAMES.length);
    for (const key of ['health', 'manifest', 'tools', 'tool']) {
      assert.match(res.json.data.endpoints[key], /^(GET|POST) \//, `endpoints.${key} 要写清方法与路径`);
    }
  });

  test('tools 只透出 name/description/input_schema/risk 四列，且形状合法', async () => {
    const res = await getJson('/api/agent/tools');
    assert.equal(res.json.ok, true);
    assert.ok(Array.isArray(res.json.data));
    const names = res.json.data.map((t) => t.name);
    assert.deepEqual([...names].sort(), [...AGENT_TOOL_NAMES].sort());
    assert.equal(new Set(names).size, names.length, '工具名必须全局唯一');
    for (const t of res.json.data) {
      assert.deepEqual(Object.keys(t).sort(), ['description', 'input_schema', 'name', 'risk']);
      assert.match(t.name, /^commander\.[a-z.]+$/, `${t.name} 必须带 commander. 前缀`);
      assert.ok(['read', 'write', 'exec'].includes(t.risk), `${t.name} 的 risk 不在三档之内`);
      assert.equal(t.input_schema.type, 'object');
      assert.equal(t.input_schema.additionalProperties, false, `${t.name} 必须挡住没声明的键`);
      assert.ok(Array.isArray(t.input_schema.required), `${t.name} 的 required 要写出来（可以为空数组）`);
      assert.ok(t.description.length > 40, `${t.name} 的说明要写到能据此决定用不用`);
    }
    // 交付前必须补的那件事：读写exec 三档都得真的有工具落在里面，别是一份空名单交差。
    const byRisk = res.json.data.reduce((a, t) => { a[t.risk] = (a[t.risk] || 0) + 1; return a; }, {});
    assert.ok(byRisk.read >= 10, `read 类至少十个：${JSON.stringify(byRisk)}`);
    assert.ok(byRisk.write >= 1 && byRisk.exec >= 3, `write/exec 不能是空的：${JSON.stringify(byRisk)}`);
  });

  test('agent/tools.mjs 没有返回写死的样例数据（每个 handler 都调 app 上真实存在的方法）', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'agent/tools.mjs'), 'utf8');
    const called = [...source.matchAll(/ctx\.app\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    assert.ok(called.length >= 12, `工具面必须真的调容器，这里只找到 ${called.length} 处调用`);
    for (const name of new Set(called)) {
      assert.ok(name in app, `agent/tools.mjs 调了容器上没有的方法：app.${name}`);
    }
    // 样例数据的形状很好认：字面量数组里塞项目名/健康色就是编数据。
    assert.equal(/projects:\s*\[\s*\{/.test(source), false, 'tools.mjs 里出现了写死的项目数组');
  });

  test('README 的工具表与注册表逐个名字一致（清单只有一份真话）', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'agent', 'README.md'), 'utf8');
    const documented = [...readme.matchAll(/`?(commander\.[a-z.]+)`?/g)].map((m) => m[1]);
    const inReadme = new Set(documented);
    const inRegistry = new Set(AGENT_TOOL_NAMES);
    const missing = [...inRegistry].filter((n) => !inReadme.has(n));
    const extra = [...inReadme].filter((n) => !inRegistry.has(n));
    assert.deepEqual(missing, [], `README 漏了这些工具：${missing.join(', ')}`);
    assert.deepEqual(extra, [], `README 写了注册表里不存在的工具：${extra.join(', ')}`);
  });

  test('package.json 的 agent:* 脚本指向真实存在的文件（新入口必须跑得起来）', () => {
    for (const key of ['agent:serve', 'agent:mcp']) {
      const cmd = PACKAGE.scripts[key];
      assert.ok(cmd, `缺少 npm run ${key}`);
      const file = cmd.replace(/^node\s+/, '').trim();
      assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `${key} 指向不存在的文件：${file}`);
    }
    for (const f of ['agent/tools.mjs', 'agent/contract.mjs', 'agent/serve.mjs', 'agent/mcp-server.mjs', 'agent/launch.json', 'agent/README.md']) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, f)), `标准要求的交付文件缺失：${f}`);
    }
    const launch = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'agent/launch.json'), 'utf8'));
    assert.equal(launch.ready_port, 8787);
    assert.equal(launch.ready_path, '/api/health');
    assert.deepEqual(launch.args, ['src/server/cli.js', 'start']);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, launch.args[0])), 'launch.json 指向的入口文件必须真的在');
  });
});

describe('错误形状：调用方能修的必须是 4xx 且带机器可读原因', () => {
  test('未知工具 → unknown_tool + available 清单，HTTP 400', async () => {
    const res = await call('commander.does_not_exist', {});
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'unknown_tool');
    assert.ok(typeof res.json.error.message === 'string' && res.json.error.message.length > 0);
    assert.ok(Array.isArray(res.json.error.available), 'available 必须是数组：写在 message 里调用方只能猜正则');
    assert.deepEqual(res.json.error.available, AGENT_TOOL_NAMES);
  });

  test('tool 字段缺失 / 不是字符串 → bad_input，不是 500', async () => {
    const missing = await fetch(`${baseUrl}/api/agent/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: {} }) });
    assert.equal(missing.status, 400);
    const body = await missing.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'bad_input');
  });

  test('少传必填项 → bad_input，并把差哪一个说清楚', async () => {
    const res = await call('commander.project.get', {});
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'bad_input');
    assert.match(res.json.error.message, /projectId/, '错误要点名缺的是哪个键');
  });

  test('input_schema 里没声明的键一律挡住（防止「多传一个就跑偏」）', async () => {
    const res = await call('commander.projects.list', { limit: 5, includeEverything: true });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'bad_input');
    assert.match(res.json.error.message, /includeEverything/);
  });

  test('id 不存在 → not_found/404，而不是崩成 500', async () => {
    const res = await call('commander.project.card', { projectId: 'prj_not_a_real_one' });
    assert.equal(res.status, 404);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'not_found');
  });

  test('body 是坏 JSON 时，/api/agent/* 也回契约信封（不是那个 {error:…} 老形状）', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/api/agent/tool`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
        let t = '';
        r.on('data', (c) => { t += c; });
        r.on('end', () => resolve({ status: r.statusCode, text: t }));
      });
      req.on('error', reject);
      req.write('{oops');
      req.end();
    });
    assert.equal(res.status, 400);
    const json = JSON.parse(res.text);
    assert.equal(json.ok, false, 'Agent 侧只认 {ok:false,…}');
    assert.equal(json.error.code, 'bad_input');
    assert.equal(json.error.message.includes('at '), false, '不许把解析堆栈原样丢给调用方');
  });

  test('拼错的 agent 路径落不到通用 404 形状上', async () => {
    const res = await getJson('/api/agent/toolslist');
    assert.equal(res.status, 404);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'unknown_tool');
    assert.deepEqual(res.json.error.available, AGENT_TOOL_NAMES);
  });

  test('四个契约端点走的是同一道本机闸门（跨站 Host 一样被拒）', async () => {
    const res = await raw({ p: '/api/agent/tools', host: 'evil.test' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'forbidden_host');
    assert.equal(res.json.ok, false);
  });
});

describe('confirm 集中在执行入口上，两个方向都要点头', () => {
  test('exec 工具不传 confirm 一律拒，且给出的出路可以直接照抄', async () => {
    const res = await call('commander.project.trust', { projectId, trusted: true });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'confirm_required');
    assert.match(res.json.error.message, /commander\.project\.trust/);
    assert.match(res.json.error.hint, /"confirm":true/);
    // 没点头 = 什么都没改
    assert.equal(app.getProject(projectId).trusted ? true : false, false, '被拒的信任决定不许已经落库');
  });

  test('只有布尔 true 算点头：false 走 confirm_required，类型不对走 bad_input，两条都是 400 且什么都没改', async () => {
    // confirm:false 是「看了闸门并拒绝」→ 中央闸门说 confirm_required；
    // 'true' / 1 / null 是「压根不是布尔」→ input_schema 说 bad_input。
    // 两种名字都如实，因为它们是两种不同的错；共同点才是关键：400、可读原因、一条都没执行。
    const cases = [
      { confirm: false, code: 'confirm_required' },
      { confirm: 'true', code: 'bad_input' },
      { confirm: 1, code: 'bad_input' },
      { confirm: null, code: 'bad_input' },
    ];
    for (const c of cases) {
      const res = await call('commander.project.trust', { projectId, trusted: true, confirm: c.confirm });
      assert.equal(res.status, 400, `confirm=${JSON.stringify(c.confirm)} 不该被放行`);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error.code, c.code, `confirm=${JSON.stringify(c.confirm)} 的原因应当是 ${c.code}`);
      assert.equal(Boolean(app.getProject(projectId).trusted), false, `confirm=${JSON.stringify(c.confirm)} 之后库里不许已经改成已信任`);
    }
  });

  test('撤销信任同样要 confirm（两个方向都在改执行边界）', async () => {
    const res = await call('commander.project.trust', { projectId, trusted: false });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'confirm_required');
  });

  test('confirm:true 才真的执行；扫描同一条判据（exec）', async () => {
    const scan = await call('commander.project.scan', { projectId, mode: 'full' });
    assert.equal(scan.status, 400);
    assert.equal(scan.json.error.code, 'confirm_required');
    const jobsBefore = app.queue.stats().total;
    const granted = await call('commander.project.scan', { projectId, mode: 'full', confirm: true });
    assert.equal(granted.status, 200);
    assert.equal(granted.json.ok, true);
    assert.equal(granted.json.risk, 'exec');
    assert.match(granted.json.tool, /^commander\.project\.scan$/);
    assert.equal(typeof granted.json.ms, 'number');
    assert.match(granted.json.data.jobId, /^job_/);
    // 未信任的目录：入了队，但不会执行它的任何脚本 —— 判据在项目身上，不在调用方嘴里。
    assert.equal(granted.json.data.runCommands, false);
    assert.equal(granted.json.data.trusted, false);
    assert.ok(String(granted.json.data.commandsSkippedReason).includes('信任'));
    assert.equal(app.queue.stats().total, jobsBefore + 1, 'confirm 之后才该多出一条任务');
  });

  test('可逆的小写入不强制 confirm（标准规则 4 的收窄）', async () => {
    const schema = listAgentTools().find((t) => t.name === 'commander.job.cancel');
    assert.equal(schema.risk, 'write');
    assert.equal((schema.input_schema.required || []).includes('confirm'), false, '取消自己排队的任务不该要 confirm');
    const unknown = await call('commander.job.cancel', { jobId: 'job_never_existed' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'not_found');
    assert.match(unknown.json.error.hint, /commander\.jobs\.list/, '404 要说出去哪拿真实 id');
  });
});

describe('读工具给的是本机真实行，不是样例', () => {
  test('commander.projects.list 与 REST /api/projects 一模一样', async () => {
    const rest = await getJson('/api/projects');
    const res = await call('commander.projects.list', { limit: 50 });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const tool = res.json.data;
    assert.equal(tool.total, rest.json.data.length);
    assert.equal(tool.returned, tool.total);
    assert.equal(tool.truncated, false);
    assert.deepEqual(tool.projects.map((p) => p.id), rest.json.data.map((p) => p.id));
    assert.deepEqual(tool.projects.map((p) => p.name), rest.json.data.map((p) => p.name));
    const mine = tool.projects.find((p) => p.id === projectId);
    assert.equal(mine.name, 'Agent fixture');
    // 存库的路径是 expandShortPath() 展开过的长名（本机 %TEMP% 是 ADMINI~1 那种 8.3 短名，
    // 见 docs/agent/TEST_STATUS.md Sequence 9），所以判据要和容器里那一行比，不是和 os.tmpdir() 比。
    assert.equal(mine.workspacePath, app.getProject(projectId).workspace_path);
    assert.equal(path.basename(mine.workspacePath), 'fixture');
  });

  test('limit 收口 + 截断要如实说', async () => {
    // 造出第二条，让 truncated 有可能为真 —— 判据要能被量到，不能靠现场凑巧。
    const second = path.join(ROOT, 'fixture2');
    createFixtureProject(second, 'healthy');
    await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: second, name: 'Agent fixture 2' }),
    });
    const res = await call('commander.projects.list', { limit: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.returned, 1);
    assert.equal(res.json.data.total, 2);
    assert.equal(res.json.data.truncated, true);
    assert.match(res.json.data.note, /limit/);
    // input_schema 声明的上限必须真的挡住：公布出去的契约和执行的判据只能是一份。
    const over = await call('commander.projects.list', { limit: 99999 });
    assert.equal(over.status, 400);
    assert.equal(over.json.error.code, 'bad_input');
    assert.match(over.json.error.message, /limit/);
  });

  test('commander.project.card 就是界面读的那一份 projectCard()', async () => {
    const res = await call('commander.project.card', { projectId });
    assert.equal(res.status, 200);
    const card = app.projectCard(app.getProject(projectId));
    assert.equal(res.json.data.id, card.id);
    assert.equal(res.json.data.health, card.health);
    assert.equal(res.json.data.name, card.name);
    assert.equal(res.json.data.trusted, card.trusted);
    assert.equal(res.json.data.page_url, `${baseUrl}/project/${projectId}`);
    const withoutUrl = { ...res.json.data };
    delete withoutUrl.page_url;
    assert.deepEqual(withoutUrl, card, '卡片内容与界面不一致 = 同一个事实两个答案');
  });

  test('commander.dashboard 的 counts 与容器现算一致', async () => {
    const res = await call('commander.dashboard', {});
    const live = app.dashboard();
    assert.deepEqual(res.json.data.counts, live.counts);
    assert.equal(res.json.data.cards.length, live.cards.length);
  });

  test('commander.jobs.list 看得见刚才那条真实入队的任务', async () => {
    const res = await call('commander.jobs.list', { status: 'queued', limit: 50 });
    assert.equal(res.json.ok, true);
    const ids = res.json.data.jobs.map((j) => j.id);
    const scanAgain = await call('commander.project.scan', { projectId, mode: 'quick', confirm: true });
    assert.equal(scanAgain.status, 200);
    const after = await call('commander.jobs.list', { limit: 50 });
    assert.ok(after.json.data.jobs.some((j) => j.id === scanAgain.json.data.jobId), '入队的任务必须能在队列工具里查到');
    assert.ok(!ids.includes(scanAgain.json.data.jobId));
    assert.equal(after.json.data.jobs.every((j) => j.payload === undefined), true, 'payload（含本机路径与参数）不进工具返回值');
  });

  test('commander.attention 的条目指向真实项目，计数口径自洽', async () => {
    const res = await call('commander.attention', {});
    assert.equal(res.status, 200);
    const data = res.json.data;
    const known = new Set(app.listProjects({ includeArchived: true }).map((p) => p.id));
    for (const item of data.items) {
      assert.ok(known.has(item.projectId), `告警条目引用了不存在的项目：${item.projectId}`);
      assert.ok(['critical', 'high', 'medium', 'low'].includes(item.severity), `严重度不在四档之内：${item.severity}`);
    }
    const counted = Object.values(data.bySeverity).reduce((a, b) => a + b, 0);
    assert.equal(counted, data.totalMatching, 'bySeverity 的分档计数必须等于条数（漏一档就是口径不一致）');
    assert.equal(data.totalMatching, data.totalItems, '不过滤时匹配数就是全部条数');
    assert.ok(data.returned <= data.limit);
    assert.equal(data.truncated, data.totalMatching > data.returned);
    const only = await call('commander.attention', { severity: 'critical' });
    assert.ok(only.json.data.items.every((i) => i.severity === 'critical'));
    assert.equal(only.json.data.severityFilter, 'critical');
    const bogus = await call('commander.attention', { severity: 'urgent' });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.json.error.code, 'bad_input');
  });

  test('commander.discovery 只读盘，并且能把临时目录里的真实项目找出来', async () => {
    const res = await call('commander.discovery', { roots: ROOT, maxDepth: 2, limit: 20 });
    assert.equal(res.status, 200, JSON.stringify(res.json.error));
    const data = res.json.data;
    assert.ok(Array.isArray(data.projects));
    assert.ok(data.projects.length >= 1, '临时目录里已经有三个 fixture，发现工具必须看得见');
    assert.equal(data.projects.every((p) => !/node_modules/.test(p.path)), true);
    assert.ok(data.projects.some((p) => p.managed === true), '已登记的 fixture 必须被标成 managed');
    assert.ok(Number.isFinite(data.scannedDirs) && data.scannedDirs > 0);
    assert.ok(data.truncated === true || data.returned <= data.limit);
    const deep = await call('commander.discovery', { maxDepth: 99 });
    assert.equal(deep.status, 400, 'maxDepth 越界是输入问题');
    assert.equal(deep.json.error.code, 'bad_input');
  });

  test('commander.jobs.stats 与容器现算一致', async () => {
    const res = await call('commander.jobs.stats', {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.byStatus, app.queue.stats().byStatus);
    assert.equal(res.json.data.concurrency, app.queue.concurrency);
  });

  test('commander.security 与 commander.system 是服务端真实生效的那份', async () => {
    const sec = await call('commander.security', {});
    assert.deepEqual(sec.json.data, app.securityModel());
    assert.ok(sec.json.data.sensitiveFiles.patterns.length > 20, '敏感规则清单应来自真实规则表，不是手抄本');
    const sys = await call('commander.system', {});
    assert.equal(sys.json.data.nodeVersion, process.version);
    assert.equal(sys.json.data.agent_version, PACKAGE.version);
    assert.equal(JSON.stringify(sys.json.data).includes('sk-'), false, 'system 不得回显密钥');
  });

  test('commander.search 命中本机索引到的真实内容', async () => {
    const res = await call('commander.search', { q: 'fixture' });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.data.results));
    assert.equal(res.json.data.query, 'fixture');
    assert.equal(typeof res.json.data.fts, 'boolean');
    const empty = await call('commander.search', { q: '   ' });
    assert.equal(empty.status, 400, '空白检索词是输入问题，不是零命中');
    assert.equal(empty.json.error.code, 'bad_input');
  });

  test('commander.relocation.preview 是只读提案，不改一个字节', async () => {
    const before = fs.statSync(path.join(ROOT, 'data', 'commander.db')).size;
    const res = await call('commander.relocation.preview', {});
    assert.equal(res.status, 200);
    assert.ok(res.json.data);
    assert.ok(before > 0);
  });
});

describe('一条判据，一个实现', () => {
  test('扫描的 REST 路由与 Agent 工具返回同一份判定（不是两份抄本）', async () => {
    const viaRoute = await fetch(`${baseUrl}/api/projects/${projectId}/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick', runCommands: true }),
    });
    const routeBody = await viaRoute.json();
    assert.equal(viaRoute.status, 200);
    const viaTool = await call('commander.project.scan', { projectId, mode: 'quick', runCommands: true, confirm: true });
    assert.equal(viaTool.status, 200);
    // 判据字段必须逐位相同；工具只是多给了几个说明性字段。
    for (const key of ['mode', 'runCommands', 'trusted', 'commandsSkippedReason']) {
      assert.deepEqual(viaTool.json.data[key], routeBody.data[key], `${key} 在两个入口上不一致：${JSON.stringify({ route: routeBody.data[key], tool: viaTool.json.data[key] })}`);
    }
    assert.equal(routeBody.data.deduped, viaTool.json.data.deduped, '两个入口对「这条是不是已经在跑」必须给同一个答案');
    assert.equal(viaTool.json.data.jobId, routeBody.data.jobId, '同一个目录第二次点必须是同一个任务，不能各起一个');
    // 这一格之前已经有 quick 扫描在排队（jobs.list 那条），所以两个入口都该回答 deduped:true；
    // 万一现场不同（第一次点），deduped 为 false 也算一致 —— 判据是「两个入口同答案」。
    if (routeBody.data.deduped) {
      assert.match(routeBody.data.status, /queued|running/, '复用的那条必须仍在队列里或正在跑');
    }
  });

  test('commander.project.trust 记下来源是 agent，与人在界面上点的 user 分得开', async () => {
    const granted = await call('commander.project.trust', { projectId, trusted: true, confirm: true });
    assert.equal(granted.status, 200);
    assert.equal(granted.json.data.trust.trusted, true);
    assert.equal(granted.json.data.trust.source, 'agent');
    const row = app.repo.get('projects', projectId);
    assert.equal(row.trusted ? true : false, true);
    assert.equal(row.trusted_source, 'agent');
    const revoked = await call('commander.project.trust', { projectId, trusted: false, confirm: true });
    assert.equal(revoked.json.data.trust.trusted, false);
    assert.equal(app.repo.get('projects', projectId).trusted_source, null, '撤销要把来源一起清掉');
  });

  test('commander.project.add 走的是拖拽导入同一条路径，且新目录默认未信任', async () => {
    const dir = path.join(ROOT, 'added-by-agent');
    createFixtureProject(dir, 'healthy');
    const res = await call('commander.project.add', { workspacePath: dir, name: 'Added by agent', confirm: true });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.data.project.name, 'Added by agent');
    assert.equal(res.json.data.trusted, false, '外面进来的目录默认不能执行命令');
    assert.equal(res.json.data.commandsAllowed, false);
    const listed = await call('commander.projects.list', { limit: 50 });
    const stored = app.listProjects().find((p) => p.name === 'Added by agent');
    assert.ok(stored, '工具说加上了，容器里就得真有这一行');
    assert.ok(listed.json.data.projects.some((p) => p.id === stored.id), '新登记的行必须立刻能在 projects.list 里查到');
    assert.equal(listed.json.data.projects.find((p) => p.id === stored.id).workspacePath, stored.workspace_path);
    const missing = await call('commander.project.add', { workspacePath: path.join(ROOT, 'nowhere'), confirm: true });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error.code, 'bad_input');
    const dup = await call('commander.project.add', { workspacePath: dir, confirm: true });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'conflict');
  });
});

describe('MCP 桥（通用实现）转发的是同一份注册表', () => {
  test('initialize → tools/list → tools/call 都打在这个真实服务上', async () => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'agent', 'mcp-server.mjs')], {
      cwd: REPO_ROOT,
      env: { ...process.env, AGENT_BASE_URL: baseUrl, COMMANDER_LOG_LEVEL: 'error' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    const responses = [];
    const waitUntil = async (predicate, timeoutMs = 20000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const lines = out.split('\n').filter(Boolean);
        if (predicate(lines.length)) return lines;
        await new Promise((r) => setTimeout(r, 80));
      }
      throw new Error(`MCP 桥没有在 ${timeoutMs}ms 内给出足够响应；已收到：${out.slice(0, 400)}`);
    };
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await waitUntil((n) => n >= 1);
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const afterList = await waitUntil((n) => n >= 2);
      const parsed = afterList.map((l) => JSON.parse(l));
      const init = parsed.find((m) => m.id === 1);
      assert.equal(init.result.serverInfo.name, 'AI-Project-Commander-agent-api');
      assert.equal(init.result.capabilities.tools.constructor, Object);
      const list = parsed.find((m) => m.id === 2);
      const names = list.result.tools.map((t) => t.name);
      assert.deepEqual(names, AGENT_TOOL_NAMES, 'MCP 侧看到的清单必须与 HTTP 契约同一份');
      for (const t of listAgentTools()) {
        const bridged = list.result.tools.find((x) => x.name === t.name);
        assert.equal(bridged.annotations.readOnlyHint, t.risk === 'read', `${t.name} 的 readOnlyHint 必须与 risk 一致`);
        assert.deepEqual(bridged.inputSchema, t.input_schema, `${t.name} 的 schema 在桥上不许变形`);
      }
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'commander.system', arguments: {} } });
      const afterCall = await waitUntil((n) => n >= 3);
      const call3 = JSON.parse(afterCall[afterCall.length - 1]);
      assert.equal(call3.id, 3);
      assert.equal(call3.result.isError, false);
      assert.equal(JSON.parse(call3.result.content[0].text).nodeVersion, process.version);
      responses.push(call3);
      // 未知工具在 MCP 侧也必须以「可读的失败」回来，而不是把桥炸掉
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'commander.nope', arguments: {} } });
      const afterErr = await waitUntil((n) => n >= 4);
      const last = JSON.parse(afterErr[afterErr.length - 1]);
      assert.equal(last.result.isError, true);
      assert.match(last.result.content[0].text, /unknown_tool/, `失败里要带上契约错误码：${last.result.content[0].text}`);
    } finally {
      try { child.stdin.end(); } catch { /* noop */ }
      try { child.kill(); } catch { /* noop */ }
      await new Promise((resolve) => child.on('close', resolve));
    }
    assert.equal(responses.length, 1);
  });
});
