/**
 * Agent API 契约的公共部分（personal-agent-hub《docs/AGENT_API_STANDARD.md》v1）。
 *
 * 这里只放「与具体工具无关」的四件事，`agent/tools.mjs` 因此可以只写能力本身：
 *   1. `AgentError` —— 契约里的错误形状：`{ok:false,error:{code,message,hint?}}`；
 *   2. code → HTTP 状态 —— 调用方自己能修的问题（工具名写错、少传必填项、没 confirm）
 *      一律 4xx，绝不回 500：500 在 Agent 侧读起来是「服务坏了」，于是它要么放弃，
 *      要么重试同一句错话；
 *   3. `validateAgentInput` —— 按对外公布的那份 input_schema 校验（单一来源：清单里写的
 *      就是执行时检查的，两边不可能漂移）；
 *   4. `confirmRequiredFor` —— confirm 的判据只写一次（见下方规则 4 的收窄）。
 *
 * 注意：入站安全（Host 回环白名单、Origin/Referer 同源、可选本机令牌）不在这里，
 * 也不在这里重复一遍 —— 那是 `src/server/local-guard.js` 的职责，四个契约端点与界面、
 * SPA 走的是同一道闸门。把这里当闸门 = 闸门不存在。
 */
import { CommanderError } from '../src/domain/errors.js';

export const AGENT_PROJECT_ID = 'commander';
export const AGENT_API_VERSION = 1;

/** 契约错误。code 是给机器读的，message 是给人看的，hint 是「下一步该按哪个键」。 */
export class AgentError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.hint = hint;
  }
}

/**
 * code → HTTP 状态。四个契约端点靠状态码区分「改你的请求」(4xx) 与「改我的代码」(5xx)，
 * 所以表里必须覆盖所有调用方可修的码，漏一个就会掉进 500 那一档。
 */
const HTTP_BY_CODE = Object.freeze({
  bad_input: 400,
  unknown_tool: 400,
  confirm_required: 400,
  not_found: 404,
  conflict: 409,
  workspace_untrusted: 403,
  command_blocked: 403,
  forbidden: 403,
  engine_busy: 409,
  provider_error: 502,
  schema_mismatch: 502,
  internal_error: 500,
});

export function agentHttpStatus(code) {
  return HTTP_BY_CODE[code] || 400;
}

/**
 * 项目内部错误码 → 契约错误码，**只查表，不重算**。
 * 出口有两处会用到它：`toAgentError`（工具执行路径）与 `src/server/http-server.js`
 * 的错误分支（请求还没进到 handler 就失败了，例如 body 不是合法 JSON）。
 * 两处共用这一张表，才不会出现「同一个错在两个入口上叫两个名字」。
 */
export function contractCodeFor(code, status = 0) {
  if (CODE_BY_APP_ERROR[code]) return CODE_BY_APP_ERROR[code];
  if (HTTP_BY_CODE[code]) return code;
  if (Number(status) >= 500) return 'internal_error';
  return 'bad_input';
}

/**
 * 项目内部错误 → 契约错误。判据只有一条：**能不能被调用方修**。
 * `ValidationError`(validation_error) / `WorkspaceError`(workspace_error) 都是「你的输入不行」，
 * 在契约里就叫 `bad_input`；带 5xx 的（provider/schema）原样留着，那确实是外面坏了。
 */
const CODE_BY_APP_ERROR = Object.freeze({
  validation_error: 'bad_input',
  workspace_error: 'bad_input',
  not_found: 'not_found',
  conflict: 'conflict',
  workspace_untrusted: 'workspace_untrusted',
  command_blocked: 'command_blocked',
  provider_error: 'provider_error',
  schema_mismatch: 'schema_mismatch',
});

export function toAgentError(err) {
  if (err instanceof AgentError) return err;
  if (err instanceof CommanderError) {
    const mapped = CODE_BY_APP_ERROR[err.code];
    if (mapped) {
      const message = err.expose === false ? `${err.code}（服务端未展开详情）` : err.message;
      return new AgentError(mapped, message, err.hint || '');
    }
    // 认识的错误类型但状态是 5xx：按它自己的状态走，别硬折成 400。
    if (err.status >= 500) return new AgentError(err.code || 'internal_error', err.expose === false ? 'internal error' : err.message, err.hint || '');
    return new AgentError(err.code || 'bad_input', err.expose === false ? 'internal error' : err.message, err.hint || '');
  }
  // 到这里就是「程序自己炸了」（TypeError / ReferenceError / SQLite 报错…）。
  // 不能把堆栈或未脱敏的原话交给调用方，也不能把它伪装成可修的输入错误。
  return new AgentError('internal_error', `服务内部错误：${err && err.name ? err.name : '未知异常'}（这条不是你的输入问题，见服务端日志）`);
}

/** 契约要求的成功信封（四个端点唯一的写出形状）。 */
export function okEnvelope(data, extra = {}) {
  return { ok: true, data, ...extra };
}

export function errorEnvelope(err) {
  const e = toAgentError(err);
  const error = { code: e.code, message: e.message };
  if (e.hint) error.hint = e.hint;
  // unknown_tool 的清单必须是机器可读的数组：写在 message 里的话，调用方只能去猜正则。
  if (e.code === 'unknown_tool' && Array.isArray(e.available)) error.available = e.available;
  return { ok: false, error };
}

/* ------------------------------------------------------------------ *
 * confirm 判据（标准里的规则 4，按判据收窄）
 * ------------------------------------------------------------------ */

/**
 * 「破坏性」的中文/英文动词。标准说得很清楚：confirm 的要求要按判据收窄，别把调用方
 * 训练成无脑传 true。所以 exec（真的跑命令、真的起进程、真的打开执行权）一律要 confirm；
 * write 只有在名字或描述里出现删除/清空/覆盖/重置这类不可逆动词时才要。
 * commander.project.trust 属于 exec —— 它打开的是「跑这个目录里的 package.json 脚本」，
 * 这是提权，不是改一行数据。
 */
const DESTRUCTIVE_VERBS = /(删除|清空|覆盖|重置|销毁|wipe|delete|remove|overwrite|reset|purge)/i;

export function confirmRequiredFor(tool) {
  if (!tool) return false;
  if (tool.risk === 'exec') return true;
  if (tool.risk === 'write') return DESTRUCTIVE_VERBS.test(`${tool.name} ${tool.description}`) === true;
  return false;
}

/* ------------------------------------------------------------------ *
 * input_schema 校验（公布的那份就是执行的那份）
 * ------------------------------------------------------------------ */

const SUPPORTED_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}

function fail(issues, path, message) {
  issues.push(`${path}: ${message}`);
}

function validateValue(value, schema, path, issues) {
  if (!schema || typeof schema !== 'object') return;
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.length && !types.some((t) => matchesType(value, t))) {
    fail(issues, path, `类型应为 ${types.join(' | ')}，收到 ${typeOf(value)}`);
    return;
  }
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(issues, path, `最长 ${schema.maxLength} 个字符，收到 ${value.length}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(issues, path, `最短 ${schema.minLength} 个字符，收到 ${value.length}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      fail(issues, path, `取值必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')}，收到 ${JSON.stringify(value)}`);
    }
    if (schema.pattern && new RegExp(schema.pattern).test(value) === false) {
      fail(issues, path, `格式不符合 ${schema.pattern}`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(issues, path, `不得小于 ${schema.minimum}，收到 ${value}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(issues, path, `不得大于 ${schema.maximum}，收到 ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(issues, path, `最多 ${schema.maxItems} 项，收到 ${value.length}`);
      return;
    }
    if (schema.items) value.forEach((item, i) => validateValue(item, schema.items, `${path}[${i}]`, issues));
    return;
  }
  if (value && typeof value === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined) fail(issues, `${path}.${key}`, '缺少必填项');
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!props[key]) fail(issues, `${path}.${key}`, '不在 input_schema 里（additionalProperties:false）');
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) validateValue(value[key], sub, `${path}.${key}`, issues);
    }
  }
}

/**
 * 按工具公布的 input_schema 校验入参，返回带默认值的副本。
 * 不合法 → `bad_input`，并把每一条问题都列出来（一次说全，别让调用方一轮一轮地猜）。
 */
export function validateAgentInput(schema, rawInput) {
  const input = rawInput === undefined || rawInput === null ? {} : rawInput;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentError('bad_input', 'input 必须是一个 JSON 对象。', 'body 形如 {"tool":"commander.projects.list","input":{"limit":20}}。');
  }
  const issues = [];
  validateValue(input, schema || { type: 'object' }, 'input', issues);
  if (issues.length) {
    throw new AgentError(
      'bad_input',
      `入参不符合 ${issues.length} 处：${issues.join('；')}`,
      'GET /api/agent/tools 里的 input_schema 就是这一份判据；缺什么补什么，多余的键要去掉。',
    );
  }
  // 默认值由 schema 决定，不写在 handler 里 —— 否则清单说的默认和实际默认会分叉。
  const out = { ...input };
  for (const [key, sub] of Object.entries((schema && schema.properties) || {})) {
    if (out[key] === undefined && sub && sub.default !== undefined) out[key] = sub.default;
  }
  return out;
}

export { SUPPORTED_TYPES };
