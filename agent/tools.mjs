/**
 * Commander 的 Agent 能力注册表（`GET /api/agent/tools` 与 `POST /api/agent/tool` 的唯一实现处）。
 *
 * 三条硬规矩，改这里之前先读：
 *  1. 每个 handler 调的都是容器 `app` 上**已有的方法** —— 与用户点网页上那个按钮走的是同一条
 *     代码路径（扫描那条更明确：`app.queueScan()`，routes 与工具共用一个实现）。绝不在这里
 *     另写一套 SQL、绝不返回写死的样例数据。Agent 拿到的数字和用户在界面上看到的必须同源，
 *     否则同一个事实会有两个答案。
 *  2. `input_schema` 就是对外公布的那份契约，`contract.mjs` 的校验器直接读它（单一来源）。
 *  3. 列表类工具自己按 `limit` 收口，并如实写 `returned / total / truncated`。宁可少给并说
 *     「截断了，翻页或加大 limit」，也不能悄悄砍一半让调用方以为是全部 —— 那正是
 *     「看起来像判据的装饰」的反面。
 *
 * 风险分级（risk）按《AGENT_API_STANDARD.md》规则 4 的判据走，confirm 的强制集中在
 * `executeAgentTool` 一处：`exec` 一律要 `confirm:true`（真的跑命令、真的起进程、真的把某个
 * 目录的执行权打开），可逆的小写入不强制 —— 硬要 confirm 只会把调用方训练成无脑传 true。
 *
 * 真正的不可逆动作**不是工具**：删除项目记录、清空源目录（`source-purge`，要回显口令）、
 * git 推送到远端，这些都只留在需要人亲自点的界面上，不暴露给 Agent。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, AGENT_API_VERSION, AGENT_PROJECT_ID, confirmRequiredFor, validateAgentInput } from './contract.mjs';
import { nowIso } from '../src/core/util.js';
import { categoryLabel } from '../src/core/categories.js';
import { trustState } from '../src/core/trust.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/**
 * 版本号只有一个来源：package.json。
 * 之前 `/api/health` 里写死的是字符串 '0.9.0'，那份字面量和 package.json 没有任何机械联系，
 * 发版改号时它不会跟着改 —— Agent 读到的版本就会和真实构建不一致（说了假话，且说不出差在哪）。
 */
const PACKAGE_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  } catch { /* 落到下面那句实话 */ }
  return 'unknown';
})();

export { AGENT_API_VERSION, AGENT_PROJECT_ID };
export const AGENT_VERSION = PACKAGE_VERSION;

/** 演示项目用的 suite 名称与 scan-sync 端点同一份默认值，不在这里另立一套。 */
const DEFAULT_SUITES = ['unit', 'integration', 'e2e'];

/* ------------------------------------------------------------------ *
 * 取参小工具：每个都只做一个判据 —— 类型不对就 bad_input，绝不静默折算
 * ------------------------------------------------------------------ */

function reqStr(input, key, { maxLength = 1000 } = {}) {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new AgentError('bad_input', `「${key}」必须是非空字符串，收到 ${JSON.stringify(v)}`, `必填项见 GET /api/agent/tools 里这个工具的 input_schema.required。`);
  }
  if (v.length > maxLength) {
    throw new AgentError('bad_input', `「${key}」最长 ${maxLength} 个字符，收到 ${v.length}。`);
  }
  return v.trim();
}

function optStr(input, key, { maxLength = 1000 } = {}) {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new AgentError('bad_input', `「${key}」必须是字符串，收到 ${JSON.stringify(v)}。`);
  if (v.length > maxLength) throw new AgentError('bad_input', `「${key}」最长 ${maxLength} 个字符，收到 ${v.length}。`);
  return v;
}

/** 列表长度上限的统一取法：调用方给多少都收得住，但绝不无界。 */
function limitOf(input, key, { dflt, max }) {
  const v = input[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new AgentError('bad_input', `「${key}」必须是正整数，收到 ${JSON.stringify(v)}。`);
  }
  return Math.min(v, max);
}

/** 截断列表的统一回执：给了 total 与 truncated，调用方才知道自己拿到的是不是一份。 */
function slice(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  return { rows: list.slice(0, limit), total: list.length, truncated: list.length > limit };
}

function baseUrlOf(ctx) {
  return ctx && ctx.baseUrl ? ctx.baseUrl : '';
}

/** 界面里这一条数据的落点，方便人亲自去核对（不是 Agent 必须用的东西）。 */
function pageUrl(ctx, pathName) {
  const base = baseUrlOf(ctx);
  return base ? `${base}${pathName}` : null;
}

/* ------------------------------------------------------------------ *
 * read · 项目与工作区
 * ------------------------------------------------------------------ */

async function projectsList(input, ctx) {
  const limit = limitOf(input, 'limit', { dflt: 50, max: 200 });
  const rows = ctx.app.listProjects({ includeArchived: input.includeArchived === true });
  const { rows: kept, total, truncated } = slice(rows, limit);
  return {
    projects: kept.map((p) => ctx.app.projectCard(p)),
    returned: kept.length,
    total,
    limit,
    truncated,
    includeArchived: input.includeArchived === true,
    note: truncated ? `只给了前 ${kept.length} 条（共 ${total} 条）。要更多就加大 limit，要某一条的全貌用 commander.project.card。` : null,
    page_url: pageUrl(ctx, '/projects'),
  };
}

async function projectGet(input, ctx) {
  const project = ctx.app.getProject(reqStr(input, 'projectId', { maxLength: 100 }));
  const meta = project.metadata || {};
  const trust = trustState(project);
  // 存库的那一行里 metadata 是整份扫描产物（文件清单、逐用例结果…），动辄上百 KB。
  // 这里给的是**同一行的核心字段** + metadata 的键名清单，而不是把大对象原样倒给调用方；
  // 要分析结论请用 commander.project.card（界面读的正是那一份）。
  return {
    id: project.id,
    name: project.name,
    workspacePath: project.workspace_path,
    description: project.description,
    status: project.status,
    health: project.health,
    category: project.category,
    categoryLabel: categoryLabel(project.category),
    categoryManual: !!project.category_manual,
    isDemo: !!project.is_demo,
    archived: !!project.archived_at,
    watchPaused: !!project.watch_paused,
    trusted: trust.trusted,
    trustedSource: project.trusted_source || null,
    trustLabel: trust.labelZh,
    currentStageId: project.current_stage_id || null,
    primaryLanguage: project.primary_language || null,
    framework: project.framework || null,
    lastAnalyzedAt: project.last_analyzed_at || null,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    metadataKeys: Object.keys(meta),
    hasScanMetadata: Boolean(meta.metadata),
    note: '这是数据库里那一行的核心字段。界面与 Agent 都该读的聚合结论（gate/health/nextAction/风险计数）用 commander.project.card；缓存的整份扫描产物留在本机，不在工具返回值里原样搬运。',
    page_url: pageUrl(ctx, `/project/${project.id}`),
  };
}

async function projectCard(input, ctx) {
  const project = ctx.app.getProject(reqStr(input, 'projectId', { maxLength: 100 }));
  const card = ctx.app.projectCard(project);
  return { ...card, page_url: pageUrl(ctx, `/project/${project.id}`) };
}

async function dashboard(input, ctx) {
  const limit = limitOf(input, 'limit', { dflt: 50, max: 200 });
  const view = ctx.app.dashboard();
  const { rows: kept, total, truncated } = slice(view.cards, limit);
  return {
    counts: view.counts,
    generatedAt: view.generatedAt,
    cards: kept,
    returned: kept.length,
    limit,
    truncated,
    note: 'counts 是全量口径（含每台机器上真实存在的归档数），cards 只给前若干条；两者条数不一致是截断，不是数据对不上。'
      + (truncated ? ` 共 ${total} 张卡片，已给 ${kept.length} 张。` : ''),
    page_url: pageUrl(ctx, '/'),
  };
}

async function attention(input, ctx) {
  const limit = limitOf(input, 'limit', { dflt: 50, max: 300 });
  const severity = optStr(input, 'severity', { maxLength: 20 });
  if (severity && !['critical', 'high', 'medium', 'low'].includes(severity)) {
    throw new AgentError('bad_input', `severity 取值必须是 critical / high / medium / low，收到 ${JSON.stringify(severity)}。`);
  }
  const center = ctx.app.attentionCenter();
  const filtered = severity ? center.items.filter((i) => i.severity === severity) : center.items;
  const { rows: kept, total, truncated } = slice(filtered, limit);
  return {
    items: kept,
    severityFilter: severity || null,
    returned: kept.length,
    totalMatching: total,
    totalItems: center.items.length,
    limit,
    truncated,
    bySeverity: filtered.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {}),
    generatedAt: center.generatedAt,
    note: '条目是引擎算出来的真实告警（构建失败、用例失败、回归、目录不见了…），每条都带 projectId 与严重度，可以直接回 commander.project.card 核对。',
    page_url: pageUrl(ctx, '/attention'),
  };
}

async function security(input, ctx) {
  return ctx.app.securityModel();
}

async function system(input, ctx) {
  const info = ctx.app.systemInfo();
  return { ...info, agent_version: AGENT_VERSION, agent_api: AGENT_API_VERSION };
}

async function search(input, ctx) {
  const limit = limitOf(input, 'limit', { dflt: 40, max: 200 });
  const q = reqStr(input, 'q', { maxLength: 200 });
  const out = ctx.app.search.query(q, { limit });
  return {
    ...out,
    limit,
    returned: out.results.length,
    truncated: out.results.length >= limit,
    note: '命中来自本机 FTS 索引（不可用时按 LIKE 回退，fts 字段会如实写 false）。每条带 table/id，再回对应工具取全量。',
  };
}

async function discovery(input, ctx) {
  const limit = limitOf(input, 'limit', { dflt: 100, max: 300 });
  const rootsRaw = optStr(input, 'roots', { maxLength: 4000 });
  const roots = rootsRaw ? rootsRaw.split('|').filter(Boolean).slice(0, 12) : null;
  const maxDepth = input.maxDepth === undefined ? 3 : Number(input.maxDepth);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 6) {
    throw new AgentError('bad_input', `maxDepth 必须是 1 到 6 的整数，收到 ${JSON.stringify(input.maxDepth)}。`);
  }
  const found = ctx.app.discover({ roots, maxDepth, limit });
  return {
    ...found,
    limit,
    returned: found.projects.length,
    note: '只读磁盘目录标记（package.json/.git/requirements…）判断"这台电脑上有哪些项目"，不写任何东西。roots 缺省时用设置里配置的搜索根，没有配置就用默认根。'
      + ` 本次走了 ${found.scannedDirs} 个目录、耗时 ${found.elapsedMs}ms。`,
    page_url: pageUrl(ctx, '/import'),
  };
}

/* ------------------------------------------------------------------ *
 * read · 队列与 relocate
 * ------------------------------------------------------------------ */

async function jobsList(input, ctx) {
  const limit = limitOf(input, 'limit', { dflt: 50, max: 500 });
  const status = optStr(input, 'status', { maxLength: 20 });
  if (status && !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(status)) {
    throw new AgentError('bad_input', 'status 取值必须是 queued / running / completed / failed / cancelled。', '队列状态机的名字，不是中文标签。');
  }
  const rows = ctx.app.queue.list({ status: status || null, limit });
  const counted = ctx.app.queue.stats();
  return {
    jobs: rows,
    returned: rows.length,
    limit,
    truncated: rows.length >= limit,
    statusFilter: status || null,
    queueStats: counted,
    note: 'jobs 按 created_at 倒序，payload 不进返回值（里面有本机路径与参数，工具用不上）。要看整体是否卡住就对照 queueStats。',
    page_url: pageUrl(ctx, '/jobs'),
  };
}

async function jobsStats(input, ctx) {
  const stats = ctx.app.queue.stats();
  return { ...stats, runningJobIds: ctx.app.queue.running ? [...ctx.app.queue.running.keys()] : undefined, page_url: pageUrl(ctx, '/jobs') };
}

async function relocationPreview(input, ctx) {
  return ctx.app.relocationPlan();
}

/* ------------------------------------------------------------------ *
 * write / exec · 真的动手
 * ------------------------------------------------------------------ */

/**
 * 取消一个任务：可逆的小写入（停掉的是自己排队的活），所以不强制 confirm。
 * 但**如实报告**有没有真取消掉 —— 队列对终态任务返回 false，这里原样转出去。
 */
async function jobCancel(input, ctx) {
  const jobId = reqStr(input, 'jobId', { maxLength: 100 });
  const before = ctx.app.repo.get('analysis_jobs', jobId);
  if (!before) throw new AgentError('not_found', `没有编号为「${jobId}」的任务。`, 'commander.jobs.list 能拿到真实 id（形如 job_…），不要猜。');
  const cancelled = ctx.app.queue.cancel(jobId);
  const after = ctx.app.repo.get('analysis_jobs', jobId);
  return {
    jobId,
    cancelled,
    statusBefore: before.status,
    statusAfter: after ? after.status : null,
    note: cancelled
      ? '已请求取消：正在跑的那条命令会被真的杀掉进程树（src/core/command-runner.js:killProcessTree），行状态停在 CANCELLED。'
      : `这条任务已经是终态（${before.status}），没有东西可取消；返回值没有假装成功。`,
  };
}

async function projectScan(input, ctx) {
  const projectId = reqStr(input, 'projectId', { maxLength: 100 });
  const mode = input.mode === 'quick' ? 'quick' : 'full';
  const suites = input.suites === undefined ? (mode === 'full' ? DEFAULT_SUITES : null) : input.suites;
  // 与 routes.js 的 POST /api/projects/:id/scan 完全同一份实现（app.queueScan），
  // 包括「点两次不重复起构建」和「未信任就不跑命令」这两条判据。
  const out = ctx.app.queueScan(projectId, { mode, runCommands: input.runCommands !== false, suites, priority: 3 });
  const project = ctx.app.getProject(projectId);
  return {
    ...out,
    projectName: project.name,
    suites: suites || null,
    statusNote: out.deduped
      ? '这个目录已经有一条同类型任务在排队或在跑，返回的是那一条 —— 没有再起第二个构建。'
      : '任务已入队。扫描是异步的：完成与否看 commander.jobs.list / commander.jobs.stats，不要以为返回了 jobId 就扫完了。',
    page_url: pageUrl(ctx, `/project/${projectId}`),
  };
}

async function projectAdd(input, ctx) {
  const workspacePath = reqStr(input, 'workspacePath', { maxLength: 1000 });
  const name = optStr(input, 'name', { maxLength: 200 });
  const description = optStr(input, 'description', { maxLength: 2000 }) || '';
  const category = optStr(input, 'category', { maxLength: 40 });
  // 与网页拖拽导入同一条路径：登记 + 真实扫描 + 分类推断（app.addProjectAndClassify）。
  const project = await ctx.app.addProjectAndClassify(workspacePath, {
    name: name || null,
    description,
    category: category || null,
  });
  const card = ctx.app.projectCard(project);
  return {
    project: card,
    trusted: card.trusted,
    commandsAllowed: card.commandsAllowed,
    note: card.trusted
      ? '这条记录已信任，后续扫描会执行它检测到的构建/测试命令。'
      : '新从外面加进来的目录默认**未信任**：这次扫描只读文件、读 Git、解析文档，没有跑它 package.json 里的任何脚本。要跑就得由 commander.project.trust 明确点头（那一步需要 confirm）。',
    page_url: pageUrl(ctx, `/project/${project.id}`),
  };
}

/**
 * 信任决定本身。这是 exec：它打开的是「跑这个目录里的命令」，不是改一行数据。
 * confirm 由 executeAgentTool 集中强制；撤销信任同样要 confirm —— 让人确认的是
 * "我在改变执行边界"这件事，两个方向都该确认，否则撤销就成了一个无成本的误操作。
 */
async function projectTrust(input, ctx) {
  const projectId = reqStr(input, 'projectId', { maxLength: 100 });
  const trusted = input.trusted;
  const out = ctx.app.setProjectTrust(projectId, trusted === true, { source: 'agent' });
  return {
    ...out,
    projectId,
    note: trusted
      ? '来源记为 trusted_source=agent（区别于人在界面上点的 user）。下一次扫描起，这个目录里检测到的构建/测试命令会被真的执行。'
      : '已取消信任：后续扫描只读文件，不再执行这个目录的任何脚本。正在跑的那条命令不会被这条决定回头杀掉（要停任务用 commander.job.cancel）。',
    page_url: pageUrl(ctx, `/project/${projectId}`),
  };
}

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const LIMIT_PROP = (dflt, max) => ({ type: 'integer', minimum: 1, maximum: max, default: dflt, description: `最多返回多少条（上限 ${max}）；返回值里的 total/truncated 会说实话` });
const PROJECT_ID_PROP = { type: 'string', minLength: 1, maxLength: 100, description: '项目 id（prj_…）。用 commander.projects.list 拿真实 id，不要猜。' };

const TOOL_DEFS = [
  {
    name: `${AGENT_PROJECT_ID}.projects.list`,
    description: '什么时候用：想知道这台 Commander 现在管着哪些项目。返回界面同款的卡片数组（health、gate、构建/测试计数、信任状态、下一步建议条数都来自本机数据库里引擎算出的真实结论）。只读，不扫描、不执行任何东西。要看某一条的全貌用 commander.project.card。',
    risk: 'read',
    input_schema: schema({ includeArchived: { type: 'boolean', default: false, description: 'true 时把已归档的记录也算进来' }, limit: LIMIT_PROP(50, 200) }),
    handler: projectsList,
  },
  {
    name: `${AGENT_PROJECT_ID}.project.get`,
    description: '什么时候用：已经有 projectId，需要数据库里那一行的核心字段（路径、状态、分类、语言/框架、是否已信任、上次分析时间、metadata 里有哪些键）。返回的是本机真实记录；projectId 不存在 → not_found。想要分析结论用 commander.project.card，想要整份扫描产物请让人在界面上看。',
    risk: 'read',
    input_schema: schema({ projectId: PROJECT_ID_PROP }, ['projectId']),
    handler: projectGet,
  },
  {
    name: `${AGENT_PROJECT_ID}.project.card`,
    description: '什么时候用：需要「界面上现在看到的那一张卡片」——项目健康色、验收门、构建/单元/集成/E2E 最近一次结果、Git 摘要、风险与回归计数、下一步建议、目录是否还在磁盘上。与网页读同一份 projectCard()，不重新计算也不猜。',
    risk: 'read',
    input_schema: schema({ projectId: PROJECT_ID_PROP }, ['projectId']),
    handler: projectCard,
  },
  {
    name: `${AGENT_PROJECT_ID}.dashboard`,
    description: '什么时候用：一屏看清全局 —— counts 是健康/告警/危急/未知/归档/目录丢失的真实计数，cards 是前若干条卡片。数据与首页同源（同一函数算的），不会两边对不上。只读。',
    risk: 'read',
    input_schema: schema({ limit: LIMIT_PROP(50, 200) }),
    handler: dashboard,
  },
  {
    name: `${AGENT_PROJECT_ID}.attention`,
    description: '什么时候用：想知道"现在最该处理什么"。返回按严重度排序的告警条目（构建失败、用例失败、回归、任务被阻塞、目录不见了、高危风险、规范漂移、待执行的提示词…），每条带 projectId、原因与发生时间。可按 severity 过滤。只读。',
    risk: 'read',
    input_schema: schema({ severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: '只看某一档' }, limit: LIMIT_PROP(50, 300) }),
    handler: attention,
  },
  {
    name: `${AGENT_PROJECT_ID}.security`,
    description: '什么时候用：需要向人解释这台机器的安全边界 —— 命令白名单/黑名单、只监听回环与 Host/Origin 判据、敏感文件规则（28 条模式，取自真实规则表）、工作区只读承诺、以及「命令执行需要显式信任」这条规则从哪来。返回服务端实际生效的那份，不是文档副本。只读。',
    risk: 'read',
    input_schema: schema({}),
    handler: security,
  },
  {
    name: `${AGENT_PROJECT_ID}.system`,
    description: '什么时候用：需要运行环境事实 —— Node 版本、平台、数据目录与库文件路径、FTS 是否可用、队列与 watcher 状态、AI 提供方配置（只报有没有，绝不回显密钥）、服务运行时长。只读。',
    risk: 'read',
    input_schema: schema({}),
    handler: system,
  },
  {
    name: `${AGENT_PROJECT_ID}.search`,
    description: '什么时候用：在本机已索引的内容里找关键词（规范、任务、风险、提示词、事件…）。返回命中条目与其所在表/记录 id；索引不可用时会走 LIKE 回退并在 fts 字段如实写 false。想读某条的完整内容，拿 id 回对应工具。只读。',
    risk: 'read',
    input_schema: schema({ q: { type: 'string', minLength: 1, maxLength: 200, description: '检索词' }, limit: LIMIT_PROP(40, 200) }, ['q']),
    handler: search,
  },
  {
    name: `${AGENT_PROJECT_ID}.discovery`,
    description: '什么时候用：想知道「这台电脑上还有哪些项目目录没被管起来」。只读磁盘目录标记，按 roots/maxDepth 走一遍，返回每个候选的路径、名称、置信度以及是否已被 Commander 管理（managed）。不登记、不写入任何东西。要真的加进来看板，用 commander.project.add（那一步需要 confirm）。',
    risk: 'read',
    input_schema: schema({
      roots: { type: 'string', maxLength: 4000, description: '用 | 分隔的根目录绝对路径，最多 12 个；留空用设置里的搜索根或默认根' },
      maxDepth: { type: 'integer', minimum: 1, maximum: 6, default: 3 },
      limit: LIMIT_PROP(100, 300),
    }),
    handler: discovery,
  },
  {
    name: `${AGENT_PROJECT_ID}.jobs.list`,
    description: '什么时候用：看分析队列的近期任务（id、类型、状态、所属项目、起止时间、超时预算、进度、错误）。可按状态过滤，payload 不返回。这是判断「我刚才排的队跑到哪一步了」的那一份真实状态，不是自述。只读。',
    risk: 'read',
    input_schema: schema({ status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] }, limit: LIMIT_PROP(50, 500) }),
    handler: jobsList,
  },
  {
    name: `${AGENT_PROJECT_ID}.jobs.stats`,
    description: '什么时候用：只需要队列的整体状态（各状态条数、正在跑几条、并发度、是否已停）。比 jobs.list 便宜得多。只读。',
    risk: 'read',
    input_schema: schema({}),
    handler: jobsStats,
  },
  {
    name: `${AGENT_PROJECT_ID}.relocation.preview`,
    description: '什么时候用：有项目目录被移动或删除，想知道 Commander 能提出哪些「改路径」候选。返回每条记录的磁盘现状与同名候选（唯一命中才给候选，两个同名目录就如实报"有歧义，不自动应用"）。纯只读，一个字节都不改。',
    risk: 'read',
    input_schema: schema({}),
    handler: relocationPreview,
  },
  {
    name: `${AGENT_PROJECT_ID}.job.cancel`,
    description: '什么时候用：需要停掉一条排队中或正在跑的分析任务。会真的杀掉那条命令的进程树（不是只把数据库行改成 CANCELLED）。任务已经是终态时返回 cancelled:false 并说清当时状态 —— 不假装成功。',
    risk: 'write',
    input_schema: schema({ jobId: { type: 'string', minLength: 1, maxLength: 100, description: '任务 id（job_…），来自 commander.jobs.list 或 project.scan 的返回值' } }, ['jobId']),
    handler: jobCancel,
  },
  {
    name: `${AGENT_PROJECT_ID}.project.scan`,
    description: '什么时候用：让某个项目重新分析（quick = 只重读文件与 Git，full = 再跑构建与各套测试）。这与人在界面上点「重新扫描」是同一条实现（app.queueScan）：同一个目录第二次点只会拿到已经在跑的那一条（deduped:true），未信任的目录不会执行它的任何脚本（runCommands:false + commandsSkippedReason）。返回 jobId 只代表已入队，不代表扫完。会起进程，所以必须 confirm:true。',
    risk: 'exec',
    input_schema: schema({
      projectId: PROJECT_ID_PROP,
      mode: { type: 'string', enum: ['quick', 'full'], default: 'full', description: 'quick 不跑任何命令；full 会按检测到的命令跑构建与测试（前提是项目已信任）' },
      runCommands: { type: 'boolean', default: true, description: 'false = 这次明确不执行工作区命令（即使项目已信任）' },
      suites: { type: 'array', items: { type: 'string', enum: ['unit', 'integration', 'e2e'] }, maxItems: 3, description: 'full 模式跑哪几套测试；留空按界面默认三套都跑' },
      confirm: { type: 'boolean', description: '必须为 true：确认在这台机器上起一个分析任务（可能真的执行该目录里的脚本）' },
    }, ['projectId']),
    // confirm 故意不进 required：拒它的应当是执行入口那道中央闸门（confirm_required），
    // 而不是 schema 先抢一句 bad_input。同一个原因只有一种说法。
    handler: projectScan,
  },
  {
    name: `${AGENT_PROJECT_ID}.project.add`,
    description: '什么时候用：把一个本地目录登记进 Commander 并做一次真实分析（与网页拖拽导入同一条路径：读文件、读 Git、推断分类、算结论）。目录不存在 → bad_input，已经被管着 → conflict；**绝不新建目录、绝不改工作区里的任何文件**。新登记进来的目录默认未信任，所以这一步不会执行它的脚本；要跑还得 commander.project.trust。会读盘并写 Commander 自己的库，所以必须 confirm:true。',
    risk: 'exec',
    input_schema: schema({
      workspacePath: { type: 'string', minLength: 1, maxLength: 1000, description: '项目目录的绝对路径（必须是磁盘上已存在的文件夹）' },
      name: { type: 'string', maxLength: 200, description: '显示名；留空用目录名' },
      description: { type: 'string', maxLength: 2000 },
      category: { type: 'string', maxLength: 40, description: '留空由分类引擎按真实文件推断' },
      confirm: { type: 'boolean', description: '必须为 true：确认登记并立即分析' },
    }, ['workspacePath']),
    handler: projectAdd,
  },
  {
    name: `${AGENT_PROJECT_ID}.project.trust`,
    description: '什么时候用：为一个目录的执行权做决定。trusted:true 打开的是「扫描时执行这个目录里检测到的构建/测试脚本」——这是提权，不是改一行数据，所以必须 confirm:true；trusted:false 撤销它，同样要 confirm（两个方向都在改变执行边界）。记录里会写明来源是 agent，与人在界面上点的 user 分得开。这一步本身不跑任何东西。',
    risk: 'exec',
    input_schema: schema({
      projectId: PROJECT_ID_PROP,
      trusted: { type: 'boolean', description: 'true = 允许执行该目录的命令；false = 撤销' },
      confirm: { type: 'boolean', description: '必须为 true：确认你正在改变这台机器上的命令执行边界' },
    }, ['projectId', 'trusted']),
    handler: projectTrust,
  },
];

/** 对外只暴露这四列（标准里的工具声明结构）。 */
export const AGENT_TOOLS = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk, handler: t.handler }));

/** 机器可读的工具名清单：unknown_tool 的 available 就是它。 */
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);

export function listAgentTools() {
  return AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk }));
}

/**
 * POST /api/agent/tool 的唯一执行入口：查名字 → 按公布的 schema 校验 → 集中强制 confirm →
 * 调真实能力。任何一步不过都是 4xx 的 `{ok:false,error:{…}}`，不是 500。
 */
export async function executeAgentTool(toolName, rawInput, ctx) {
  if (!ctx || !ctx.app) {
    // 这不是调用方能修的问题：容器没接上就是服务自己没起来。说清是谁的错，别让它伪装成输入错误。
    throw new AgentError('internal_error', 'Agent 工具面没有拿到 Commander 容器（app），服务不完整。');
  }
  if (typeof toolName !== 'string' || !toolName.trim()) {
    throw new AgentError(
      'bad_input',
      '请求体必须形如 {tool:"commander.projects.list",input:{…}}；tool 字段缺失或不是字符串。',
      '先 GET /api/agent/tools 拿准确的工具名与 input_schema。',
    );
  }
  const tool = AGENT_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    const err = new AgentError(
      'unknown_tool',
      `没有名为「${toolName}」的工具。本机一共 ${AGENT_TOOL_NAMES.length} 个，清单在 error.available 里。`,
      '工具名一律带 commander. 前缀；完整描述与 input_schema 见 GET /api/agent/tools。',
    );
    err.available = AGENT_TOOL_NAMES;
    throw err;
  }
  const input = validateAgentInput(tool.input_schema, rawInput);
  // confirm 强制在这一处，不在 16 个 handler 里各写一遍：判据只有一份，
  // 才不会出现「加了一个 exec 工具忘了装闸门」这种事。
  if (confirmRequiredFor(tool) && input.confirm !== true) {
    throw new AgentError(
      'confirm_required',
      `「${tool.name}」是 ${tool.risk}：它真的会在这台机器上动手（起进程 / 改变执行边界 / 写 Commander 的库），所以必须显式传 confirm:true。收到的 confirm 是 ${input.confirm === undefined ? '缺失' : JSON.stringify(input.confirm)} —— 只有布尔 true 才算数。`,
      `想清楚了再调一次：{"tool":"${tool.name}","input":{… , "confirm":true}}。先看不花钱的那份：commander.projects.list / commander.project.card / commander.attention。`,
    );
  }
  const data = await tool.handler(input, ctx);
  return { tool: tool.name, risk: tool.risk, data };
}

/** 契约要的项目身份。version 来自 package.json，见文件顶部。 */
export function agentProjectInfo({ baseUrl = '', bootedAt = null } = {}) {
  return {
    project: AGENT_PROJECT_ID,
    version: AGENT_VERSION,
    agent_api: AGENT_API_VERSION,
    uptime_ms: Number.isFinite(bootedAt) ? Date.now() - bootedAt : Math.round(process.uptime() * 1000),
    tools: AGENT_TOOL_NAMES.length,
    base_url: baseUrl || null,
    at: nowIso(),
  };
}
