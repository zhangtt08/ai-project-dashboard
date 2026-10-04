/**
 * 添加项目 dialog — answers "这台电脑上有哪些项目" and imports what it finds.
 *
 * Two paths into the same result: scan the machine's project roots and tick the folders,
 * or type a path. Either way the import classifies the project immediately.
 */
import { api } from '../api.js';
import { h, modal, toast, fmt, stateEmpty, stateLoading, errorText } from '../ui.js';
import { refreshShellData, state } from '../app.js';
import { Router } from '../router.js';

const AUTO = 'auto';

function categorySelect(value) {
  const cats = (state.meta && state.meta.categories) || [];
  return h('select', { class: 'input', 'aria-label': '项目分类' }, [
    h('option', { value: AUTO, text: '自动识别分类', selected: !value || value === AUTO }),
    ...cats.map((c) => h('option', {
      value: c.key,
      text: `${c.label} — ${c.hint}`,
      selected: c.key === value,
    })),
  ]);
}

export function openImportDialog(onDone = null) {
  const body = h('div', { class: 'stack' });
  const tabs = h('div', { class: 'tabs' });
  const panel = h('div', { class: 'stack-sm' });
  const catSelect = categorySelect(null);
  const chosen = new Map();
  let current = 'discover';
  let dlg = null;

  const drawTabs = () => {
    tabs.replaceChildren(...[['discover', '扫描这台电脑'], ['manual', '输入路径']].map(([id, label]) => h('button', {
      class: `tab ${current === id ? 'tab-active' : ''}`,
      text: label,
      onClick: () => { current = id; drawTabs(); drawPanel(); },
    })));
  };

  const drawPanel = () => {
    panel.replaceChildren();
    if (current === 'discover') renderDiscover(panel, chosen);
    else renderManual(panel);
  };

  const resetBtn = () => {
    importBtn.disabled = false;
    importBtn.textContent = '导入所选项目';
  };

  const importBtn = h('button', {
    class: 'btn btn-primary',
    text: '导入所选项目',
    onClick: async () => {
      const paths = current === 'discover' ? [...chosen.values()] : [manualPath.value.trim()].filter(Boolean);
      if (!paths.length) { toast(current === 'discover' ? '请先勾选至少一个项目目录' : '请填写项目路径', 'warn'); return; }
      importBtn.disabled = true;
      importBtn.textContent = '正在导入并识别…';
      const category = catSelect.value !== AUTO ? catSelect.value : null;
      try {
        if (paths.length === 1 && current === 'manual') {
          const project = await api.addProject({ workspacePath: paths[0], name: manualName.value.trim() || null, category });
          finish([{ path: paths[0], project }], [], category);
        } else {
          const res = await api.importDiscovered({ paths, category });
          finish(res.imported, res.skipped, category);
        }
      } catch (err) {
        toast(`导入失败：${errorText(err)}`, 'error');
        resetBtn();
      }
    },
  });

  const hint = h('span', { class: 'muted small', text: '导入后立即扫描并自动归类；新导入的目录默认未信任，只分析文件、不执行它的构建或测试命令（项目页「执行信任」里可以打开）。配置了 GitHub 令牌还会自动建私有仓库上传。' });

  const finish = async (imported, skipped, category) => {
    await refreshShellData();
    const label = category
      ? (state.meta.categories.find((c) => c.key === category) || {}).label || category
      : '自动识别的分类';
    if (skipped.length) {
      toast(`导入 ${imported.length} 个，跳过 ${skipped.length} 个：${skipped[0].reason}`, 'warn', 9000);
    } else if (imported.length) {
      toast(`已导入 ${imported.length} 个项目（${label}）`, 'ok');
    }
    chosen.clear();
    if (dlg) dlg.close();
    if (onDone) onDone({ imported, skipped });
    else if (imported.length === 1) Router.go(`/projects/${imported[0].id || imported[0].project.id}`);
    else Router.go('/projects');
  };

  body.appendChild(tabs);
  body.appendChild(panel);
  drawTabs();
  drawPanel();

  dlg = modal('添加项目', h('div', { class: 'stack' }, [
    body,
    h('label', { class: 'field' }, [h('span', { text: '项目分类' }), catSelect]),
    h('div', { class: 'row' }, [importBtn, hint]),
  ]), { onClose: () => {} });
}

let manualPath = null;
let manualName = null;

function renderDiscover(host, chosen) {
  const status = h('div', { class: 'muted small', text: '正在扫描本机项目目录…' });
  const list = h('div', { class: 'stack-sm' });
  host.replaceChildren(
    h('div', { class: 'row-between' }, [
      h('div', { class: 'small muted', text: '在桌面、文档等位置查找带 package.json / .git / requirements.txt 等标志的目录。' }),
      h('button', { class: 'btn btn-sm', text: '重新扫描', onClick: () => run() }),
    ]),
    status,
    list,
  );

  async function run() {
    list.replaceChildren(stateLoading('扫描中…'));
    try {
      const res = await api.discovery({ limit: 300 });
      const unmanaged = res.projects.filter((p) => !p.managed);
      status.textContent = `扫描 ${fmt.num(res.scannedDirs)} 个目录，用时 ${res.elapsedMs}ms：发现 ${unmanaged.length} 个未纳管项目，共 ${res.projects.length} 个项目目录。`
        + (res.truncated ? '（结果已达上限，可能被截断）' : '');
      list.replaceChildren();
      if (!res.projects.length) {
        list.appendChild(stateEmpty('没有发现项目目录', `已扫描：${(res.configuredRoots || []).join('、')}。可在设置里添加搜索根目录。`));
        return;
      }
      for (const p of res.projects) {
        const box = h('input', { type: 'checkbox', class: 'chk', disabled: !!p.managed });
        if (chosen.has(p.path)) box.checked = true;
        box.addEventListener('change', () => {
          if (box.checked) chosen.set(p.path, p.path);
          else chosen.delete(p.path);
        });
        list.appendChild(h('label', { class: `disc-row ${p.managed ? 'is-managed' : ''}` }, [
          box,
          h('div', { class: 'disc-main' }, [
            h('strong', { text: p.name }),
            p.managed ? h('span', { class: 'chip chip-ok', text: '已在管理中' }) : null,
            h('span', { class: 'chip', text: p.ecosystems.length ? p.ecosystems.join(' / ') : '目录' }),
            h('div', { class: 'path', text: p.path }),
          ]),
          h('div', { class: 'disc-meta small muted' }, [
            p.isGitRepository ? 'Git 仓库' : '非 Git',
            p.markers.length ? p.markers.slice(0, 3).join('、') : '',
            p.lastModifiedAt ? `改动 ${fmt.rel(p.lastModifiedAt)}` : '',
          ].filter(Boolean).join(' · ')),
        ]));
      }
    } catch (err) {
      status.textContent = '';
      list.replaceChildren(h('div', { class: 'state error' }, [h('div', { text: `扫描失败：${err.message}` })]));
    }
  }
  run();
}

function renderManual(host) {
  manualPath = h('input', { class: 'input', placeholder: 'C:/Users/you/Desktop/my-project', 'aria-label': '项目路径' });
  manualName = h('input', { class: 'input', placeholder: '项目名称（留空则用文件夹名）', 'aria-label': '项目名称' });
  host.replaceChildren(
    h('div', { class: 'small muted', text: '也可以直接把文件夹拖到窗口里导入。分类请在下方选择。' }),
    h('label', { class: 'field' }, [h('span', { text: '本地路径' }), manualPath]),
    h('label', { class: 'field' }, [h('span', { text: '名称' }), manualName]),
  );
}
