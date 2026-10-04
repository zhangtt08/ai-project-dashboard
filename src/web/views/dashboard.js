import { api } from '../api.js';
import { h, metric, card, healthBadge, stateEmpty, mountAsync, fmt } from '../ui.js';
import { setTopbar } from '../app.js';
import { openImportDialog } from './import.js';
import { mountRelocatePanel } from './relocate.js';
import { SEV_ZH, actionFor, actionHref, topItemByProject } from './attention-actions.js';

/**
 * 首页 = 决策视图。
 *
 * 过去这一页把全部受管项目摊成一张长卡片列表，"现在该干什么"要人自己一行行找。现在收成三档：
 *   1. 失效路径 —— 同一件事造成 N 条记录打不开时，一条批量出路比 N 行重复的"目录已丢失"有用。
 *   2. 需要现在动手的项目 —— 每个只给一个主动作，动作指向那个已经核实过的原因（构建失败、
 *      N 个测试不通过……），不出现分数、置信度或百分比式的伪判定。
 *   3. 其余项目 —— 折叠成一行一个的紧凑清单，每个项目仍然一次点击可达；一条路由、一份数据都没删。
 */

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function decisionRow(cardData, item) {
  const action = actionFor(item, cardData);
  return h('div', { class: `risk-item decision-row sev-${item.severity}` }, [
    h('div', { class: 'decision-body' }, [
      h('div', { class: 'row wrap' }, [
        h('a', { class: 'decision-name', href: `#/projects/${cardData.id}`, text: cardData.name }),
        healthBadge(cardData.health),
        h('span', { class: `badge ${item.severity === 'critical' ? 'badge-critical' : 'badge-warning'}`, text: SEV_ZH[item.severity] || item.severity }),
      ]),
      h('div', { class: 'small', text: fmt.truncate(item.title, 140) }),
      item.detail ? h('div', { class: 'small muted', text: fmt.truncate(item.detail, 160) }) : null,
      item.at ? h('div', { class: 'small muted alert-time', title: `观察时间 ${fmt.date(item.at)}`, text: `观察于 ${fmt.rel(item.at)}` }) : h('div', { class: 'small muted alert-time', text: '观察时间：没有记录' }),
    ]),
    h('a', { class: 'btn btn-sm btn-primary', href: actionHref(item, cardData.id), text: action.label }),
  ]);
}

function restRow(cardData, item) {
  return h('div', { class: 'rest-row' }, [
    h('a', { class: 'rest-name', href: `#/projects/${cardData.id}`, text: cardData.name }),
    healthBadge(cardData.health),
    h('span', { class: 'small muted', text: cardData.workspaceMissing ? '目录已丢失' : `${cardData.currentStage || '阶段未知'} · 任务 ${cardData.taskSummary.done}/${cardData.taskSummary.total}` }),
    item
      ? h('span', { class: `badge ${item.severity === 'medium' ? 'badge-info' : 'badge-neutral'}`, title: item.title, text: `${SEV_ZH[item.severity] || item.severity}：${fmt.truncate(item.kind, 24)}` })
      : h('span', { class: 'badge badge-pass', text: '无待办事项' }),
  ]);
}

export async function render() {
  setTopbar('仪表盘', '先看现在要动手的项目，其余项目折叠在下方，每个仍一键可达。', [
    h('button', { class: 'btn', text: '刷新', onClick: () => render() }),
    h('button', { class: 'btn btn-primary', text: '+ 添加项目', onClick: () => openImportDialog() }),
  ]);
  const view = document.getElementById('view');

  await mountAsync(view, () => Promise.all([api.dashboard(), api.attention()]), ([data, attention]) => {
    const c = data.counts;
    const items = (attention && attention.items) || [];
    const topByProject = topItemByProject(items);

    // 只有危急 / 高 的观察才进入决策视图；中 / 低 与"没有事项"的项目收进折叠清单，不删除任何入口。
    // 目录丢失单独成区（下面那块可以逐个或批量改路径），不在决策列表里重复 N 行同样的话。
    const attentionProjectIds = new Set();
    const decisions = [];
    for (const cardData of data.cards) {
      const top = topByProject.get(cardData.id);
      if (cardData.workspaceMissing) continue;
      if (top && (top.severity === 'critical' || top.severity === 'high')) {
        decisions.push({ cardData, item: top });
        attentionProjectIds.add(cardData.id);
      }
    }
    decisions.sort((a, b) => (SEV_RANK[a.item.severity] - SEV_RANK[b.item.severity]) || a.cardData.name.localeCompare(b.cardData.name));
    const rest = data.cards.filter((cardData) => !attentionProjectIds.has(cardData.id));

    const metrics = h('div', { class: 'grid grid-4' }, [
      metric('项目数', fmt.num(c.total), { foot: `${c.archived} 个已归档` }),
      metric('健康', fmt.num(c.healthy), { cls: 'ok' }),
      metric('警告', fmt.num(c.warning), { cls: c.warning ? 'warn' : '' }),
      metric('危急', fmt.num(c.critical), { cls: c.critical ? 'alert' : '', foot: c.missing ? `${c.missing} 个目录已丢失` : '没有记录丢失的目录' }),
      metric('阻塞', fmt.num(c.blocked), { cls: c.blocked ? 'alert' : '' }),
      metric('需要动手', fmt.num(decisions.length + c.missing), { cls: (decisions.length + c.missing) ? 'alert' : 'ok', foot: `另有 ${items.length} 条关注项` }),
    ]);

    const decisionSection = decisions.length
      ? card(`现在需要动手的项目（${decisions.length}）`, h('div', { class: 'stack-sm' }, decisions.map(({ cardData, item }) => decisionRow(cardData, item))), {
        hint: '每个项目一个主动作，指向已核实的原因',
        actions: [h('a', { class: 'small', href: '#/attention', text: '全部关注项 →' })],
      })
      : card('现在需要动手的项目', stateEmpty('当前没有需要立即处理的项目', '没有危急或高危的观察：构建、测试、目录都存在且未失败。下方折叠清单里有全部项目。'), { hint: '按已核实事实判定，不用分数或百分比' });

    const restSection = rest.length
      ? h('details', { class: 'rest-details' }, [
        h('summary', {}, [
          h('span', { class: 'rest-summary-title', text: `其余 ${rest.length} 个项目 · 当前没有需要你处理的事项` }),
          h('span', { class: 'small muted', text: '展开查看每一个（点击进入详情）' }),
        ]),
        h('div', { class: 'rest-list' }, rest.map((cardData) => restRow(cardData, topByProject.get(cardData.id)))),
      ])
      : null;

    // 失效路径区自己读磁盘，异步挂进来：一次移动打断 9 条记录时，这里给出的是出路，不是第 9 遍坏消息。
    const relocateBox = h('div', { class: 'stack-sm', id: 'relocate-box' });
    mountRelocatePanel(relocateBox, () => render());

    return h('div', { class: 'stack' }, [
      metrics,
      relocateBox,
      decisionSection,
      restSection,
      h('div', { class: 'row wrap' }, [
        h('a', { class: 'small', href: '#/projects', text: `查看全部 ${data.cards.length} 个项目的完整表格 →` }),
      ]),
    ]);
  }, { loadingLabel: '正在加载仪表盘…' });
}
