/** DOM helpers. Everything renders via textContent — no innerHTML with dynamic data (XSS-safe). */

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = v; // only ever used with static, self-authored markup
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'for') el.setAttribute('for', v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) { append(parent, c); continue; }
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return parent;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/** Windows paths arrive as both C:\dir and c:/dir. Used to decide whether a path really changed. */
export function sameLocalPath(a, b) {
  const norm = (s) => String(s || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b) && norm(a) !== '';
}

/** Server errors carry a technical message plus a user-facing hint; the UI shows both. */
export function errorText(err) {
  const message = (err && err.message) || '未知错误';
  return err && err.hint ? `${message} —— ${err.hint}` : message;
}
export function frag(children) { return append(document.createDocumentFragment(), children); }

export const fmt = {
  date(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  },
  time(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },
  rel(ts) {
    if (!ts) return '—';
    const diff = Date.now() - new Date(ts).getTime();
    if (Number.isNaN(diff)) return '—';
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s} 秒前`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const hr = Math.round(m / 60);
    if (hr < 24) return `${hr} 小时前`;
    const d = Math.round(hr / 24);
    return `${d} 天前`;
  },
  duration(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  },
  num(n) { return n === null || n === undefined ? '—' : Number(n).toLocaleString(); },
  bytes(b) {
    if (b === null || b === undefined) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  },
  truncate(s, n = 160) {
    const str = String(s ?? '');
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
  },
};

const HEALTH_CLASS = { healthy: 'badge-healthy', warning: 'badge-warning', critical: 'badge-critical', unknown: 'badge-unknown' };
const HEALTH_ZH = { healthy: '健康', warning: '警告', critical: '危急', unknown: '未知' };
const STATUS_CLASS = {
  pass: 'badge-pass', fail: 'badge-fail', error: 'badge-fail', timeout: 'badge-warning',
  unsupported: 'badge-unsupported', unknown: 'badge-unknown', error_unparsed: 'badge-warning',
};
const STATUS_ZH = {
  pass: '通过', fail: '失败', failed: '失败', error: '错误', timeout: '超时',
  unsupported: '不适用', unknown: '未知', queued: '排队中', running: '运行中',
  completed: '已完成', cancelled: '已取消', generated: '已生成', executed: '已执行',
};
const GATE_ZH = { PASS: '通过', FAIL: '未通过', BLOCKED: '阻塞', UNKNOWN: '未知' };
const PROJECT_STATUS_ZH = {
  planning: '规划中', developing: '开发中', testing: '测试中', review: '评审中',
  blocked: '已阻塞', ready: '就绪', released: '已发布', archived: '已归档',
};

export function healthLabel(status) { return HEALTH_ZH[status] || status || '未知'; }
export function runStatusLabel(status) { return STATUS_ZH[status] || status || '未知'; }
export function projectStatusLabel(status) { return PROJECT_STATUS_ZH[status] || status || '未知'; }

/** Display labels for task / risk / issue / ADR / severity enums. Keys stay English on the wire. */
const ENUM_ZH = {
  todo: '待办', in_progress: '进行中', blocked: '已阻塞', done: '已完成', cancelled: '已取消',
  open: '待处理', resolved: '已解决',
  proposed: '待评审', accepted: '已采纳', deprecated: '已废弃', superseded: '已被取代',
  satisfied: '已满足', unmet: '未满足',
  critical: '危急', high: '高', medium: '中', low: '低', info: '提示',
  unknown: '未知', manual: '手动', deterministic: '确定性', inferred: '推断',
  aligned: '一致', possible_drift: '可能漂移', drifted: '已漂移',
  stages: '阶段', tasks: '任务', acceptance: '验收',
};
export function enumLabel(value) { return ENUM_ZH[value] || value || ''; }

export function healthBadge(status) {
  return h('span', { class: `badge ${HEALTH_CLASS[status] || 'badge-unknown'}`, text: healthLabel(status) });
}

export function statusBadge(status) {
  return h('span', { class: `badge ${STATUS_CLASS[status] || 'badge-unknown'}`, text: runStatusLabel(status) });
}

export function gateBadge(gate) {
  if (!gate) return h('span', { class: 'badge badge-unknown', text: '验收门：未评估' });
  const cls = gate.result === 'PASS' ? 'badge-pass' : gate.result === 'BLOCKED' ? 'badge-critical' : gate.result === 'FAIL' ? 'badge-fail' : 'badge-unknown';
  return h('span', { class: `badge ${cls}`, text: `验收门：${GATE_ZH[gate.result] || gate.result}`, title: gate.explanation || '' });
}

export function mockBadge(provider) {
  if (!provider) return null;
  if (provider === 'mock') return h('span', { class: 'badge badge-mock', title: '由确定性 Mock 提供方生成——不是真实大模型', text: 'mock（确定性）' });
  return h('span', { class: 'badge badge-info', text: provider });
}

/**
 * A test-suite label. A run with no parsed cases never renders as a count: "0/0"
 * reads as "zero of zero tests failed", and a green 通过 would claim success from
 * no evidence at all.
 */
export function suiteResult(run) {
  if (!run) return '未运行';
  if (!run.total) {
    if (run.status === 'pass' || run.status === 'unknown') return '未解析到用例';
    return runStatusLabel(run.status);
  }
  return `${run.passed}/${run.total}`;
}

export function metric(label, value, { foot = '', cls = '', sm = false } = {}) {
  return h('div', { class: `metric ${cls}` }, [
    h('div', { class: 'label', text: label }),
    h('div', { class: `value ${sm ? 'sm' : ''}`, text: value }),
    foot ? h('div', { class: 'foot', text: foot }) : null,
  ]);
}

export function card(title, body, { actions = [], hint = '', id = null } = {}) {
  return h('section', { class: 'card', id }, [
    title ? h('div', { class: 'card-head' }, [
      h('h2', { text: title }),
      h('div', { class: 'row' }, [hint ? h('span', { class: 'hint', text: hint }) : null, ...actions]),
    ]) : null,
    h('div', { class: 'card-pad' }, body),
  ]);
}

export function table(columns, rows, { empty = '没有记录。', rowKey = null, onRowClick = null } = {}) {
  if (!rows || !rows.length) return stateEmpty(empty);
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '', style: c.width ? { width: c.width } : {}, text: c.label }))));
  const tbody = h('tbody', {}, rows.map((r, i) => h('tr', {
    dataset: rowKey ? { key: String(rowKey(r, i)) } : {},
    style: onRowClick ? { cursor: 'pointer' } : {},
    onClick: onRowClick ? () => onRowClick(r, i) : undefined,
  }, columns.map((c) => {
    const v = c.render ? c.render(r, i) : r[c.key];
    const td = h('td', { class: c.num ? 'num' : '' });
    append(td, v === null || v === undefined ? '—' : v);
    return td;
  }))));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, [thead, tbody]));
}

export function stateLoading(label = '加载中…') {
  return h('div', { class: 'stack-sm' }, [
    h('div', { class: 'small muted', text: label }),
    h('div', { class: 'skeleton', style: { width: '70%' } }),
    h('div', { class: 'skeleton', style: { width: '92%' } }),
    h('div', { class: 'skeleton', style: { width: '55%' } }),
  ]);
}

export function stateEmpty(title, detail = '') {
  return h('div', { class: 'state' }, [
    h('h3', { text: title }),
    detail ? h('div', { class: 'small', text: detail }) : null,
  ]);
}

export function stateError(err, onRetry = null) {
  return h('div', { class: 'state error' }, [
    h('h3', { text: err && err.message ? err.message : '出了点问题' }),
    err && err.hint ? h('div', { class: 'small', text: err.hint }) : null,
    err && err.code ? h('div', { class: 'evidence', text: `code: ${err.code}` }) : null,
    onRetry ? h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn btn-sm', text: '重试', onClick: onRetry })) : null,
  ]);
}

export function toast(message, kind = 'info', timeout = 5000) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = h('div', { class: `toast ${kind}`, text: message });
  region.appendChild(el);
  setTimeout(() => { try { region.removeChild(el); } catch { /* already removed */ } }, timeout);
}

export function modal(title, bodyContent, { onClose = null } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'modal' }, [
    h('div', { class: 'modal-head' }, [
      h('strong', { text: title }),
      h('button', { class: 'btn btn-sm btn-ghost', text: '关闭', onClick: close, 'aria-label': 'Close dialog' }),
    ]),
    h('div', { class: 'modal-body' }, bodyContent),
  ]);
  backdrop.appendChild(box);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  const focusable = box.querySelector('button, input, textarea, select, a[href]');
  if (focusable) focusable.focus();
  return { close, backdrop };
}

export function evidenceList(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return h('span', { class: 'evidence', text: '没有记录任何证据' });
  return h('div', { class: 'tag-list' }, list.slice(0, 12).map((e) => h('span', { class: 'chip', title: e.note || '', text: `${e.type}: ${fmt.truncate(e.ref, 56)}` })));
}

export function progressBar(progress) {
  if (!progress || progress.percent === null || progress.percent === undefined) {
    return h('div', { class: 'small muted', text: `进度未知——${progress && progress.reason ? progress.reason : '数据不足'}` });
  }
  const pct = Math.max(0, Math.min(100, progress.percent));
  return h('div', { class: 'stack-sm' }, [
    h('div', { class: 'row-between' }, [
      h('span', { class: 'small', text: `${pct}%` }),
      h('span', { class: 'small muted', text: progress.reason || '' }),
    ]),
    h('div', { class: 'progress-bar' }, h('span', { style: { width: `${pct}%` } })),
  ]);
}

export function copyButton(text, label = '复制') {  return h('button', {
    class: 'btn btn-sm',
    text: label,
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板', 'ok', 2000);
      } catch {
        // Clipboard API can be blocked; fall back to a selection prompt.
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('已复制到剪贴板', 'ok', 2000); } catch { toast('复制失败——请手动选择文本', 'error'); }
        document.body.removeChild(ta);
      }
    },
  });
}

/**
 * Load data and render, always exposing loading / empty / success / error states
 * (requirement #51). `renderer` may return a node, or null after mutating the container.
 */
export async function mountAsync(container, loader, renderer, { loadingLabel = '正在加载…', onError = null } = {}) {
  clear(container);
  container.appendChild(stateLoading(loadingLabel));
  try {
    const data = await loader();
    clear(container);
    const node = await renderer(data);
    if (node) container.appendChild(node);
    return data;
  } catch (err) {
    clear(container);
    container.appendChild(stateError(err, onError || (() => mountAsync(container, loader, renderer, { loadingLabel, onError }))));
    return null;
  }
}
