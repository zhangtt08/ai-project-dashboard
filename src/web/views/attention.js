import { api } from '../api.js';
import { h, card, mountAsync, stateEmpty, fmt, toast } from '../ui.js';
import { setTopbar } from '../app.js';
import { Router } from '../router.js';
import { mountRelocatePanel } from './relocate.js';
import { KIND_LABEL, SEV_ZH, actionFor, actionHref } from './attention-actions.js';

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];

/**
 * 逐项处理，而不是一串只能"打开项目"的坏消息。
 *
 * Each row carries the one action that matches its own cause — and only when the observation
 * itself gives the button somewhere to go. 已解决 / 已忽略 write a status to the record the item
 * was derived from, so the row disappears on refresh instead of haunting the page forever.
 */
function attentionItem(item, index) {
  const action = actionFor(item, null);
  const children = [
    h('div', { class: 'row-between wrap' }, [
      h('div', { class: 'row wrap' }, [
        h('span', { class: 'chip', text: KIND_LABEL[item.kind] || item.kind }),
        h('strong', { class: 'small', text: item.title }),
      ]),
      h('div', { class: 'row' }, [
        h('a', { class: 'btn btn-sm btn-primary', href: actionHref(item, item.projectId), text: action.label }),
        h('button', {
          class: 'btn btn-sm',
          text: '打开项目',
          onClick: () => Router.go(`/projects/${item.projectId}`),
        }),
      ]),
    ]),
    item.detail ? h('div', { class: 'small muted', text: fmt.truncate(item.detail, 260) }) : null,
    // "什么时候观察到的" is a fact or it is not recorded — an item with no timestamp says so.
    item.at
      ? h('div', { class: 'small muted alert-time', title: `观察时间 ${fmt.date(item.at)}`, text: `观察于 ${fmt.rel(item.at)}（${fmt.date(item.at)}）` })
      : h('div', { class: 'small muted alert-time', text: '观察时间：没有记录' }),
  ];
  return h('div', { class: `risk-item attention-item sev-${item.severity}`, 'data-index': String(index) }, children);
}

export async function render() {
  setTopbar('关注中心', '所有应当优先处理的事项，按严重程度排序，每条一个主动作。', [
    h('button', { class: 'btn', text: '刷新', onClick: () => render() }),
  ]);
  const view = document.getElementById('view');

  await mountAsync(view, () => api.attention(), (data) => {
    const relocateBox = h('div', { class: 'stack-sm' });
    mountRelocatePanel(relocateBox, () => render());

    if (!data.items.length) {
      return h('div', { class: 'stack' }, [
        relocateBox,
        stateEmpty('暂无需关注的事项', '没有发现危急、阻塞、失败、漂移或回归的项目。'),
      ]);
    }
    const groups = SEV_ORDER
      .map((sev) => ({ sev, items: data.items.filter((i) => i.severity === sev) }))
      .filter((g) => g.items.length);

    // A row whose only cause is a dead folder is handled by the panel above; repeating it N times
    // here would be the same message twice on one page.
    const inRelocatePanel = new Set((data.items || []).filter((i) => i.kind === 'workspace_missing').map((i) => i.projectId));
    let cursor = 0;
    const sections = groups
      .map((g) => {
        const rows = g.items.filter((i) => !(i.kind === 'workspace_missing' && inRelocatePanel.has(i.projectId)));
        if (!rows.length) return null;
        return card(
          `${SEV_ZH[g.sev]}（${rows.length}）`,
          h('div', { class: 'stack-sm' }, rows.map((i) => attentionItem(i, (cursor += 1)))),
          { hint: `${rows.length} 条，按严重度排好序` },
        );
      })
      .filter(Boolean);

    return h('div', { class: 'stack' }, [relocateBox, ...sections]);
  }, { loadingLabel: '正在汇总需关注事项…' });
}

export function attentionBadgeFor(projectId, attention) {
  const items = ((attention && attention.items) || []).filter((i) => i.projectId === projectId);
  if (!items.length) return null;
  const worst = items[0].severity;
  return h('span', {
    class: `badge ${worst === 'critical' ? 'badge-critical' : worst === 'high' ? 'badge-warning' : 'badge-unknown'}`,
    text: `${items.length} 条需关注`,
  });
}

export function notifyAttention(count) {
  if (count > 0) toast(`${count} 个项目需要关注`, 'info', 3000);
}
