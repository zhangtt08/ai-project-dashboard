import { api } from '../api.js';
import {
  h, card, table, metric, mountAsync, stateEmpty, stateLoading, healthBadge, statusBadge, gateBadge,
  progressBar, evidenceList, fmt, toast, modal, copyButton, mockBadge,
  suiteResult, healthLabel, runStatusLabel, projectStatusLabel, enumLabel, sameLocalPath, errorText,
} from '../ui.js';
import { setTopbar, refreshShellData, state } from '../app.js';
import { Router } from '../router.js';
import { openDeleteDialog } from './delete-dialog.js';

/**
 * Five tabs instead of fifteen. The panels did not change — they are grouped by what a person
 * actually comes to decide, so one tab reads as a page rather than as another unlabelled door.
 */
const TABS = ['overview', 'work', 'quality', 'ai', 'settings'];

const TAB_LABEL = {
  overview: '概况', work: '任务与阶段', quality: '质量与验证', ai: 'AI 记录', settings: '设置',
};

const PANELS = {
  overview: ['overview', 'suggestions'],
  work: ['stages', 'tasks'],
  quality: ['tests', 'build', 'git', 'changes', 'risks'],
  ai: ['prompts', 'sessions', 'memory', 'decisions'],
  settings: ['timeline', 'settings'],
};

/** Old deep links and bookmarks still resolve to the group that now holds the panel. */
const LEGACY_TAB = {
  suggestions: 'overview',
  stages: 'work', tasks: 'work',
  tests: 'quality', build: 'quality', git: 'quality', changes: 'quality', risks: 'quality',
  prompts: 'ai', sessions: 'ai', memory: 'ai', decisions: 'ai',
  timeline: 'settings',
};

const SUITE_ZH = { unit: '单元测试', integration: '集成测试', e2e: '端到端测试' };

let current = { id: null, tab: 'overview', card: null };

export async function render(projectId, tab = 'overview') {
  const requested = LEGACY_TAB[tab] || tab;
  const activeTab = TABS.includes(requested) ? requested : 'overview';
  current = { id: projectId, tab: activeTab, card: null };

  const view = document.getElementById('view');
  view.replaceChildren(stateLoading('正在加载项目…'));

  let cardData;
  try {
    cardData = await api.project(projectId);
  } catch (err) {
    view.replaceChildren(h('div', { class: 'state error' }, [
      h('h3', { text: err.message }), h('div', { class: 'evidence', text: err.code || '' }),
      h('div', { style: { marginTop: '10px' } }, h('a', { class: 'btn', href: '#/projects', text: '返回项目列表' })),
    ]));
    setTopbar('未找到项目', projectId);
    return;
  }
  current.card = cardData;

  setTopbar(cardData.name, `${cardData.workspacePath} · ${cardData.primaryLanguage} / ${cardData.framework}`, [
    // One action here. Quick scan, prompts, handoff, archive and delete all already live inside
    // the tabs where their result is read, and six buttons in a row told nobody where to start.
    h('button', {
      class: 'btn btn-primary',
      text: '重新分析',
      title: '重新读取这个目录：扫描文件、跑构建与测试、更新识别与建议',
      onClick: () => runScan('full'),
    }),
    // Deletion belongs where the project is open, not three clicks away in a settings tab.
    h('button', { class: 'btn btn-danger', text: '删除项目', onClick: () => openDeleteDialog(cardData, { onDone: () => Router.go('/projects') }) }),
  ]);

  const tabsBar = h('div', { class: 'tabs', role: 'tablist' }, TABS.map((t) => h('button', {
    class: 'tab',
    role: 'tab',
    'aria-selected': t === activeTab ? 'true' : 'false',
    text: TAB_LABEL[t],
    onClick: () => Router.go(`/projects/${projectId}/${t}`),
  })));

  const container = h('div', { class: 'stack' });
  const missingBanner = cardData.workspaceMissing
    ? h('div', { class: 'danger-note', text: `项目目录已不存在：${cardData.workspacePath} —— 本页各标签的内容来自最后一次成功分析（${fmt.date(cardData.lastAnalyzedAt)}），不代表磁盘现状。请在「设置」标签中把路径改成新位置，或直接删除这条记录。` })
    : null;
  view.replaceChildren(...[missingBanner, tabsBar, container].filter(Boolean));

  // 若该项目有排队/运行中的任务，完成后自动刷新界面（拖拽导入后的首次扫描即属此类）。
  scheduleScanRefresh(projectId);

  const panelFor = {
    overview: (box) => renderOverview(box, projectId),
    suggestions: (box) => renderSuggestions(box, projectId),
    stages: (box) => renderStages(box, projectId),
    tasks: (box) => renderTasks(box, projectId),
    tests: (box) => renderTests(box, projectId),
    build: (box) => renderBuild(box, projectId),
    git: (box) => renderGit(box, projectId),
    changes: (box) => renderChanges(box, projectId),
    risks: (box) => renderRisks(box, projectId),
    prompts: (box) => renderPrompts(box, projectId),
    sessions: (box) => renderSessions(box, projectId),
    memory: (box) => renderMemory(box, projectId),
    decisions: (box) => renderDecisions(box, projectId),
    timeline: (box) => renderTimeline(box, projectId),
    settings: (box) => renderSettings(box, cardData),
  };
  if (activeTab === 'ai') {
    container.appendChild(h('div', { class: 'row wrap' }, [
      h('button', { class: 'btn btn-sm', text: '生成提示词', onClick: () => generatePrompt(cardData) }),
      h('button', { class: 'btn btn-sm', text: '交接包', onClick: () => showHandoff(cardData) }),
      h('span', { class: 'small muted', text: '两者只读已采集的证据，不改动项目文件。' }),
    ]));
  }
  for (const name of PANELS[activeTab]) {
    const box = h('div', { class: 'stack' });
    container.appendChild(box);
    await panelFor[name](box);
  }
}

function scheduleScanRefresh(projectId) {
  // Only a scan this session actually queued is waited on. Reloading on the first
  // idle tick calls render() again, which re-arms this timer — the page then
  // re-rendered every 3s forever, discarding half-typed form input.
  if (!state.scanPending.has(projectId)) return;
  const startedAt = Date.now();
  const timer = setInterval(async () => {
    if (current.id !== projectId || Date.now() - startedAt > 600000) { clearInterval(timer); return; }
    try {
      const jobs = await api.jobs();
      const busy = jobs.some((j) => j.project_id === projectId && (j.status === 'queued' || j.status === 'running'));
      if (busy) return;
      clearInterval(timer);
      state.scanPending.delete(projectId);
      Router.reload();
    } catch { /* transient */ }
  }, 3000);
  if (timer.unref) timer.unref();
}

async function runScan(mode) {
  // 全量扫描会真的跑构建与测试命令 —— 那是会占用这台机器几分钟的动作，点错一次就该先问一句。
  if (mode === 'full' && !window.confirm('全量扫描会在这个目录里真的执行构建、Lint、类型检查与测试命令，可能需要几分钟。现在就开始吗？')) {
    return;
  }
  try {
    const out = await api.scan(current.id, { mode, runCommands: mode === 'full', suites: ['unit', 'e2e'] });
    if (out.deduped) {
      // The click did not start a second build in the same directory; say what actually happened.
      toast(`已经有${mode === 'quick' ? '快速' : '全量'}扫描在${out.status === 'running' ? '运行中' : '排队中'}——不会重复开始第二次。`, 'info', 5000);
      state.scanPending.add(current.id);
      return;
    }
    toast(`已入队${mode === 'quick' ? '快速' : '全量'}扫描——任务完成后结果自动出现。`, 'ok', 5000);
    const started = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - started > 180000) { clearInterval(poll); return; }
      try {
        const jobs = await api.jobs();
        const mine = jobs.filter((j) => j.project_id === current.id && (j.status === 'queued' || j.status === 'running'));
        if (!mine.length) {
          clearInterval(poll);
          await refreshShellData();
          Router.reload();
          toast('扫描完成。', 'ok');
        }
      } catch { clearInterval(poll); }
    }, 3000);
  } catch (err) {
    toast(`扫描失败：${errorText(err)}`, 'error');
  }
}

// ───────────────────────────── Overview ─────────────────────────────

/**
 * GitHub 私有仓库自动上传：状态、原因，以及没配令牌时可以执行的下一步。
 * A headline feature that silently does nothing reads as missing, so its state is always stated.
 */
function githubCard(d) {
  const g = d.github;
  const run = h('button', {
    class: 'btn btn-sm',
    text: g && g.stage === 'pushed' ? '重新上传' : '立即上传',
    onClick: async () => {
      run.disabled = true;
      run.textContent = '正在建私有仓库并推送…';
      try {
        const res = await api.publishGithub(d.projectId);
        const result = (res && res.result) || {};
        toast(result.ok ? `已上传到 ${result.htmlUrl || result.fullName || '私有仓库'}` : `未上传：${result.reason || result.stage || '未知原因'}`, result.ok ? 'ok' : 'warn', 9000);
      } catch (err) {
        toast(errorText(err), 'error');
      } finally {
        Router.reload();
      }
    },
  });
  const STATE = { pushed: ['badge-pass', '已上传'], disabled: ['badge-unknown', '未开启'], no_token: ['badge-warning', '缺少令牌'], failed: ['badge-critical', '上传失败'], pending: ['badge-unknown', '排队中'] };
  const [cls, label] = STATE[(g && g.stage) || ''] || ['badge-unknown', '未尝试'];
  return card('GitHub 私有仓库自动上传', h('div', { class: 'stack-sm' }, [
    h('div', { class: 'row wrap' }, [
      h('span', { class: `badge ${cls}`, text: label }),
      g && g.htmlUrl ? h('a', { class: 'small', href: g.htmlUrl, target: '_blank', rel: 'noreferrer', text: g.fullName || g.htmlUrl }) : null,
      g && g.at ? h('span', { class: 'small muted', text: `时间 ${fmt.date(g.at)}` }) : null,
    ]),
    g && g.reason
      ? h('div', { class: 'small', text: g.reason })
      : h('div', { class: 'small muted', text: '还没有为这个项目尝试过上传。上传会新建一个只属于账号的私有仓库，并把当前工作区推送上去；令牌只在设置里保存，不会写进项目目录。' }),
    h('div', { class: 'row wrap' }, [
      run,
      h('a', { class: 'small', href: '#/settings', text: '设置 → GitHub 私有仓库自动上传' }),
    ]),
  ]), { hint: g && g.stage === 'pushed' ? '仓库为非公开（private）' : '未配置令牌时不会有任何网络写入' });
}

const KIND_ZH = { build: '构建', lint: '代码检查', typecheck: '类型检查', test: '单元测试', integrationTest: '集成测试', e2e: '端到端测试' };
const SOURCE_ZH = { 'package.json': 'package.json 脚本', framework: '框架推断', config: '配置文件', manual: '手动补充' };

/** 单独运行一条命令（构建 / 测试），完成后借 scheduleScanRefresh 让本页自动刷新。 */
async function runOneCommand(projectId, kind) {
  try {
    state.scanPending.add(projectId);
    await api.runCommand(projectId, kind);
    toast('命令已入队，运行完成后本页自动刷新。', 'ok', 5000);
    scheduleScanRefresh(projectId);
  } catch (err) { toast(`运行入队失败：${errorText(err)}`, 'error'); }
}

/** 没检测到命令时的可执行出路：在界面补一条命令，保存后单独运行。 */
function openCommandEditor(projectId, kind, current) {
  const input = h('input', { class: 'input', value: current || '', placeholder: '例如 npm run build', 'aria-label': `${KIND_ZH[kind] || kind} 命令`, autofocus: 'true' });
  const dlg = modal(`补充${KIND_ZH[kind] || kind}命令`, h('div', { class: 'stack-sm' }, [
    h('div', { class: 'small muted', text: '输入一条要运行的命令（不要带管道、重定向或 ; 串联）。保存后 Commander 会在该项目的工作目录里单独运行它；命令仍会经过安全白名单，危险类或安装类命令会被拦下并说明原因。留空保存即恢复自动检测。' }),
    input,
    h('div', { class: 'row' }, [
      h('button', { class: 'btn btn-primary', text: '保存并运行', onClick: async () => {
        const value = input.value.trim();
        try {
          await api.setCommands(projectId, { [kind]: value });
          dlg.close();
          if (value) await runOneCommand(projectId, kind);
          else toast('已清除该命令的手动补充，将恢复自动检测', 'info');
        } catch (err) { toast(errorText(err), 'error'); }
      } }),
      h('button', { class: 'btn', text: '取消', onClick: () => dlg.close() }),
    ]),
  ]));
  input.focus();
}

function renderCommandsCard(d) {
  if (!d.commands.length) {
    return card('构建 / 测试命令', stateEmpty('还没有元数据', '运行一次全量扫描以检测构建与测试命令。'));
  }
  return card('构建 / 测试命令', h('div', { class: 'stack-sm' }, [
    h('div', { class: 'small muted', text: '某一类命令没有自动检测到时，直接在“操作”里补一条命令即可，无需改 package.json；补进去的命令仍会走安全白名单。' }),
    table([
      { label: '类型', render: (r) => KIND_ZH[r.kind] || r.kind },
      { label: '当前命令', render: (r) => (r.display ? h('code', { class: 'inline', text: r.display }) : h('span', { class: 'badge badge-unsupported', text: '未检测到' })) },
      { label: '来源', render: (r) => h('span', { class: `chip${r.manual ? ' chip-ok' : ''}`, text: SOURCE_ZH[r.source] || r.source || '—' }) },
      { label: '不适用原因', render: (r) => h('span', { class: 'small muted', text: fmt.truncate(r.reason || '', 90) }) },
      { label: '操作', render: (r) => h('div', { class: 'row wrap' }, [
        h('button', { class: 'btn btn-sm', text: r.manual ? '编辑命令' : r.supported ? '改用手动' : '补充命令', onClick: () => openCommandEditor(d.project.id, r.kind, r.display || '') }),
        r.supported ? h('button', { class: 'btn btn-sm', text: '单独运行', onClick: () => runOneCommand(d.project.id, r.kind) }) : null,
      ]) },
    ], d.commands),
  ]), { hint: '只读项目文件；执行前仍走安全白名单' });
}

async function renderOverview(container, id) {
  await mountAsync(container, () => api.projectDetail(id), (d) => {
    const p = d.project;
    const meta = d.metadata;
    const unavailable = [];
    for (const c of d.commands) if (!c.supported) unavailable.push(c.kind);

    return h('div', { class: 'stack' }, [
      h('div', { class: 'grid grid-4' }, [
        metric('健康', healthLabel(p.health), { cls: p.health === 'healthy' ? 'ok' : p.health === 'critical' ? 'alert' : p.health === 'warning' ? 'warn' : '', foot: d.health ? `${d.health.reasons.filter((r) => r.severity !== 'info').length} 个待处理问题 · ${d.health.reasons.filter((r) => r.severity === 'info').length} 个正面信号（详见下方健康明细）` : '' }),
        metric('阶段', p.currentStage || '未知', { sm: true, foot: projectStatusLabel(p.status) }),
        metric('构建', d.build ? runStatusLabel(d.build.status) : '未运行', { sm: true, cls: d.build && d.build.status === 'pass' ? 'ok' : d.build && d.build.status === 'fail' ? 'alert' : '', foot: d.build ? d.build.command : '' }),
        metric('单元测试', suiteResult(d.tests.unit), { cls: d.tests.unit && d.tests.unit.status === 'pass' ? 'ok' : d.tests.unit && d.tests.unit.status === 'fail' ? 'alert' : '' }),
        metric('端到端测试', suiteResult(d.tests.e2e), { cls: d.tests.e2e && d.tests.e2e.status === 'pass' ? 'ok' : d.tests.e2e && d.tests.e2e.status === 'fail' ? 'alert' : '' }),
        metric('开放任务', `${d.taskSummary.done}/${d.taskSummary.total}`, { foot: `${d.taskSummary.blocked} 个阻塞` }),
        metric('风险', `${d.riskSummary.bySeverity.critical} 危急 / ${d.riskSummary.bySeverity.high} 高`, { cls: d.riskSummary.bySeverity.critical ? 'alert' : d.riskSummary.bySeverity.high ? 'warn' : '', foot: `最重：${enumLabel(d.riskSummary.worst) || '无'}` }),
        metric('回归', String(d.regressionSummary.count), { cls: d.regressionSummary.count ? 'alert' : 'ok', foot: enumLabel(d.regressionSummary.worst) || '无' }),
      ]),

      githubCard(d),

      h('div', { class: 'grid grid-2' }, [
        card('进度', h('div', { class: 'stack-sm' }, [
          progressBar(d.progress),
          d.progress && d.progress.method ? h('div', { class: 'small muted', text: `方法 ${d.progress.method} · 依据 ${((d.progress.parts || []).filter((p) => p.value !== null)).length}/${(d.progress.parts || []).length} 类证据` }) : null,
          (d.progress && d.progress.parts ? d.progress.parts : []).map((part) => h('div', { class: 'small muted', text: `${enumLabel(part.key)}：${part.detail}` })),
        ]), { hint: '仅由阶段 + 任务 + 验收标准推导' }),

        card('验收门', d.gate ? h('div', { class: 'stack-sm' }, [
          h('div', { class: 'row' }, [gateBadge(d.gate)]),
          h('div', { class: 'small', text: d.gate.explanation }),
          ...d.gate.checks.map((c) => h('div', { class: `check-item ${c.status}` }, [
            h('div', { class: 'row-between' }, [
              h('strong', { class: 'small', text: c.name }),
              h('span', { class: `badge ${c.status === 'PASS' ? 'badge-pass' : c.status === 'FAIL' ? 'badge-fail' : c.status === 'BLOCKED' ? 'badge-critical' : 'badge-unknown'}`, text: c.status }),
            ]),
            h('div', { class: 'small muted', text: c.detail }),
            c.evidence && c.evidence.length ? evidenceList(c.evidence) : null,
          ])),
        ]) : stateEmpty('门禁未评估', '运行一次全量扫描以评估验收门。')),
      ]),

      d.nextAction ? card('下一步建议行动', h('div', { class: 'stack-sm' }, [
        h('div', { class: 'row wrap' }, [
          h('span', { class: 'badge badge-accent', text: d.nextAction.priority }),
          h('span', { class: 'badge badge-neutral', text: `规则 ${d.nextAction.deterministicRule || '无'}` }),
          (d.nextAction.evidence && d.nextAction.evidence.length) ? h('span', { class: 'badge badge-neutral', text: `${d.nextAction.evidence.length} 条证据` }) : null,
          d.nextAction.aiProvider ? mockBadge(d.nextAction.aiProvider) : null,
        ]),
        h('strong', { text: d.nextAction.objective }),
        h('div', { class: 'small', text: d.nextAction.reason }),
        d.nextAction.scope && d.nextAction.scope.length ? h('div', { class: 'stack-sm' }, [
          h('div', { class: 'small muted', text: '改动范围' }),
          h('ul', { class: 'small', style: { margin: '0', paddingLeft: '18px' } }, d.nextAction.scope.map((s) => h('li', { text: s }))),
        ]) : null,
        d.nextAction.acceptanceCriteria && d.nextAction.acceptanceCriteria.length ? h('div', { class: 'stack-sm' }, [
          h('div', { class: 'small muted', text: '验收' }),
          h('ul', { class: 'small', style: { margin: '0', paddingLeft: '18px' } }, d.nextAction.acceptanceCriteria.map((s) => h('li', { text: s }))),
        ]) : null,
        d.nextAction.verificationCommands && d.nextAction.verificationCommands.length ? h('div', { class: 'stack-sm' }, [
          h('div', { class: 'small muted', text: '验证方式' }),
          h('div', { class: 'tag-list' }, d.nextAction.verificationCommands.map((c) => h('code', { class: 'inline', text: c }))),
        ]) : null,
        h('div', { class: 'row' }, [
          h('button', { class: 'btn btn-primary btn-sm', text: '生成 Agent 提示词', onClick: () => generatePrompt(current.card) }),
          h('button', { class: 'btn btn-sm', text: '用 AI 重新计算', onClick: recomputeNextAction }),
        ]),
      ])) : card('下一步建议行动', stateEmpty('尚未计算', '先进行一次全量扫描，然后生成下一步动作。')),

      h('div', { class: 'grid grid-2' }, [
        card('健康明细（为什么？）', d.health ? h('div', { class: 'stack-sm' }, d.health.reasons.map((r) => h('div', { class: `reason-item sev-${r.severity}` }, [
          h('div', { class: 'row-between' }, [
            h('strong', { class: 'small', text: r.code }),
            h('span', { class: 'badge badge-neutral', text: enumLabel(r.severity) }),
          ]),
          h('div', { class: 'small', text: r.message }),
          r.fix ? h('div', { class: 'small muted', text: `Fix: ${r.fix}` }) : null,
          r.evidence && r.evidence.length ? evidenceList(r.evidence) : null,
        ]))) : stateEmpty('暂无健康分析', '请先运行一次全量扫描。')),
        card('规范漂移', d.drift ? h('div', { class: 'stack-sm' }, [
          h('div', { class: 'row' }, [
            h('span', { class: `badge ${d.drift.verdict === 'aligned' ? 'badge-pass' : d.drift.verdict === 'possible_drift' ? 'badge-warning' : 'badge-unknown'}`, text: enumLabel(d.drift.verdict) }),
            h('span', { class: 'small muted', text: d.drift.note || '' }),
          ]),
          ...(d.drift.drifts || []).map((x) => h('div', { class: `risk-item sev-${x.severity}` }, [
            h('strong', { class: 'small', text: x.title }),
            h('div', { class: 'small muted', text: x.description }),
            x.evidence && x.evidence.length ? evidenceList(x.evidence) : null,
          ])),
        ]) : stateEmpty('暂无漂移分析')),
      ]),

      renderCommandsCard(d),

      card('项目元数据', meta ? h('dl', { class: 'kv' }, [
        h('dt', { text: '已扫描文件' }), h('dd', { text: `${meta.fileCount} (${fmt.bytes(meta.totalBytes)})${meta.truncated ? ' —— 已达配置上限，结果被截断' : ''}` }),
        h('dt', { text: '语言' }), h('dd', { text: (meta.languages || []).slice(0, 6).map((l) => `${l.name} (${l.files})`).join(', ') || '—' }),
        h('dt', { text: '框架' }), h('dd', { text: (meta.frameworks || []).join(', ') || '—' }),
        h('dt', { text: '包管理器' }), h('dd', { text: meta.packageManager }),
        h('dt', { text: '文件角色' }), h('dd', { text: Object.entries(meta.roleCounts || {}).map(([k, v]) => `${k}:${v}`).join('  ') }),
        h('dt', { text: '配置文件' }), h('dd', { text: Object.entries(meta.configFiles || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none detected' }),
        h('dt', { text: '规范文档' }), h('dd', { text: (meta.specCandidates || []).join(', ') || 'none found' }),
        h('dt', { text: '敏感文件' }), h('dd', { text: meta.sensitiveCount ? `${meta.sensitiveCount} detected (contents never read): ${(meta.sensitiveFiles || []).map((f) => `${f.path} [${f.rule}]`).join(', ')}` : 'none' }),
        h('dt', { text: 'TODO / FIXME 标记' }), h('dd', { text: String((meta.todos || []).length) }),
        h('dt', { text: '文件指纹' }), h('dd', { text: meta.fileFingerprint }),
        h('dt', { text: '扫描耗时' }), h('dd', { text: `${meta.durationMs}ms${d.lastScanDurationMs ? `（完整流程 ${d.lastScanDurationMs}ms）` : ''}` }),
      ]) : stateEmpty('尚未扫描', '请运行一次全量扫描。')),

      d.aiSummary ? card('AI 项目摘要', h('div', { class: 'stack-sm' }, [
        h('div', { class: 'row' }, [mockBadge(d.aiSummary.provider), (d.aiSummary.evidence || []).length ? h('span', { class: 'badge badge-neutral', text: `${d.aiSummary.evidence.length} 条证据` }) : null]),
        h('div', { class: 'small', text: d.aiSummary.summary }),
        d.aiSummary.mainModules && d.aiSummary.mainModules.length ? h('div', { class: 'tag-list' }, d.aiSummary.mainModules.map((m) => h('span', { class: 'chip', text: m }))) : null,
        evidenceList(d.aiSummary.evidence || []),
      ])) : null,

      unavailable.length ? card('明确不支持', h('div', { class: 'small muted', text: `未能为以下类型检测到命令：${unavailable.join('、')}。Commander 会如实报告“不适用”，而不是猜测。` })) : null,
    ]);
  }, { loadingLabel: '正在加载概述…' });
}

async function recomputeNextAction() {
  try {
    toast('正在重新计算下一步行动…', 'info', 3000);
    await api.generateNextAction(current.id, { useAI: true });
    toast('下一步行动已更新', 'ok');
    Router.reload();
  } catch (err) { toast(err.message, 'error'); }
}

// ───────────────────────────── Stages ─────────────────────────────

async function renderStages(container, id) {
  await mountAsync(container, () => api.stages(id), ({ stages, criteria }) => h('div', { class: 'stack' }, [
    card(`阶段 (${stages.length})`, stages.length ? table([
      { label: '#', render: (r) => String(r.order_index + 1), num: true },
      { label: '名称', key: 'name' },
      { label: '状态', render: (r) => h('span', { class: `badge ${r.status === 'completed' ? 'badge-pass' : r.status === 'in_progress' ? 'badge-info' : r.status === 'blocked' ? 'badge-critical' : 'badge-unknown'}`, text: enumLabel(r.status) }) },
      // 一条阶段记录说得出它是从哪来的就够了：来源是事实，"置信度 高" 是 nobody can check 的分数。
      { label: '记录来源', render: (r) => h('span', { class: 'small', title: `confidence=${r.confidence}`, text: `${enumLabel(r.source) || r.source}${r.confidence === 'unknown' ? '（依据不足）' : ''}` }) },
      { label: '开始时间', render: (r) => fmt.date(r.started_at) },
      { label: '完成时间', render: (r) => fmt.date(r.completed_at) },
    ], stages) : stateEmpty('无法推断出阶段', '请在 SPEC.md 或 README.md 中声明阶段，例如 “## Stage 1 — Foundations”。无法判断时 Commander 报为未知，而不是编造阶段。'), { hint: '由规范/README 标题与任务分布推断' }),
    card(`验收标准 (${criteria.length})`, criteria.length ? table([
      { label: '类型', key: 'kind' },
      { label: '引用', render: (r) => r.requirement_ref || '—' },
      { label: '内容', render: (r) => h('span', { class: 'small', text: r.text }) },
      { label: '状态', render: (r) => h('span', { class: `badge ${r.status === 'satisfied' ? 'badge-pass' : r.status === 'unmet' ? 'badge-fail' : 'badge-unknown'}`, text: enumLabel(r.status) }) },
      { label: '来源', render: (r) => (r.evidence || []).map((e) => e.ref).join(', ') || '—' },
    ], criteria) : stateEmpty('尚未提取到验收标准')),
  ]), { loadingLabel: '正在加载阶段…' });
}

// ───────────────────────────── Tasks ─────────────────────────────

async function renderTasks(container, id) {
  await mountAsync(container, () => api.tasks(id), ({ tasks, summary }) => {
    const addTitle = h('input', { class: 'input', placeholder: '新任务标题', 'aria-label': '新任务标题' });
    const addPriority = h('select', { class: 'select', 'aria-label': '优先级' }, ['p0', 'p1', 'p2', 'p3'].map((p) => h('option', { value: p, selected: p === 'p2', text: p })));
    const add = async () => {
      const title = addTitle.value.trim();
      if (!title) return;
      try {
        await api.addTask(id, { title, priority: addPriority.value });
        toast('任务已添加', 'ok');
        renderTasks(container, id);
      } catch (err) { toast(err.message, 'error'); }
    };
    addTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

    return h('div', { class: 'stack' }, [
      h('div', { class: 'grid grid-4' }, [
        metric('总数', String(summary.total)),
        metric('进行中', String(summary.open), { cls: summary.open ? 'warn' : 'ok' }),
        metric('已阻塞', String(summary.blocked), { cls: summary.blocked ? 'alert' : '' }),
        metric('已完成', String(summary.done), { cls: 'ok' }),
      ]),
      card('账本来源', h('div', { class: 'tag-list' }, Object.entries(summary.bySource).map(([k, v]) => h('span', { class: 'chip', text: `${k}: ${v}` }))), { hint: '规范 · 复选框 · TODO/FIXME · Agent 日志 · 手动 · AI' }),
      card('添加任务', h('div', { class: 'row' }, [addTitle, h('div', { style: { width: '84px' } }, addPriority), h('button', { class: 'btn btn-primary', text: '添加', onClick: add })])),
      card(`任务 (${tasks.length})`, tasks.length ? table([
        { label: '状态', render: (r) => h('select', {
          class: 'select btn-sm',
          'aria-label': `状态：${r.title}`,
          style: { width: '116px' },
          onChange: async (e) => {
            try { await api.updateTask(r.id, { status: e.target.value }); toast('任务已更新', 'ok'); }
            catch (err) { toast(err.message, 'error'); }
            renderTasks(container, id);
          },
        }, ['todo', 'in_progress', 'blocked', 'done', 'cancelled'].map((s) => h('option', { value: s, selected: s === r.status, text: enumLabel(s) }))) },
        { label: '优先级', render: (r) => h('span', { class: 'badge badge-neutral', text: r.priority }) },
        { label: '标题', render: (r) => h('div', {}, [h('div', { class: 'small', text: r.title }), r.description ? h('div', { class: 'small muted', text: fmt.truncate(r.description, 140) }) : null]) },
        { label: '记录来源', render: (r) => h('span', { class: 'small', title: `confidence=${r.confidence}`, text: `${enumLabel(r.source) || r.source}${r.confidence === 'unknown' ? '（依据不足）' : ''}` }) },
        { label: '证据', render: (r) => evidenceList(r.evidence) },
        { label: '更新时间', render: (r) => fmt.rel(r.updated_at) },
      ], tasks) : stateEmpty('任务账本为空', '全量扫描后，任务会由规范、Markdown 复选框与 TODO/FIXME 标记自动生成。')),
    ]);
  }, { loadingLabel: '正在加载任务…' });
}

// ───────────────────────────── Tests ─────────────────────────────

async function renderTests(container, id) {
  await mountAsync(container, () => api.tests(id), ({ history, latest }) => h('div', { class: 'stack' }, [
    h('div', { class: 'grid grid-3' }, ['unit', 'integration', 'e2e'].map((suite) => {
      const run = latest[suite];
      return metric(`${SUITE_ZH[suite] || suite}`, run ? (run.total ? `${run.passed}/${run.total}` : runStatusLabel(run.status)) : '没有运行记录', {
        cls: run && run.status === 'pass' ? 'ok' : run && (run.status === 'fail' || run.status === 'error') ? 'alert' : '',
        sm: true,
        foot: run ? `${run.framework} · ${fmt.duration(run.duration_ms)} · ${fmt.rel(run.ts)}` : '没有记录',
      });
    })),
    ...['unit', 'integration', 'e2e'].map((suite) => {
      const run = latest[suite];
      const hist = history[suite] || [];
      return card(`${SUITE_ZH[suite] || suite} — 最近一次运行`, run ? h('div', { class: 'stack' }, [
        h('div', { class: 'row wrap' }, [
          statusBadge(run.status),
          h('code', { class: 'inline', text: run.command || '(没有命令)' }),
          h('span', { class: 'chip', text: `框架：${run.framework}` }),
          // 解析置信度讲的是"这条输出被读得多确定"，不是项目好坏的分数；保留是因为它决定
          // 上面的数字能不能信，但它的措辞必须让人知道自己在读什么。
          h('span', { class: 'chip', title: `输出由 ${run.parser || 'reporter'} 解析`, text: `输出解析：${enumLabel(run.parse_confidence) || run.parse_confidence}` }),
          h('span', { class: 'chip', text: `退出码：${run.exit_code}` }),
          h('span', { class: 'chip', text: `耗时：${fmt.duration(run.duration_ms)}` }),
        ]),
        run.raw_tail ? h('details', {}, [h('summary', { class: 'small muted', text: '原始输出（末尾片段）' }), h('pre', { class: 'code', text: run.raw_tail })]) : null,
        (run.cases || []).length ? h('div', { class: 'stack-sm' }, [
          h('div', { class: 'small muted', text: `失败用例 (${run.cases.length})` }),
          ...run.cases.map((c) => h('div', { class: 'risk-item sev-high' }, [
            h('strong', { class: 'small', text: c.name }),
            c.file ? h('div', { class: 'evidence', text: c.file }) : null,
            c.error_summary ? h('pre', { class: 'code', text: c.error_summary }) : null,
          ])),
        ]) : h('div', { class: 'small muted', text: '本次运行没有记录到失败用例。' }),
        h('div', { class: 'small muted', text: `历史：保留 ${hist.length} 次运行 —— 运行记录永不被覆盖。` }),
        hist.length > 1 ? table([
          { label: '时间', render: (r) => fmt.date(r.ts) },
          { label: '状态', render: (r) => statusBadge(r.status) },
          { label: '通过数', render: (r) => String(r.passed), num: true },
          { label: '失败数', render: (r) => String(r.failed), num: true },
          { label: '总数', render: (r) => String(r.total), num: true },
          { label: '耗时', render: (r) => fmt.duration(r.durationMs), num: true },
        ], hist) : null,
      ]) : stateEmpty(`${SUITE_ZH[suite] || suite}还没有运行过`, '请运行一次全量扫描；该项目也可能确实没有这套测试（会报为不适用，而不是失败）。'));
    }),
  ]), { loadingLabel: '正在加载测试历史…' });
}

// ───────────────────────────── Build ─────────────────────────────

async function renderBuild(container, id) {
  await mountAsync(container, () => api.builds(id), ({ builds }) => {
    const byKind = {};
    for (const b of builds) if (!byKind[b.kind]) byKind[b.kind] = b;
    return h('div', { class: 'stack' }, [
      h('div', { class: 'grid grid-3' }, Object.entries(byKind).map(([kind, b]) => metric(kind, b.status, {
        sm: true, cls: b.status === 'pass' ? 'ok' : b.status === 'fail' ? 'alert' : '', foot: `${b.command} · ${fmt.duration(b.duration_ms)}`,
      }))),
      card(`构建历史 (${builds.length})`, builds.length ? table([
        { label: '类型', key: 'kind' },
        { label: '状态', render: (r) => statusBadge(r.status) },
        { label: '命令', render: (r) => h('code', { class: 'inline', text: r.command }) },
        { label: '退出码', render: (r) => String(r.exit_code ?? '—'), num: true },
        { label: '耗时', render: (r) => fmt.duration(r.duration_ms), num: true },
        { label: '时间', render: (r) => fmt.date(r.ts) },
        { label: '输出', render: (r) => h('details', {}, [h('summary', { class: 'small muted', text: '展开' }), h('pre', { class: 'code', text: `${r.stdout_summary || ''}\n${r.stderr_summary || ''}`.trim() || '（空）' })]) },
      ], builds) : stateEmpty('没有构建结果记录', '请运行一次全量扫描。')),
    ]);
  }, { loadingLabel: '正在加载构建历史…' });
}

// ───────────────────────────── Git ─────────────────────────────

async function renderGit(container, id) {
  await mountAsync(container, () => api.git(id), ({ git, snapshots }) => {
    if (!git) return stateEmpty('没有 Git 数据', '请先运行扫描。');
    if (!git.gitAvailable) return stateEmpty('未安装 Git', 'Commander 在 PATH 中找不到 git 可执行文件。');
    if (!git.isRepository) return stateEmpty('不是 Git 仓库', git.error || '未在该工作区找到 .git 目录。');
    return h('div', { class: 'stack' }, [
      h('div', { class: 'grid grid-4' }, [
        metric('分支', git.branch, { sm: true }),
        metric('HEAD', git.commitShort || '无提交', { sm: true }),
        metric('工作区', git.workingTreeClean ? '干净' : `${git.changedFileCount + git.untracked.length} 个文件`, { sm: true, cls: git.workingTreeClean ? 'ok' : 'warn' }),
        metric('最近提交', fmt.rel(git.commitTime), { sm: true, foot: fmt.truncate(git.commitSubject, 60) }),
      ]),
      h('div', { class: 'grid grid-2' }, [
        card(`工作区（${git.changedFileCount} 个变更，${git.untracked.length} 个未跟踪）`, h('div', { class: 'stack-sm' }, gitFileGroups(git))),
        card('差异摘要', h('div', { class: 'stack-sm' }, [
          h('div', { class: 'kv' }, [
            h('dt', { text: '变更文件数' }), h('dd', { text: String(git.diffSummary.filesChanged) }),
            h('dt', { text: '新增行数' }), h('dd', { text: String(git.diffSummary.insertions) }),
            h('dt', { text: '删除行数' }), h('dd', { text: String(git.diffSummary.deletions) }),
          ]),
          h('div', { class: 'small muted', text: '仅由 git 确认——绝不通过大模型推测。' }),
        ])),
      ]),
      card(`最近提交 (${git.recentCommits.length})`, git.recentCommits.length ? table([
        { label: '提交号', render: (r) => h('code', { class: 'inline', text: r.hash }) },
        { label: '作者', key: 'author' },
        { label: '时间', render: (r) => fmt.date(r.date) },
        { label: '标题', render: (r) => h('span', { class: 'small', text: r.subject }) },
      ], git.recentCommits) : stateEmpty(git.isUnborn ? '仓库还没有提交' : 'No commits found')),
      card(`Git 快照 (${snapshots.length})`, snapshots.length ? table([
        { label: '时间', render: (r) => fmt.date(r.ts) },
        { label: '分支', key: 'branch' },
        { label: 'HEAD', render: (r) => h('code', { class: 'inline', text: (r.commit_hash || '').slice(0, 7) || '—' }) },
        { label: '工作区干净', render: (r) => (r.working_tree_clean ? h('span', { class: 'badge badge-pass', text: '干净' }) : h('span', { class: 'badge badge-warning', text: `${r.modified.length + r.untracked.length} 个未提交` })) },
        { label: '文件', render: (r) => `${r.modified.length}M ${r.added.length}A ${r.deleted.length}D ${r.untracked.length}U`, num: true },
      ], snapshots) : stateEmpty('没有存储 Git 快照')),
    ]);
  }, { loadingLabel: '正在加载 Git 状态…' });
}


function gitFileGroups(git) {
  const groups = [['已修改', git.modified], ['新增', git.added], ['已删除', git.deleted], ['未跟踪', git.untracked]];
  const out = groups
    .filter(([, list]) => (list || []).length)
    .map(([label, list]) => h('div', {}, [
      h('div', { class: 'small muted', text: `${label} (${list.length})` }),
      h('div', { class: 'tag-list' }, list.slice(0, 40).map((f) => h('span', { class: 'chip mono', text: f }))),
    ]));
  if ((git.renamed || []).length) {
    out.push(h('div', {}, [
      h('div', { class: 'small muted', text: `renamed (${git.renamed.length})` }),
      h('div', { class: 'tag-list' }, git.renamed.map((r) => h('span', { class: 'chip mono', text: `${r.from} -> ${r.to}` }))),
    ]));
  }
  if (!git.changedFileCount && !(git.untracked || []).length) out.push(h('div', { class: 'small muted', text: '工作区是干净的。' }));
  return out;
}

// ───────────────────────────── Changes ─────────────────────────────

async function renderChanges(container, id) {
  await mountAsync(container, () => api.changes(id), ({ changes, snapshots }) => h('div', { class: 'stack' }, [
    card('变更分类', h('div', { class: 'stack' }, [
      h('div', { class: 'row wrap' }, [
        h('span', { class: 'small', text: changes.summary }),
        changes.isRegressionRisk ? h('span', { class: 'badge badge-warning', text: '检测到文档以外的删除' }) : null,
      ]),
      h('div', { class: 'tag-list' }, Object.entries(changes.byKind).map(([k, v]) => h('span', { class: 'chip', text: `${k}: ${v}` }))),
      changes.files.length ? table([
        { label: '状态', key: 'status' },
        { label: '类型', render: (r) => h('span', { class: 'badge badge-neutral', text: r.kind }) },
        { label: '路径', render: (r) => h('span', { class: 'mono small', text: r.path }) },
        { label: '+/-', render: (r) => `${r.insertions ?? '?'} / ${r.deletions ?? '?'}`, num: true },
        { label: '判定依据', render: (r) => h('span', { class: 'small muted', text: r.rationale }) },
      ], changes.files) : stateEmpty('工作区没有变更'),
    ])),
    card('快照历史', snapshots.length ? table([
      { label: '#', render: (r) => String(r.seq), num: true },
      { label: '时间', render: (r) => fmt.date(r.ts) },
      { label: '健康度', render: (r) => healthBadge(r.health) },
      { label: '构建', render: (r) => statusBadge((r.build || {}).status || 'unknown') },
      { label: '单元', render: (r) => `${(r.unit || {}).passed ?? '?'}/${(r.unit || {}).total ?? '?'}` , num: true },
      { label: 'E2E', render: (r) => `${(r.e2e || {}).passed ?? '?'}/${(r.e2e || {}).total ?? '?'}`, num: true },
      { label: '门禁', render: (r) => ((r.gate || {}).result || '—') },
      { label: '文件', render: (r) => String(r.fileCount), num: true },
      { label: '阶段', render: (r) => r.stageName || '—' },
    ], snapshots) : stateEmpty('还没有快照', '请运行全量扫描以生成第一个快照。')),
  ]), { loadingLabel: '正在加载变更…' });
}

// ───────────────────────────── Prompts ─────────────────────────────

async function renderPrompts(container, id) {
  await mountAsync(container, () => api.prompts(id), ({ prompts, executions }) => h('div', { class: 'stack' }, [
    card('提示词历史', prompts.length ? table([
      { label: '时间', render: (r) => fmt.date(r.created_at) },
      { label: 'Agent', key: 'agent_key' },
      { label: '提供方', render: (r) => mockBadge(r.provider) },
      { label: '状态', render: (r) => h('span', { class: 'badge badge-neutral', text: runStatusLabel(r.status) }) },
      { label: '标题', render: (r) => h('span', { class: 'small', text: fmt.truncate(r.title, 90) }) },
      { label: '', render: (r) => h('button', { class: 'btn btn-sm', text: '查看', onClick: () => showPrompt(r) }) },
    ], prompts) : stateEmpty('还没有生成提示词', 'Use "Generate prompt" in the top bar.')),
    card('提示词 → 执行 → 证据 → 验收', executions.length ? table([
      { label: '时间', render: (r) => fmt.date(r.created_at) },
      { label: '状态', render: (r) => h('span', { class: 'badge badge-neutral', text: runStatusLabel(r.status) }) },
      { label: '提示词', render: (r) => (r.prompt_id ? h('code', { class: 'inline', text: r.prompt_id.slice(0, 16) }) : '—') },
      { label: '会话', render: (r) => (r.agent_session_id ? h('code', { class: 'inline', text: r.agent_session_id.slice(0, 16) }) : '—') },
      { label: '结果', render: (r) => h('span', { class: 'small muted', text: fmt.truncate(r.result_summary, 120) }) },
    ], executions) : stateEmpty('还没有关联的执行记录', '导入一个 Agent 会话并与提示词关联，形成闭环。')),
  ]), { loadingLabel: '正在加载提示词…' });
}

function showPrompt(p) {
  modal(p.title || '提示词', h('div', { class: 'stack' }, [
    h('div', { class: 'row wrap' }, [
      h('span', { class: 'chip', text: `agent: ${p.agent_key}` }),
      h('span', { class: 'chip', text: `provider: ${p.provider}` }),
      h('span', { class: 'chip', text: fmt.date(p.created_at) }),
      copyButton(p.content, '复制提示词'),
      h('button', {
        class: 'btn btn-sm',
        text: '导出为 .md 文件',
        onClick: () => {
          const blob = new Blob([p.content], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = h('a', { href: url, download: `${(p.title || 'agent-prompt').replace(/[\\/:*?"<>|]/g, '-')}.md` });
          document.body.appendChild(link); link.click(); document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          toast('提示词已导出为 .md 文件，可直接拖给 Coding Agent 使用', 'ok', 8000);
        },
      }),
    ]),
    h('pre', { class: 'code', style: { maxHeight: '46vh' }, text: p.content }),
    p.expected_result ? h('div', {}, [h('div', { class: 'small muted', text: '预期结果' }), h('div', { class: 'small', text: p.expected_result })]) : null,
    p.actual_result ? h('div', {}, [h('div', { class: 'small muted', text: '实际结果' }), h('div', { class: 'small', text: p.actual_result })]) : null,
  ]));
}

async function generatePrompt(cardData) {
  try {
    toast('Generating agent prompt…', 'info', 4000);
    const res = await api.generatePrompt(current.id, { agentKey: 'generic_cli' });
    const missing = (res.meta.sections && res.meta.sections.missing) || [];
    if (missing.length) toast(`Warning: provider omitted sections (${missing.join(', ')}) — deterministic fallback filled them.`, 'error', 8000);
    showPrompt(res.prompt);
    Router.reload();
  } catch (err) {
    toast(`提示词生成失败：${err.message}`, 'error');
  }
}

// ───────────────────────────── Agent sessions ─────────────────────────────

async function renderSessions(container, id) {
  await mountAsync(container, () => api.sessions(id), ({ sessions, adapters }) => {
    const textarea = h('textarea', { class: 'textarea', rows: '8', placeholder: '粘贴 Agent 会话记录（命令、退出码、修改的文件）…', 'aria-label': 'Transcript' });
    const provider = h('select', { class: 'select', 'aria-label': '提供方' }, ['manual', 'codex', 'claude_code', 'cursor', 'gemini', 'generic_cli'].map((p) => h('option', { value: p, text: p })));
    const importBtn = h('button', {
      class: 'btn btn-primary',
      text: '导入会话记录',
      onClick: async () => {
        try {
          await api.importSession(id, { transcript: textarea.value, provider: provider.value });
          toast('会话已导入并解析', 'ok');
          renderSessions(container, id);
        } catch (err) { toast(err.message, 'error'); }
      },
    });
    const mockBtn = h('button', {
      class: 'btn',
      text: '导入 MOCK 会话',
      onClick: async () => {
        try {
          await api.importSession(id, { mock: true });
          toast('已导入 Mock 会话（明确标注为 mock）', 'info');
          renderSessions(container, id);
        } catch (err) { toast(err.message, 'error'); }
      },
    });

    return h('div', { class: 'stack' }, [
      card('适配器', table([
        { label: '适配器', key: 'label' },
        { label: '实现方式', render: (r) => h('span', { class: `badge ${r.real ? 'badge-pass' : 'badge-mock'}`, text: r.real ? 'real' : 'mock' }) },
        { label: '提供方', render: (r) => h('div', { class: 'tag-list' }, r.providers.map((p) => h('span', { class: 'chip', text: p }))) },
        { label: '备注', render: (r) => h('span', { class: 'small muted', text: r.note }) },
      ], adapters), { hint: '真实的 Codex/Claude/Cursor 会话读取器属 P2（KNOWN_ISSUES MOCK-002）' }),
      card('导入会话', h('div', { class: 'stack' }, [
        h('div', { class: 'row' }, [h('div', { style: { width: '180px' } }, provider), importBtn, mockBtn]),
        textarea,
      ])),
      card(`已导入会话 (${sessions.length})`, sessions.length ? table([
        { label: '时间', render: (r) => fmt.date(r.created_at) },
        { label: '提供方', render: (r) => h('div', { class: 'row' }, [h('span', { text: r.provider }), r.is_mock ? h('span', { class: 'badge badge-mock', text: 'mock' }) : null]) },
        { label: '适配器', key: 'adapter' },
        { label: '状态', render: (r) => h('span', { class: 'badge badge-neutral', text: runStatusLabel(r.status) }) },
        { label: '涉及文件', render: (r) => String((r.changed_files || []).length), num: true },
        { label: '命令', render: (r) => String(((r.execution_result || {}).commands || []).length), num: true },
        { label: '摘要', render: (r) => h('span', { class: 'small muted', text: fmt.truncate(r.summary, 140) }) },
      ], sessions) : stateEmpty('还没有导入任何 Agent 会话')),
    ]);
  }, { loadingLabel: '正在加载 Agent 会话…' });
}

// ───────────────────────────── Risks ─────────────────────────────

async function renderRisks(container, id) {
  await mountAsync(container, async () => ({ risks: await api.risks(id), regressions: await api.regressions(id), issues: await api.issues(id) }), ({ risks, regressions, issues }) => h('div', { class: 'stack' }, [
    card(`风险 (${risks.summary.total})`, h('div', { class: 'stack-sm' }, [
      h('div', { class: 'row wrap' }, Object.entries(risks.summary.bySeverity).map(([sev, count]) => h('span', { class: `badge ${sev === 'critical' ? 'badge-critical' : sev === 'high' ? 'badge-warning' : 'badge-neutral'}`, text: `${enumLabel(sev)} ${count}` }))),
      ...risks.risks.map((r) => h('div', { class: `risk-item sev-${r.severity}` }, [
        h('div', { class: 'row-between wrap' }, [
          h('div', { class: 'row wrap' }, [
            h('span', { class: 'badge badge-neutral', text: enumLabel(r.severity) }),
            h('span', { class: 'chip mono', text: r.code }),
            h('span', { class: 'chip', text: r.source }),
            h('strong', { class: 'small', text: r.title }),
          ]),
          h('div', { class: 'row' }, [
            h('span', { class: `badge ${r.status === 'open' ? 'badge-warning' : 'badge-pass'}`, text: enumLabel(r.status) }),
            h('button', {
              class: 'btn btn-sm',
              text: r.status === 'open' ? '标记已解决' : '重新打开',
              onClick: async () => {
                try { await api.updateRisk(r.id, { status: r.status === 'open' ? 'resolved' : 'open' }); }
                catch (err) { toast(err.message, 'error'); }
                renderRisks(container, id);
              },
            }),
          ]),
        ]),
        h('div', { class: 'small', text: r.description }),
        r.suggested_action ? h('div', { class: 'small muted', text: `建议行动：${r.suggested_action}` }) : null,
        evidenceList(r.evidence),
      ])),
    ]), { hint: '确定性规则 · AI 补充的风险会明确标注' }),
    card(`缺陷 (${issues.issues.length})`, (() => {
      const title = h('input', { class: 'input', placeholder: '新缺陷标题', 'aria-label': '新缺陷标题' });
      const severity = h('select', { class: 'select', 'aria-label': '缺陷严重程度' }, ['low', 'medium', 'high', 'critical'].map((sv) => h('option', { value: sv, selected: sv === 'medium', text: sv })));
      const description = h('input', { class: 'input', placeholder: '问题描述（可选）', 'aria-label': '缺陷描述' });
      const create = async () => {
        const t = title.value.trim();
        if (!t) { toast('请填写缺陷标题', 'error'); return; }
        try {
          await api.addIssue(id, { title: t, severity: severity.value, description: description.value.trim() });
          toast('缺陷已创建', 'ok');
          renderRisks(container, id);
        } catch (err) { toast(err.message, 'error'); }
      };
      title.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
      return h('div', { class: 'stack' }, [
        h('div', { class: 'row wrap' }, [h('div', { style: { flex: '2 1 220px' } }, title), h('div', { style: { width: '110px' } }, severity), h('div', { style: { flex: '2 1 220px' } }, description), h('button', { class: 'btn btn-primary', text: '添加', onClick: create })]),
        issues.issues.length
          ? table([
            { label: '状态', render: (r) => h('select', {
              class: 'select btn-sm', 'aria-label': `状态：${r.title}`, style: { width: '104px' },
              onChange: async (e) => {
                try { await api.updateIssue(r.id, { status: e.target.value }); }
                catch (err) { toast(err.message, 'error'); }
                renderRisks(container, id);
              },
            }, ['open', 'resolved'].map((st) => h('option', { value: st, selected: st === r.status, text: enumLabel(st) }))) },
            { label: '严重程度', render: (r) => h('span', { class: `badge ${r.severity === 'critical' ? 'badge-critical' : r.severity === 'high' ? 'badge-warning' : 'badge-neutral'}`, text: enumLabel(r.severity) }) },
            { label: '标题', render: (r) => h('span', { class: 'small', text: r.title }) },
            { label: '描述', render: (r) => h('span', { class: 'small muted', text: fmt.truncate(r.description, 120) }) },
            { label: '创建时间', render: (r) => fmt.rel(r.created_at) },
          ], issues.issues)
          : h('div', { class: 'small muted', text: '没有缺陷记录。风险由系统自动计算，缺陷则由你手动登记。' }),
      ]);
    })(), { hint: '手动登记的缺陷 —— 风险是算出来的，缺陷是你填的' }),
    card(`回归 (${regressions.summary.count})`, regressions.regressions.length ? table([
      { label: '时间', render: (r) => fmt.date(r.ts) },
      { label: '类型', render: (r) => h('code', { class: 'inline', text: r.type }) },
      { label: '严重程度', render: (r) => h('span', { class: `badge ${r.severity === 'critical' ? 'badge-critical' : r.severity === 'high' ? 'badge-warning' : 'badge-neutral'}`, text: enumLabel(r.severity) }) },
      { label: '标题', render: (r) => h('span', { class: 'small', text: r.title }) },
      { label: '变更前 → 变更后', render: (r) => h('span', { class: 'mono small', text: `${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}` }) },
      { label: '', render: (r) => (r.acknowledged ? h('span', { class: 'badge badge-pass', text: 'ack' }) : h('button', { class: 'btn btn-sm', text: '确认已知悉', onClick: async () => { await api.ackRegression(r.id); renderRisks(container, id); } })) },
    ], regressions.regressions) : stateEmpty('未检测到回归', '只有两个快照在某个指标上不一致时才会报为回归。')),
  ]), { loadingLabel: '正在加载风险…' });
}

// ───────────────────────────── Memory ─────────────────────────────

async function renderMemory(container, id) {
  await mountAsync(container, () => api.memory(id), ({ latest, history, rendered }) => {
    const note = h('input', { class: 'input', placeholder: '为新的记忆版本写一句说明', 'aria-label': 'Memory note' });
    return h('div', { class: 'stack' }, [
      card('项目记忆', h('div', { class: 'stack' }, [
        latest ? h('div', { class: 'row wrap' }, [
          h('span', { class: 'chip', text: `v${latest.version}` }),
          h('span', { class: 'chip', text: `作者 ${latest.author}` }),
          h('span', { class: 'chip', text: fmt.date(latest.created_at) }),
        ]) : null,
        h('div', { class: 'row' }, [note, h('button', {
          class: 'btn btn-primary',
          text: '创建新版本',
          onClick: async () => {
            try { await api.versionMemory(id, { note: note.value }); toast('已创建新的记忆版本', 'ok'); renderMemory(container, id); } catch (err) { toast(err.message, 'error'); }
          },
        })]),
        h('div', { class: 'small muted', text: '版本只追加：新版本永远不会覆盖历史。' }),
        h('pre', { class: 'code', text: rendered || '(no memory recorded yet)' }),
      ])),
      card(`版本历史 (${history.length})`, history.length ? table([
        { label: '版本', render: (r) => String(r.version), num: true },
        { label: '时间', render: (r) => fmt.date(r.created_at) },
        { label: '作者', key: 'author' },
        { label: '备注', render: (r) => h('span', { class: 'small muted', text: r.note || '' }) },
      ], history) : stateEmpty('还没有版本')),
    ]);
  }, { loadingLabel: '正在加载项目记忆…' });
}

// ───────────────────────────── Decisions ─────────────────────────────

async function renderDecisions(container, id) {
  await mountAsync(container, () => api.decisions(id), ({ decisions }) => {
    const title = h('input', { class: 'input', placeholder: '决策标题', 'aria-label': '决策标题' });
    const context = h('textarea', { class: 'textarea', rows: '3', placeholder: '背景', 'aria-label': '背景' });
    const decision = h('textarea', { class: 'textarea', rows: '3', placeholder: '决策', 'aria-label': '决策' });
    const consequences = h('textarea', { class: 'textarea', rows: '2', placeholder: '影响', 'aria-label': '影响' });
    return h('div', { class: 'stack' }, [
      card('新建架构决策记录', h('div', { class: 'stack' }, [title, context, decision, consequences, h('button', {
        class: 'btn btn-primary',
        text: '创建架构决策记录',
        onClick: async () => {
          try {
            await api.createDecision(id, { title: title.value, context: context.value, decision: decision.value, consequences: consequences.value, status: 'accepted' });
            toast('ADR created', 'ok');
            renderDecisions(container, id);
          } catch (err) { toast(err.message, 'error'); }
        },
      })])),
      card(`决策 (${decisions.length})`, decisions.length ? table([
        { label: '状态', render: (r) => h('select', {
          class: 'select btn-sm', 'aria-label': `状态：${r.title}`, style: { width: '120px' },
          onChange: async (e) => {
            try { await api.updateDecision(r.id, { status: e.target.value }); toast('决策已更新', 'ok'); }
            catch (err) { toast(err.message, 'error'); renderDecisions(container, id); }
          },
        }, ['proposed', 'accepted', 'deprecated', 'superseded'].map((s) => h('option', { value: s, selected: s === r.status, text: enumLabel(s) }))) },
        { label: '标题', render: (r) => h('strong', { class: 'small', text: r.title }) },
        { label: '背景', render: (r) => h('span', { class: 'small muted', text: fmt.truncate(r.context, 120) }) },
        { label: '决策', render: (r) => h('span', { class: 'small muted', text: fmt.truncate(r.decision, 120) }) },
        { label: '时间', render: (r) => fmt.date(r.created_at) },
      ], decisions) : stateEmpty('没有决策记录')),
    ]);
  }, { loadingLabel: '正在加载决策…' });
}

// ───────────────────────────── Timeline ─────────────────────────────

async function renderTimeline(container, id) {
  await mountAsync(container, () => api.timeline(id), ({ events }) => card(`时间线 (${events.length})`, events.length
    ? h('div', { class: 'timeline' }, events.map((e) => h('div', { class: 'tl-item' }, [
      h('div', { class: 'tl-time', text: fmt.date(e.ts) }),
      h('div', { class: `tl-dot ${e.level}` }),
      h('div', { class: 'tl-msg' }, [
        h('div', { text: e.message }),
        h('div', { class: 'evidence', text: e.type }),
      ]),
    ]))) : stateEmpty('还没有事件')), { loadingLabel: '正在加载时间线…' });
}

// ───────────────────────────── Settings ─────────────────────────────

async function renderSettings(container, cardData) {
  const nameInput = h('input', { class: 'input', value: cardData.name, 'aria-label': '名称' });
  const pathInput = h('input', { class: 'input', value: cardData.workspacePath, 'aria-label': '工作区路径' });
  const descInput = h('textarea', { class: 'textarea', rows: '3', value: cardData.description || '', 'aria-label': '描述' });
  const ignoreInput = h('input', { class: 'input', placeholder: '以逗号分隔', 'aria-label': '忽略规则' });
  const confirmInput = h('input', { class: 'input', placeholder: '输入 DELETE', 'aria-label': '删除确认' });

  container.replaceChildren(h('div', { class: 'stack' }, [
    card('项目', h('div', { class: 'stack' }, [
      h('div', { class: 'stack-sm' }, [
        h('label', { class: 'small muted', text: '工作区路径（绝对路径）' }),
        pathInput,
        h('div', { class: cardData.workspaceMissing ? 'danger-note' : 'small muted', text: cardData.workspaceMissing
          ? '目录已不存在 —— 改成项目的新位置并保存，旧的结论会被清空后重新分析。'
          : '项目移动后在这里改路径；新目录必须已经存在。' }),
      ]),
      h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '显示名称' }), nameInput]),
      h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '描述' }), descInput]),
      h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '额外忽略规则' }), ignoreInput]),
      h('div', { class: 'row' }, [h('button', {
        class: 'btn btn-primary', text: '保存',
        onClick: async () => {
          try {
            const patch = {
              name: nameInput.value.trim(), description: descInput.value.trim(),
              ignorePatterns: ignoreInput.value.split(',').map((s) => s.trim()).filter(Boolean),
            };
            const nextPath = pathInput.value.trim();
            if (nextPath && !sameLocalPath(nextPath, cardData.workspacePath)) patch.workspacePath = nextPath;
            await api.updateProject(cardData.id, patch);
            if (patch.workspacePath) {
              toast('路径已更新，正在重新分析…', 'info', 6000);
              try { await api.scan(cardData.id, { mode: 'quick' }); } catch { /* 下一次扫描会补上 */ }
            } else {
              toast('项目已更新', 'ok');
            }
            await refreshShellData();
            Router.reload();
          } catch (err) { toast(errorText(err), 'error'); }
        },
      })]),
    ])),
    card('工作区控制', h('div', { class: 'row wrap' }, [
      h('button', { class: 'btn', text: cardData.watchPaused ? '恢复监控' : '暂停监控', onClick: async () => {
        try {
          if (cardData.watchPaused) await api.resumeWatch(cardData.id); else await api.pauseWatch(cardData.id);
          toast('更新时间', 'ok'); Router.reload();
        } catch (err) { toast(err.message, 'error'); }
      } }),
      h('button', { class: 'btn', text: '归档', onClick: async () => {
        try {
          await api.archiveProject(cardData.id);
          toast('已归档', 'ok');
          await refreshShellData();
          Router.go('/projects');
        } catch (err) { toast(err.message, 'error'); }
      } }),
      h('button', { class: 'btn', text: '打开所在路径', onClick: () => toast(cardData.workspacePath, 'info', 8000) }),
    ])),
    card('危险区域', h('div', { class: 'stack' }, [
      h('div', { class: 'small', text: '删除 Commander 记录只会移除 Commander 自己的数据库行，源码目录不会被修改或删除（ADR-009）。' }),
      h('div', { class: 'evidence', text: cardData.workspacePath }),
      confirmInput,
      h('button', {
        class: 'btn btn-danger', text: '删除 Commander 记录',
        onClick: async () => {
          if (confirmInput.value.trim() !== 'DELETE') { toast('输入 DELETE 以确认', 'error'); return; }
          try {
            const res = await api.deleteProject(cardData.id);
            toast(`Record deleted. Source untouched: ${res.sourceDirectoryUntouched}`, 'ok', 9000);
            await refreshShellData();
            Router.go('/projects');
          } catch (err) { toast(err.message, 'error'); }
        },
      }),
    ])),
  ]));
}

// ───────────────────────────── Handoff ─────────────────────────────

async function confirmDelete(cardData) {
  const confirmInput = h('input', { class: 'input', placeholder: '输入 DELETE 确认', 'aria-label': '删除确认' });
  const status = h('div', { class: 'small muted' });
  const dlg = modal(`删除项目记录 — ${cardData.name}`, h('div', { class: 'stack' }, [
    h('div', { class: 'small', text: '仅删除 Commander 自己的数据库记录（任务/风险/快照/提示词等）。源码目录不会被修改或删除：' }),
    h('div', { class: 'evidence', text: cardData.workspacePath }),
    confirmInput,
    h('div', { class: 'row' }, [
      h('button', {
        class: 'btn btn-danger', text: '永久删除记录',
        onClick: async () => {
          if (confirmInput.value.trim() !== 'DELETE') { status.textContent = '请输入 DELETE 以确认。'; return; }
          try {
            const res = await api.deleteProject(cardData.id);
            dlg.close();
            toast(`记录已删除，源码目录未动：${res.sourceDirectoryUntouched}`, 'ok', 9000);
            await refreshShellData();
            Router.go('/projects');
          } catch (err) { toast(err.message, 'error'); }
        },
      }),
      h('button', { class: 'btn', text: '取消', onClick: () => dlg.close() }),
    ]),
    status,
  ]));
}

async function showHandoff(cardData) {
  try {
    toast('Building handoff package…', 'info', 3000);
    const pkg = await api.handoff(current.id);
    modal('Agent 交接包', h('div', { class: 'stack' }, [
      h('div', { class: 'row wrap' }, [
        h('span', { class: 'chip', text: `${pkg.sections.length} sections` }),
        pkg.missingSections.length ? h('span', { class: 'badge badge-warning', text: `missing: ${pkg.missingSections.join(', ')}` }) : null,
        copyButton(pkg.markdown, 'Copy handoff'),
        h('button', {
          class: 'btn btn-sm',
          text: '导出为 .md',
          onClick: async () => {
            try {
              const res = await api.exportHandoff(current.id, {});
              toast(`Exported ${res.name} (${res.bytes} bytes)`, 'ok', 6000);
              window.open(res.url, '_blank', 'noopener');
            } catch (err) { toast(err.message, 'error'); }
          },
        }),
      ]),
      h('div', { class: 'small muted', text: '把它交给 Codex → Claude → Cursor → Gemini，新 Agent 无需原始聊天记录即可接续。' }),
      h('pre', { class: 'code', style: { maxHeight: '50vh' }, text: pkg.markdown }),
    ]));
  } catch (err) {
    toast(`交接包生成失败：${err.message}`, 'error');
  }
}

/** 项目识别 + 可优化的建议：分类依据、用途来源，以及每条带证据的建议。 */
async function renderSuggestions(container, projectId) {
  await mountAsync(container, () => api.suggestions(projectId), (data) => {
    const cls = data.classification;
    const purpose = data.purpose;
    const list = data.suggestions || [];
    const IMPACT = { critical: 'badge-critical', high: 'badge-warning', medium: 'badge-unknown', low: 'badge-unknown' };

    const purposeBox = h('div', { class: 'purpose-box stack-sm' }, [
      h('div', { class: 'row wrap' }, [
        h('strong', { text: '识别结果' }),
        h('span', { class: 'chip', text: `分类：${data.categoryLabel || (cls && cls.label) || '未分类'}` }),
        cls ? h('span', { class: 'chip', text: cls.manual ? '分类：你手动指定' : `分类由 ${((cls.reasons || []).length)} 条证据推断` }) : null,
        purpose && purpose.declared ? h('span', { class: 'chip chip-ok', text: '用途来自项目自己的文档' }) : h('span', { class: 'chip', text: '用途为结构推断' }),
      ]),
      h('div', { class: 'small', text: purpose && purpose.purpose ? `用途：${purpose.purpose}` : '用途：仓库里没有可读的用途描述。' }),
      purpose ? h('div', { class: 'small muted', text: purpose.summary }) : null,
      purpose && purpose.evidence && purpose.evidence.length
        ? h('div', { class: 'tag-list' }, purpose.evidence.map((e) => h('span', { class: 'chip', title: e.text, text: e.source })))
        : null,
      cls && cls.reasons && cls.reasons.length
        ? h('details', {}, [
          h('summary', { class: 'small', text: `分类依据（${cls.reasons.length} 条）` }),
          h('ul', { class: 'stack-sm small muted' }, cls.reasons.map((r) => h('li', { text: `${r.text}（权重 ${r.weight}）` }))),
        ])
        : null,
    ]);

    const items = list.length
      ? list.map((s) => h('div', { class: `sugg-item impact-${s.impact}` }, [
        h('div', { class: 'sugg-head' }, [
          h('strong', { text: s.title }),
          h('div', { class: 'row' }, [
            h('span', { class: `badge ${IMPACT[s.impact] || 'badge-unknown'}`, text: enumLabel(s.impact) }),
            h('span', { class: 'chip', text: `成本：${s.effort === 'low' ? '低' : s.effort === 'medium' ? '中' : '高'}` }),
            h('span', { class: 'chip', text: s.area }),
          ]),
        ]),
        h('div', { class: 'sugg-why', text: s.why }),
        h('div', { class: 'sugg-action', text: `怎么做：${s.action}` }),
        h('div', { class: 'sugg-evidence', text: `证据：${s.evidence}` }),
      ]))
      : [stateEmpty('没有可报告的优化建议', '该项目当前没有触发任何规则——这不代表完美，只代表规则未命中。')];

    if (data.workspaceMissing) {
      return h('div', { class: 'stack' }, [
        h('div', { class: 'danger-note', text: `目录已不存在：${list[0] ? list[0].evidence : ''}` }),
        h('div', { class: 'stack-sm' }, items),
        h('div', { class: 'small muted', text: '缓存的识别结论与历史建议已隐藏，因为它们无法代表磁盘现状。' }),
      ]);
    }

    return h('div', { class: 'stack' }, [
      purposeBox,
      h('div', { class: 'row-between' }, [
        h('h2', { style: { fontSize: '13px', margin: '0' }, text: `可优化的建议（${list.length}）` }),
        h('div', { class: 'row' }, [
          data.summary ? h('span', { class: 'small muted', text: `高影响 ${data.summary.counts.high + data.summary.counts.critical} · 中 ${data.summary.counts.medium} · 低 ${data.summary.counts.low}` }) : null,
          h('button', { class: 'btn btn-sm', text: '重新分析后更新', onClick: () => runScan('full') }),
        ]),
      ]),
      h('div', { class: 'stack-sm' }, items),
      data.generatedAt ? h('div', { class: 'small muted' }, `建议生成于 ${fmt.rel(data.generatedAt)}，全部来自已采集的证据。`) : null,
    ]);
  }, { loadingLabel: '正在整理优化建议…' });
}

export { TABS, TAB_LABEL };
