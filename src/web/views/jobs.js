import { api } from '../api.js';
import { h, card, table, mountAsync, stateEmpty, fmt, toast, statusBadge } from '../ui.js';
import { setTopbar } from '../app.js';

let timer = null;
let filterStatus = null;
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function loadData() { return Promise.all([api.jobs(filterStatus), api.jobsStats()]).then(([jobs, stats]) => ({ jobs, stats })); }

// 队列页与后台任务真正联动：只要有排队/运行中的任务就每 2.5s 静默刷新，不再靠手动点。
function armTimer(data) {
  const busy = data.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  if (busy && !timer) { timer = setInterval(paintQuietly, 2500); if (timer.unref) timer.unref(); }
  else if (!busy) stopTimer();
}
async function paintQuietly() {
  // 离开本页时停止，避免定时器覆盖别的视图。
  if (!window.location.hash.startsWith('#/jobs')) { stopTimer(); return; }
  let data;
  try { data = await loadData(); } catch { stopTimer(); return; }
  const view = document.getElementById('view');
  if (view) view.replaceChildren(buildQueue(data));
  armTimer(data);
}

function runningElapsed(job) {
  if (!job.started_at) return null;
  const ms = Math.max(0, Date.now() - new Date(job.started_at).getTime());
  const cap = job.timeout_ms ? ` · 上限 ${fmt.duration(job.timeout_ms)}` : '';
  return `已运行 ${fmt.duration(ms)}${cap}`;
}

/**
 * 进度 = 第几步 / 共几步 + 这一步叫什么，都是队列里真实记录的那个值。
 * 没有记录就写"没有记录" —— 不猜一个百分比，也不画一根会自己走的进度条。
 */
function progressLine(job) {
  const p = job.progress;
  if (!p || !p.label) return null;
  const elapsed = job.started_at ? Date.now() - new Date(job.started_at).getTime() : null;
  return h('div', { class: 'small muted job-progress' }, [
    h('span', { text: `第 ${p.step}/${p.total} 步：${p.label}` }),
    elapsed !== null ? h('span', { text: ` · 已用 ${fmt.duration(elapsed)}` }) : null,
  ]);
}

function filterBar() {
  const mk = (value, label) => h('button', {
    class: `chip chip-btn ${filterStatus === value ? 'chip-on' : ''}`,
    text: label,
    onClick: () => { filterStatus = value; paintQuietly(); render('jobs'); },
  });
  return h('div', { class: 'row wrap filter-bar' }, [
    mk(null, '全部'),
    mk('running', '运行中'),
    mk('queued', '排队中'),
    mk('completed', '已完成'),
    mk('failed', '失败'),
    mk('cancelled', '已取消'),
  ]);
}

async function exportCsv() {
  try {
    const out = await api.jobsExport(filterStatus);
    const blob = new Blob([`${out.csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: out.filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${out.count} 条任务记录（${out.filename}）`, 'ok', 5000);
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error');
  }
}

function buildQueue({ jobs, stats }) {
  return h('div', { class: 'stack' }, [
    h('div', { class: 'grid grid-4' }, [
      h('div', { class: 'metric' }, [h('div', { class: 'label', text: '任务总数' }), h('div', { class: 'value', text: String(stats.total) })]),
      h('div', { class: 'metric' }, [h('div', { class: 'label', text: '运行中' }), h('div', { class: 'value', text: `${stats.running}/${stats.concurrency}` })]),
      h('div', { class: 'metric ok' }, [h('div', { class: 'label', text: '已完成' }), h('div', { class: 'value', text: String(stats.byStatus.completed || 0) })]),
      h('div', { class: 'metric alert' }, [h('div', { class: 'label', text: '失败' }), h('div', { class: 'value', text: String(stats.byStatus.failed || 0) })]),
    ]),
    filterBar(),
    card(`任务（${jobs.length}）`, jobs.length ? table([
      { label: '类型', key: 'type' },
      { label: '状态', render: (r) => h('div', { class: 'stack-sm' }, [statusBadge(r.status), r.status === 'running' && runningElapsed(r) ? h('span', { class: 'small muted', text: runningElapsed(r) }) : null, progressLine(r)]) },
      { label: '项目', render: (r) => (r.project_id ? h('a', { href: `#/projects/${r.project_id}`, text: r.project_id.slice(0, 12) }) : '—') },
      { label: '尝试', render: (r) => `${r.attempts}/${r.max_attempts}`, num: true },
      { label: '创建于', render: (r) => fmt.rel(r.created_at) },
      { label: '结束于', render: (r) => (r.finished_at ? fmt.rel(r.finished_at) : '—') },
      {
        label: '错误',
        render: (r) => (r.error
          ? h('details', {}, [h('summary', { class: 'small', text: fmt.truncate(r.error, 60) }), h('pre', { class: 'code', text: r.error })])
          : h('span', { class: 'small muted', text: '无' })),
      },
      { label: '', render: (r) => (r.status === 'queued' || r.status === 'running'
        ? h('button', { class: 'btn btn-sm', text: '取消', onClick: async (e) => {
          const btn = e.target;
          btn.disabled = true;
          try {
            const out = await api.cancelJob(r.id);
            // 已经在跑的任务会杀掉它的子进程；已结束的说"取消不了"，不假装成功。
            toast(out.cancelled ? '已取消——正在运行的命令会被终止' : `这条任务已经是「${out.status}」状态，取消不生效`, out.cancelled ? 'ok' : 'info', 5000);
          } catch (err) { toast(err.message, 'error'); }
          paintQuietly();
        } })
        : null) },
    ], jobs, { empty: '暂无任务。' }) : stateEmpty('没有符合条件的任务', filterStatus ? `当前筛选：${filterStatus}。换成"全部"看看别的记录。` : '在项目中运行一次扫描即可创建任务。')),
    h('div', { class: 'small muted', text: '有任务在排队或运行时，本页每 2.5 秒自动刷新；重试次数、超时与取消都以队列记录为准。取消会终止正在执行的命令进程。' }),
  ]);
}

export async function render(mode = 'jobs') {
  if (mode === 'events') { stopTimer(); return renderEvents(); }
  stopTimer();
  setTopbar('分析队列', '有界并发、超时、重试与取消——取消会真正终止命令；运行中自动刷新。', [
    h('button', { class: 'btn', text: '刷新', onClick: () => render('jobs') }),
    h('button', { class: 'btn', text: '导出 CSV', title: '把当前筛选下的任务记录导出为 CSV', onClick: exportCsv }),
  ]);
  const view = document.getElementById('view');
  await mountAsync(view, loadData, (data) => { armTimer(data); return buildQueue(data); }, { loadingLabel: '正在加载队列…' });
}

async function renderEvents() {
  setTopbar('全局时间线', '所有已记录的项目事件，按时间倒序。', [
    h('button', { class: 'btn', text: '刷新', onClick: () => render('events') }),
  ]);
  const view = document.getElementById('view');
  await mountAsync(view, () => api.get('/api/events?limit=150'), ({ events }) => card('事件', events.length
    ? h('div', { class: 'timeline' }, events.map((e) => h('div', { class: 'tl-item' }, [
      h('div', { class: 'tl-time', text: fmt.date(e.ts) }),
      h('div', { class: `tl-dot ${e.level}` }),
      h('div', { class: 'tl-msg' }, [
        h('div', { text: e.message }),
        h('div', { class: 'evidence', text: `${e.type}${e.project_id ? ` · ${e.project_id}` : ''}` }),
      ]),
    ]))) : stateEmpty('还没有记录任何事件')), { loadingLabel: '正在加载事件…' });
}
