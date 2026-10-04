/**
 * 关注项的主动作 —— the single map from "what Commander observed" to "the one thing to press".
 *
 * Both the dashboard and the 关注中心 read it. The same observation must never offer two
 * different next steps in two different places, and an item with no action is a item the panel
 * raised and then abandoned. The tab each action opens is a real route in `project.js`.
 */

export const ACTION_BY_KIND = {
  workspace_missing: { label: '重新定位目录', tab: 'settings', kind: 'relocate' },
  critical_health: { label: '查看健康明细', tab: 'overview' },
  build_fail: { label: '查看构建输出', tab: 'quality' },
  test_fail: { label: '查看失败测试', tab: 'quality' },
  test_error: { label: '查看测试输出', tab: 'quality' },
  regression: { label: '对比最近快照', tab: 'quality' },
  blocked_task: { label: '处理阻塞任务', tab: 'work' },
  risk: { label: '分诊风险', tab: 'quality' },
  dirty_workspace: { label: '检查工作区改动', tab: 'quality' },
  drift: { label: '核对规范漂移', tab: 'overview' },
  pending_review: { label: '查看待执行提示词', tab: 'ai' },
};

export const KIND_LABEL = {
  workspace_missing: '目录已丢失',
  critical_health: '健康危急',
  build_fail: '构建失败',
  test_fail: '测试失败',
  test_error: '测试执行异常',
  regression: '回归',
  blocked_task: '任务阻塞',
  dirty_workspace: '工作区未提交',
  risk: '风险',
  drift: '规范漂移',
  pending_review: '待执行提示词',
};

export const SEV_ZH = { critical: '危急', high: '高', medium: '中', low: '低' };

/**
 * The one action for one attention item. Falls back to opening the project rather than showing
 * a row with no way forward; `nextAction` only decides the label when nothing more specific is
 * known, and is never invented — a project with no recorded next action says 打开项目.
 */
export function actionFor(item, card) {
  const hit = ACTION_BY_KIND[item.kind];
  if (hit) return hit;
  const hasNext = !!(card && card.nextAction);
  return hasNext ? { label: '查看下一步行动', tab: 'overview' } : { label: '打开项目', tab: 'overview' };
}

export function actionHref(item, projectId) {
  const action = actionFor(item, null);
  return `#/projects/${projectId}/${action.tab}`;
}

/** Items sorted worst-first, one row per project — a project gets one decision, not nine. */
export function topItemByProject(items) {
  const map = new Map();
  for (const it of items) if (!map.has(it.projectId)) map.set(it.projectId, it);
  return map;
}
