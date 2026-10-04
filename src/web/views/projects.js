import { api } from '../api.js';
import { h, card, table, mountAsync, healthBadge, statusBadge, gateBadge, toast, modal, sameLocalPath, errorText } from '../ui.js';
import { setTopbar, refreshShellData, state } from '../app.js';
import { Router } from '../router.js';
import { renderImportPanel } from './dropzone.js';
import { openImportDialog } from './import.js';
import { openDeleteDialog } from './delete-dialog.js';
import { mountRelocatePanel } from './relocate.js';

export async function render() {
  setTopbar('项目', '注册本地工作区——分析过程只读，删除需要你明确确认。', [
    h('button', { class: 'btn', text: '刷新', onClick: () => render() }),
    h('button', { class: 'btn btn-primary', text: '+ 添加项目', onClick: () => openImportDialog(() => render()) }),
  ]);
  const view = document.getElementById('view');
  await mountAsync(view, () => api.projects(), (cards) => {
    if (!cards.length) {
      return h('div', { class: 'stack' }, [
        renderImportPanel({}),
        card('添加项目后会发生什么？', h('ol', { class: 'stack-sm small' }, [
          h('li', { text: '扫描目录：结构、技术栈、规范文档、TODO 标记。' }),
          h('li', { text: '自动识别项目分类与用途，并给出可优化的建议。' }),
          h('li', { text: '敏感文件（.env、*.key、credentials…）只被识别，内容绝不会被读取。' }),
          h('li', { text: '新添加的目录默认「未信任」：只读文件、读 Git、解析文档，不会执行它的 package.json 脚本。要跑构建与测试，请在项目页的「执行信任」里明确点一次信任 —— 那是一个决定，不是一个默认值。' }),
          h('li', { text: '已信任的项目里，构建与测试命令被自动识别，并在安全白名单下执行（安装类、发布类、删除类、shell 串联一律拦下）。' }),
          h('li', { text: '生成快照、健康结论、风险清单与下一步行动。' }),
        ])),
      ]);
    }
    const sections = h('div', { class: 'stack' });
    const paint = () => sections.replaceChildren(...sectionsFor(filtered(cards)));
    const bar = filterBar(cards, paint);
    paint();
    // 失效路径集中处理区：一行一条坏消息不如一个能改路径的入口。
    const relocateBox = h('div', { class: 'stack-sm' });
    mountRelocatePanel(relocateBox, () => render());
    return h('div', { class: 'stack' }, [
      renderImportPanel({ compact: true }),
      relocateBox,
      bar,
      sections,
    ]);
  }, { loadingLabel: '正在加载项目…' });
}

function catLabel(key) {
  const cats = (state.meta && state.meta.categories) || [];
  const hit = cats.find((c) => c.key === key);
  return hit ? hit.label : key;
}

/** 项目整理：按分类筛选与分组。 */
const filter = { category: 'all', q: '' };

function filtered(cards) {
  const q = filter.q.trim().toLowerCase();
  return cards.filter((c) => {
    if (filter.category !== 'all' && (c.category || 'uncategorized') !== filter.category) return false;
    if (!q) return true;
    return [c.name, c.workspacePath, c.categoryLabel, c.description, c.primaryLanguage]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
}

function filterBar(cards, onChange) {
  const counts = new Map();
  for (const c of cards) {
    const key = c.category || 'uncategorized';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const pairs = [];
  const mkChip = (key, label) => {
    const el = h('button', {
      class: 'chip chip-btn',
      text: label,
      onClick: () => { filter.category = key; sync(); onChange(); },
    });
    pairs.push([key, el]);
    return el;
  };
  const sync = () => {
    for (const [key, el] of pairs) el.classList.toggle('chip-on', key === filter.category);
  };
  const search = h('input', {
    class: 'input input-sm', type: 'search', placeholder: '按名称、路径或技术栈筛选…',
    'aria-label': '筛选项目', value: filter.q,
    // Only the result sections repaint — replacing this input would steal focus mid-typing.
    onInput: (e) => { filter.q = e.target.value; onChange(); },
  });
  sync();
  return h('div', { class: 'stack-sm' }, [
    h('div', { class: 'row wrap' }, [
      mkChip('all', `全部 ${cards.length}`),
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => mkChip(k, `${catLabel(k)} ${n}`)),
    ]),
    search,
  ]);
}

function sectionsFor(cards) {
  if (filter.category !== 'all') return [projectTable(cards)];
  const groups = new Map();
  for (const c of cards) {
    const key = c.category || 'uncategorized';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  if (groups.size <= 1) return [projectTable(cards)];
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, rows]) => h('div', { class: 'stack-sm' }, [
      h('div', { class: 'group-head' }, [
        h('strong', { text: catLabel(key) }),
        h('span', { class: 'muted small', text: `${rows.length} 个` }),
      ]),
      projectTable(rows),
    ]));
}

function projectTable(cards) {
  // Twelve columns meant nobody could read the row they cared about. The list answers
  // "which project, what kind, is it ok, what needs me"; the rest lives on the project page.
  return table([
    {
      label: '项目',
      render: (r) => h('div', {}, [
        h('a', { href: `#/projects/${r.id}`, text: r.name }),
        r.isDemo ? h('span', { class: 'chip', style: { marginLeft: '6px' }, text: '演示' }) : null,
        h('div', { class: 'path', text: r.workspacePath }),
        h('div', { class: 'small muted', text: [
          `${r.primaryLanguage || '?'} / ${r.framework === 'unknown' ? '—' : r.framework || '?'}`,
          r.currentStage ? `阶段 ${r.currentStage}` : null,
          r.progress && r.progress.percent !== null ? `进度 ${r.progress.percent}%` : '进度未知',
        ].filter(Boolean).join(' · ') }),
      ]),
    },
    { label: '分类', render: (r) => h('span', { class: 'chip', title: r.categoryManual ? '手动指定' : '自动识别', text: r.categoryLabel || '未分类' }) },
    { label: '健康', render: (r) => (r.workspaceMissing ? h('span', { class: 'badge badge-critical', title: r.workspacePath, text: '目录已丢失' }) : healthBadge(r.health)) },
    { label: '验证', render: (r) => h('div', { class: 'row wrap' }, [
      r.build ? statusBadge(r.build.status) : null,
      r.unit ? h('span', { class: 'small mono', text: `u ${r.unit.passed}/${r.unit.total}` }) : null,
      r.gate ? gateBadge(r.gate) : null,
      !r.build && !r.unit && !r.gate ? h('span', { class: 'small muted', text: '尚未运行' }) : null,
    ]) },
    { label: '建议', render: (r) => (r.suggestionCount ? h('a', { class: 'badge badge-unknown', href: `#/projects/${r.id}/suggestions`, title: r.suggestionSummary && r.suggestionSummary.top[0] ? r.suggestionSummary.top[0] : '', text: `${r.suggestionCount} 条` }) : '—') },
    { label: '操作', render: (r) => h('div', { class: 'row' }, [
      h('button', { class: 'btn btn-sm', text: '扫描', onClick: (e) => { e.stopPropagation(); scan(r.id, e.target); } }),
      h('button', { class: 'btn btn-sm', text: '整理', onClick: (e) => { e.stopPropagation(); openProjectSettings(r); } }),
      h('button', { class: 'btn btn-sm btn-danger', text: '删除', onClick: (e) => { e.stopPropagation(); openDeleteDialog(r, { onDone: () => render() }); } }),
    ]) },
  ], cards, { empty: filter.q || filter.category !== 'all' ? '没有符合筛选条件的项目。' : '暂无项目。' });
}
async function scan(projectId, btn) {
  // 全量扫描 = 在这个目录里真的跑构建与测试，点错一次就占用这台机器几分钟。
  if (!window.confirm('全量扫描会在这个目录里真的执行构建、Lint、类型检查与测试命令，可能需要几分钟。现在就开始吗？')) return;
  if (btn) btn.disabled = true;
  try {
    const out = await api.scan(projectId, { mode: 'full', runCommands: true, suites: ['unit', 'e2e'] });
    if (out.deduped) {
      toast(`这个项目已经有扫描在${out.status === 'running' ? '运行中' : '排队中'}——不会重复开始第二次。`, 'info', 5000);
    } else {
      state.scanPending.add(projectId);
      toast('全量扫描已入队——可在「分析队列」查看进度。', 'ok', 6000);
    }
    setTimeout(() => { refreshShellData(); render(); }, 1500);
  } catch (err) {
    toast(`扫描入队失败：${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

export function openAddDialog() {
  const pathInput = h('input', { class: 'input', id: 'add-path', placeholder: 'C:\\path\\to\\your\\project', 'aria-label': 'Workspace path' });
  const nameInput = h('input', { class: 'input', id: 'add-name', placeholder: '显示名称（可选）', 'aria-label': 'Display name' });
  const descInput = h('textarea', { class: 'textarea', id: 'add-desc', rows: '3', placeholder: '这个项目是做什么的（可选）', 'aria-label': 'Description' });
  const ignoreInput = h('input', { class: 'input', id: 'add-ignore', placeholder: '额外忽略规则，以逗号分隔', 'aria-label': 'Ignore patterns' });
  const errBox = h('div', { class: 'hidden' });

  const submit = async () => {
    errBox.className = 'hidden';
    try {
      const ignorePatterns = ignoreInput.value.split(',').map((s) => s.trim()).filter(Boolean);
      const project = await api.addProject({
        workspacePath: pathInput.value.trim(),
        name: nameInput.value.trim() || undefined,
        description: descInput.value.trim(),
        ignorePatterns,
      });
      state.scanPending.add(project.id);
      toast(`已添加 ${project.name}，正在执行首次全量扫描…`, 'ok');
      dlg.close();
      await refreshShellData();
      Router.go(`/projects/${project.id}`);
      api.scan(project.id, { mode: 'full', runCommands: true, suites: ['unit', 'e2e'] })
        .then(() => toast('首次扫描已入队。', 'info'))
        .catch((e) => toast(`扫描入队失败：${e.message}`, 'error'));
    } catch (err) {
      errBox.className = 'state error';
      errBox.textContent = `${err.message}${err.hint ? ` — ${err.hint}` : ''}`;
    }
  };

  const dlg = modal('添加本地工作区', h('div', { class: 'stack' }, [
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '工作区路径（绝对路径）' }), pathInput]),
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '显示名称' }), nameInput]),
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '描述' }), descInput]),
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '额外忽略规则' }), ignoreInput]),
    h('div', { class: 'small muted', text: 'Commander 绝不写入该目录；敏感文件会被识别，但内容从不读取。' }),
    errBox,
    h('div', { class: 'row' }, [
      h('button', { class: 'btn btn-primary', text: '添加并扫描', onClick: submit }),
      h('button', { class: 'btn', text: '取消', onClick: () => dlg.close() }),
    ]),
  ]));
  pathInput.focus();
}

export async function openProjectSettings(cardData) {
  const nameInput = h('input', { class: 'input', value: cardData.name, 'aria-label': 'Display name' });
  const pathInput = h('input', { class: 'input', value: cardData.workspacePath, 'aria-label': '工作区路径' });
  const pathHint = h('div', { class: cardData.workspaceMissing ? 'danger-note' : 'small muted', text: cardData.workspaceMissing
    ? '目录已不存在 —— 项目移动后把上面的路径改成新位置，保存会清空旧结论并重新分析。'
    : '项目移动到别处时在这里改路径；新目录必须已经存在。' });
  const descInput = h('textarea', { class: 'textarea', rows: '3', value: cardData.description || '', 'aria-label': 'Description' });
  const cats = (state.meta && state.meta.categories) || [];
  const catSelect = h('select', { class: 'input', 'aria-label': '项目分类' }, [
    h('option', { value: 'auto', text: '自动识别（当前：' + (cardData.categoryLabel || '未分类') + '）', selected: !cardData.categoryManual }),
    ...cats.map((c) => h('option', {
      value: c.key, text: c.label, selected: c.key === cardData.category && !!cardData.categoryManual,
    })),
  ]);
  const dlg = modal(`项目整理 — ${cardData.name}`, h('div', { class: 'stack' }, [
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '工作区路径（绝对路径）' }), pathInput, pathHint]),
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '显示名称' }), nameInput]),
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '描述' }), descInput]),
    h('div', { class: 'stack-sm' }, [h('label', { class: 'small muted', text: '项目分类' }), catSelect]),
    h('div', { class: 'row wrap' }, [
      h('button', {
        class: 'btn btn-primary',
        text: '保存',
        onClick: async () => {
          try {
            const nextPath = pathInput.value.trim();
            const patch = {
              name: nameInput.value.trim(),
              description: descInput.value.trim(),
              category: catSelect.value,
            };
            if (nextPath && !sameLocalPath(nextPath, cardData.workspacePath)) patch.workspacePath = nextPath;
            await api.updateProject(cardData.id, patch);
            if (patch.workspacePath) {
              toast('路径已更新，旧的结论已清空——正在重新分析…', 'info', 6000);
              try { await api.scan(cardData.id, { mode: 'quick' }); } catch { /* 下次扫描会补上 */ }
            } else {
              toast('项目已更新', 'ok');
            }
            dlg.close();
            await refreshShellData();
            render();
          } catch (err) { toast(errorText(err), 'error'); }
        },
      }),
      // 暂停监控 / 归档 live in the project's own 设置 panel — one place per action.
      h('a', { class: 'small', href: `#/projects/${cardData.id}/settings`, text: '打开项目设置 →' }),
    ]),
    h('hr', { class: 'hr' }),
    h('div', { class: 'stack-sm' }, [
      h('strong', { class: 'small', text: '删除项目' }),
      h('div', { class: 'small muted', text: '从 Commander 移除记录即可，磁盘上的目录不会被改动；要连源码一起删，在删除对话框里另有入口。' }),
      h('div', { class: 'row' }, [h('button', {
        class: 'btn btn-sm btn-danger',
        text: '删除这个项目',
        onClick: () => { dlg.close(); openDeleteDialog(cardData, { onDone: () => render() }); },
      })]),
    ]),
  ]));
}

