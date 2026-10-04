import { api } from '../api.js';
import { h, fmt, toast, modal } from '../ui.js';

/**
 * 失效路径的重新定位面板。
 *
 * This is the answer to the state a real machine actually reaches: the project tree was moved
 * once, and every record now says "目录已不存在" with the same dead remedy. Each row states a
 * fact the user can verify (the recorded path is not on disk; this other path is, and carries
 * these marker files) and offers exactly one action. Nothing is applied without a click, and
 * a batch apply confirms first because it rewrites N records at once.
 */

const STATE_LABEL = {
  unique: '找到唯一位置',
  ambiguous: '找到多个同名目录',
  not_found: '没有找到同名目录',
};

function candidateLine(c) {
  return h('div', { class: `relocate-cand ${c.usable ? '' : 'is-blocked'}` }, [
    h('code', { class: 'inline', text: c.path }),
    c.usable
      ? h('span', { class: 'chip', text: `标记：${(c.markers || []).slice(0, 3).join('、') || '目录存在'}` })
      : h('span', { class: 'small muted', text: c.reason || '不能作为目标' }),
  ]);
}

async function applyMoves(moves, onFinish) {
  const busy = h('div', { class: 'small muted', text: `正在改写 ${moves.length} 条记录的路径…` });
  try {
    const out = await api.relocate(moves);
    const failed = out.results.filter((r) => !r.ok);
    toast(
      failed.length
        ? `已重新定位 ${out.applied} 个，${failed.length} 个没有改成：${failed[0].reason}`
        : `已重新定位 ${out.applied} 个项目，正在重新分析`,
      failed.length ? 'error' : 'ok',
      8000,
    );
    if (!failed.length && onFinish) await onFinish();
    else if (onFinish) await onFinish();
  } catch (err) {
    toast(`重新定位失败：${err.message}${err.hint ? ` —— ${err.hint}` : ''}`, 'error', 8000);
  } finally {
    if (busy.parentNode) busy.remove();
  }
  return null;
}

function rowFor(item, onApplied) {
  const usable = item.candidates.filter((c) => c.usable);
  const target = usable[0] || null;
  const actions = [];
  if (target) {
    actions.push(h('button', {
      class: 'btn btn-sm btn-primary',
      text: '改到这个位置',
      onClick: () => {
        const box = h('div', { class: 'stack-sm' }, [
          h('div', { text: `${item.projectName}` }),
          h('div', { class: 'small', text: `现在记录的路径：${item.workspacePath}` }),
          h('div', { class: 'small', text: `改成：${target.path}` }),
          h('div', { class: 'small muted', text: '改路径会清空这台机器上关于旧位置的结论并重新读取新目录；磁盘上的文件不会被移动或改动。' }),
        ]);
        const dlg = modal('确认重新定位', h('div', { class: 'stack' }, [
          box,
          h('div', { class: 'row' }, [
            h('button', {
              class: 'btn btn-primary',
              text: '确认改路径',
              onClick: async () => { dlg.close(); await applyMoves([{ projectId: item.projectId, newPath: target.path }], onApplied); },
            }),
            h('button', { class: 'btn', text: '取消', onClick: () => dlg.close() }),
          ]),
        ]));
      },
    }));
  }
  actions.push(h('a', { class: 'btn btn-sm', href: `#/projects/${item.projectId}/settings`, text: '手动填写路径' }));

  return h('div', { class: 'relocate-row' }, [
    h('div', { class: 'relocate-main' }, [
      h('div', { class: 'row wrap' }, [
        h('strong', { class: 'small', text: item.projectName }),
        h('span', { class: `badge ${target ? 'badge-info' : 'badge-neutral'}`, text: STATE_LABEL[item.state] || item.state }),
      ]),
      h('div', { class: 'path', text: `记录的位置：${item.workspacePath}` }),
      ...(item.candidates || []).slice(0, 3).map(candidateLine),
      item.state === 'not_found'
        ? h('div', { class: 'small muted', text: '在配置的搜索根目录里没有任何同名目录。如果这个项目已经不需要了，删除这条记录即可；如果它在别处，手动填写路径。' })
        : null,
    ]),
    h('div', { class: 'row' }, actions),
  ]);
}

export function renderRelocatePanel(plan, onApplied) {
  const missing = plan.items.filter((i) => i.state !== 'present');
  if (!missing.length) return null;
  const unique = missing.filter((i) => i.state === 'unique');

  const batch = unique.length > 1
    ? h('button', {
      class: 'btn btn-sm btn-primary',
      text: `批量改到唯一匹配的位置（${unique.length}）`,
      onClick: () => {
        const list = h('div', { class: 'stack-sm' }, unique.map((i) => h('div', { class: 'small' }, [
          h('strong', { text: i.projectName }),
          h('span', { text: ` ${i.workspacePath} → ${i.candidates.filter((c) => c.usable)[0].path}` }),
        ])));
        modal(
          `确认批量重新定位 ${unique.length} 个项目`,
          h('div', { class: 'stack' }, [
            h('div', { class: 'small', text: '下面每一条都会清空旧位置的结论并按新位置重新读取。磁盘上的文件不会被移动或改动。' }),
            list,
            h('div', { class: 'row' }, [
              h('button', {
                class: 'btn btn-primary',
                text: '确认执行',
                onClick: async (e) => {
                  e.target.disabled = true;
                  const dlg = e.target.closest('.modal-backdrop');
                  if (dlg) dlg.remove();
                  await applyMoves(unique.map((i) => ({ projectId: i.projectId, newPath: i.candidates.filter((c) => c.usable)[0].path })), onApplied);
                },
              }),
              h('button', { class: 'btn', text: '取消', onClick: (e) => e.target.closest('.modal-backdrop').remove() }),
            ]),
          ]),
        );
      },
    })
    : null;

  return h('section', { class: 'card relocate-card' }, [
    h('div', { class: 'card-head' }, [
      h('h2', { text: `目录已丢失的项目（${missing.length}）` }),
      h('div', { class: 'row' }, [
        h('span', {
          class: 'hint',
          text: `唯一匹配 ${plan.summary.unique} · 多个候选 ${plan.summary.ambiguous} · 没找到 ${plan.summary.notFound}`,
        }),
        batch,
        h('button', {
          class: 'btn btn-sm',
          text: '重新检查磁盘',
          onClick: async (e) => {
            const btn = e.target;
            btn.disabled = true;
            try {
              const next = await api.relocatePreview();
              const host = btn.closest('.relocate-card');
              const fresh = renderRelocatePanel(next, onApplied);
              if (host && fresh) host.replaceWith(fresh);
              else if (host) host.remove();
            } catch (err) {
              toast(`检查失败：${err.message}`, 'error');
              btn.disabled = false;
            }
          },
        }),
      ]),
    ]),
    h('div', { class: 'card-pad' }, h('div', { class: 'stack-sm' }, missing.map((i) => rowFor(i, onApplied)))),
    h('div', { class: 'small muted relocate-foot', text: `磁盘核对时间 ${fmt.date(plan.checkedAt)} —— 每条结论都是当场读到的：记录的路径在不在、同名目录里有没有 package.json 或 .git。` }),
  ]);
}

/**
 * Load the plan and render the panel into `container`. Silent when nothing is broken, because a
 * panel that appears on a healthy machine is noise.
 */
export async function mountRelocatePanel(container, onApplied) {
  try {
    const plan = await api.relocatePreview();
    const panel = renderRelocatePanel(plan, onApplied);
    if (panel && container) container.appendChild(panel);
    return plan;
  } catch (err) {
    if (container) {
      container.appendChild(h('div', { class: 'small muted', text: `失效路径检查未完成：${err.message}` }));
    }
    return null;
  }
}
