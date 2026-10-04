/** Application shell: navigation, topbar, route wiring. */
import { api } from './api.js';
import { h, clear, toast, fmt } from './ui.js';
import { Router } from './router.js';

export const state = {
  system: null,
  meta: null,
  dashboard: null,
  attention: null,
  sidebarCounts: { attention: 0, projects: 0 },
  /** Projects with a scan queued by this browser session — see scheduleScanRefresh(). */
  scanPending: new Set(),
};

const NAV = [
  { group: '概览' },
  { id: 'dashboard', label: '仪表盘', path: '/' },
  { id: 'projects', label: '项目', path: '/projects', countKey: 'projects' },
  { id: 'attention', label: '关注中心', path: '/attention', countKey: 'attention' },
  { id: 'github', label: 'GitHub 仓库', path: '/github' },
  { id: 'settings', label: '设置', path: '/settings' },
];

export function setTopbar(title, subtitle = '', actions = []) {
  const bar = document.getElementById('topbar');
  clear(bar);
  bar.appendChild(h('div', {}, [
    h('h1', { text: title }),
    subtitle ? h('div', { class: 'subtitle', text: subtitle }) : null,
  ]));
  const input = h('input', {
    class: 'topbar-search',
    type: 'search',
    placeholder: '搜索项目、任务或关键词…',
    'aria-label': '全局搜索',
    onKeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        Router.go(`/search?q=${encodeURIComponent(input.value.trim())}`);
      }
    },
  });
  bar.appendChild(h('div', { class: 'topbar-actions' }, [
    h('div', { class: 'searchbox' }, [input, h('kbd', { text: 'Ctrl K' })]),
    ...actions,
    windowButtons(),
  ]));
  focusSearch = () => input.focus();
}

// 桌面壳（WebView2 + IsNonClientRegionSupportEnabled）内的自绘窗口三键；
// 浏览器里 window.chrome.webview 不存在，自动不渲染。
function windowButtons() {
  const webview = typeof window !== 'undefined' && window.chrome && window.chrome.webview;
  if (!webview) return null;
  const send = (cmd) => () => webview.postMessage(cmd);
  let maximized = false;
  const maxBtn = h('button', {
    class: 'win-btn',
    'aria-label': '最大化',
    title: '最大化 / 还原',
    onclick: send('window:toggle-maximize'),
  });
  const render = () => {
    maxBtn.innerHTML = maximized
      ? '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 2.5V1h7v7H8" fill="none" stroke="currentColor"/><rect x="0.5" y="2.5" width="6.5" height="6.5" fill="none" stroke="currentColor"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor"/></svg>';
  };
  webview.addEventListener('message', (e) => {
    if (e.data === 'window:maximized:true') { maximized = true; render(); }
    if (e.data === 'window:maximized:false') { maximized = false; render(); }
  });
  render();
  return h('div', { class: 'win-controls' }, [
    h('button', { class: 'win-btn', 'aria-label': '最小化', title: '最小化', onclick: send('window:minimize') },
      (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'span'); s.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg>'; return s.firstChild; })()),
    maxBtn,
    h('button', { class: 'win-btn win-btn-close', 'aria-label': '关闭', title: '关闭', onclick: send('window:close') },
      (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'span'); s.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg>'; return s.firstChild; })()),
  ]);
}

let focusSearch = null;

export function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  const { path } = Router.hash();
  for (const item of NAV) {
    if (item.group) { nav.appendChild(h('div', { class: 'nav-group', text: item.group })); continue; }
    const active = item.path === '/' ? path === '/' : path.startsWith(item.path);
    const count = item.countKey ? state.sidebarCounts[item.countKey] : null;
    nav.appendChild(h('a', {
      class: 'nav-item',
      href: `#${item.path}`,
      'aria-current': active ? 'page' : null,
      onClick: () => setTimeout(renderNav, 0),
    }, [
      h('span', { text: item.label }),
      count ? h('span', { class: 'count', text: String(count) }) : null,
    ]));
  }
  // Operational pages that no longer deserve a sidebar row stay reachable from one quiet place.
  nav.appendChild(h('div', { class: 'nav-more' }, [
    h('div', { class: 'nav-group', text: '系统' }),
    ...[['/jobs', '分析队列'], ['/events', '全局时间线'], ['/security', '安全模型']].map(([p, l]) => h('a', {
      class: 'nav-sub', href: `#${p}`, text: l,
    })),
  ]));
}

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('commander.theme.v2', t); } catch { /* private mode */ }
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    clear(btn);
    btn.appendChild(h('span', { text: t === 'dark' ? '深色' : '浅色' }));
    btn.title = '切换深色 / 浅色主题';
    btn.setAttribute('aria-label', `当前主题：${t}，点击切换`);
  }
}

export function setSystemPill() {
  const pill = document.getElementById('system-pill');
  if (!pill) return;
  clear(pill);
  const s = state.system;
  if (!s) { pill.className = 'pill pill-idle'; pill.textContent = '正在连接…'; return; }
  const active = (s.providers || []).find((p) => p.active);
  pill.className = `pill ${active && active.configured ? 'pill-ok' : 'pill-idle'}`;
  pill.appendChild(h('span', { text: `AI: ${active ? active.name : 'none'}` }));
  pill.appendChild(h('span', { class: 'muted', text: `· v${s.version}` }));
  pill.title = `Node ${s.nodeVersion} · DB ${s.dbFile} · FTS5 ${s.ftsAvailable ? 'on' : 'off'}`;
}

export async function refreshShellData() {
  try {
    const [dashboard, attention, system] = await Promise.all([api.dashboard(), api.attention(), api.system()]);
    state.dashboard = dashboard;
    state.attention = attention;
    state.system = system;
    state.sidebarCounts = {
      attention: attention.items.filter((i) => i.severity === 'critical' || i.severity === 'high').length,
      projects: dashboard.counts.total,
    };
    setSystemPill();
    renderNav();
  } catch (err) {
    toast(`后台状态刷新失败：${err.message}`, 'error');
  }
}

function renderSidebarTools() {
  const tools = document.getElementById('sidebar-tools');
  if (!tools || tools.childElementCount) return;
  const toggle = h('button', { class: 'btn btn-sm btn-ghost', id: 'theme-toggle', onClick: () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  } });
  tools.appendChild(toggle);
  applyTheme(document.documentElement.dataset.theme || 'light');
}

async function boot() {
  const router = new Router();
  const views = await Promise.all([
    import('./views/dashboard.js'),
    import('./views/attention.js'),
    import('./views/projects.js'),
    import('./views/project.js'),
    import('./views/settings.js'),
    import('./views/github-remote.js'),
    import('./views/search.js'),
    import('./views/jobs.js'),
    import('./views/notfound.js'),
  ]);
  const [dashboard, attention, projects, project, settings, githubRemote, search, jobs, notfound] = views;

  router
    .on('/', () => dashboard.render())
    .on('/attention', () => attention.render())
    .on('/projects', () => projects.render())
    .on('/projects/:id', ({ params }) => project.render(params.id, 'overview'))
    .on('/projects/:id/:tab', ({ params }) => project.render(params.id, params.tab))
    .on('/search', ({ query }) => search.render(query))
    .on('/jobs', () => jobs.render('jobs'))
    .on('/events', () => jobs.render('events'))
    .on('/settings', () => settings.render())
    .on('/security', () => settings.renderSecurity())
    .on('/github', () => githubRemote.render())
    .on('/notfound', () => notfound.renderNotFound({ path: window.location.hash }));

  try {
    state.meta = await api.meta();
  } catch (err) {
    toast(`接口元数据读取失败：${err.message}`, 'error');
  }
  await refreshShellData();
  renderSidebarTools();
  if ((state.dashboard?.counts?.total || 0) === 0) {
    Router.go('/projects');
  }
  router.start();
  setInterval(() => { if (!document.hidden) refreshShellData(); }, 20000);
  window.addEventListener('hashchange', () => setTimeout(renderNav, 0));
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (focusSearch) focusSearch();
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      Router.go('/search');
    }
  });
  document.documentElement.dataset.booted = fmt.date(new Date().toISOString());
}

boot().catch((err) => {
  const view = document.getElementById('view');
  clear(view);
  view.appendChild(h('div', { class: 'state error' }, [
    h('h3', { text: '界面启动失败' }),
    h('div', { class: 'small', text: err.message }),
    h('div', { class: 'evidence', text: '请确认 API 服务已启动（npm run dev），然后刷新页面。' }),
  ]));
});

// 兜底拖拽：app-region 不可用时，topbar/品牌行 mousedown 触发原生移动。
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!(window.chrome && window.chrome.webview)) return;
  if (e.target.closest('button, a, input, select, kbd')) return;
  if (e.target.closest('.brand, #topbar')) window.chrome.webview.postMessage('window:drag-start');
});
