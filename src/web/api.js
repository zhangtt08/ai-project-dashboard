/** Thin API client. Every call returns `{ok, data}` or throws an Error with a safe message. */
const BASE = '';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!res.ok) {
    const err = (payload && payload.error) || {};
    const e = new Error(err.message || `request failed (${res.status})`);
    e.code = err.code || 'http_error';
    e.hint = err.hint || '';
    e.status = res.status;
    throw e;
  }
  return payload ? payload.data : null;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b || {}),
  patch: (p, b) => request('PATCH', p, b || {}),
  del: (p) => request('DELETE', p),

  health: () => request('GET', '/api/health'),
  system: () => request('GET', '/api/system'),
  meta: () => request('GET', '/api/meta'),
  dashboard: () => request('GET', '/api/dashboard'),
  attention: () => request('GET', '/api/attention'),
  security: () => request('GET', '/api/security'),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (b) => request('PATCH', '/api/settings', b),
  search: (q) => request('GET', `/api/search?q=${encodeURIComponent(q)}`),

  projects: () => request('GET', '/api/projects'),
  resolveWorkspace: (folderName) => request('POST', '/api/workspaces/resolve', { folderName }),
  discovery: (opts = {}) => request('GET', `/api/discovery?depth=${opts.depth || 3}&limit=${opts.limit || 300}${opts.roots ? `&roots=${encodeURIComponent(opts.roots.join('|'))}` : ''}`),
  importDiscovered: (b) => request('POST', '/api/discovery/import', b),
  addProject: (b) => request('POST', '/api/projects', b),
  project: (id) => request('GET', `/api/projects/${id}`),
  projectDetail: (id) => request('GET', `/api/projects/${id}/detail`),
  updateProject: (id, b) => request('PATCH', `/api/projects/${id}`, b),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}?mode=record_only`),
  deletionAssessment: (id) => request('GET', `/api/projects/${id}/deletion`),
  deleteProjectWithSource: (id, confirmToken) => request('DELETE', `/api/projects/${id}?purge=true&confirm_token=${encodeURIComponent(confirmToken)}`),
  suggestions: (id) => request('GET', `/api/projects/${id}/suggestions`),
  setCommands: (id, commands) => request('POST', `/api/projects/${id}/commands`, { commands }),
  runCommand: (id, kind) => request('POST', `/api/projects/${id}/commands/run`, { kind }),
  publishGithub: (id) => request('POST', `/api/projects/${id}/github/publish`),
  remoteRepos: (q = '') => request('GET', `/api/github/remote/repos?q=${encodeURIComponent(q)}`),
  remoteRepo: (name) => request('GET', `/api/github/remote/repo?name=${encodeURIComponent(name)}`),
  archiveProject: (id) => request('POST', `/api/projects/${id}/archive`),
  unarchiveProject: (id) => request('POST', `/api/projects/${id}/unarchive`),
  pauseWatch: (id) => request('POST', `/api/projects/${id}/pause-watch`),
  resumeWatch: (id) => request('POST', `/api/projects/${id}/resume-watch`),

  scan: (id, b) => request('POST', `/api/projects/${id}/scan`, b),
  scanSync: (id, b) => request('POST', `/api/projects/${id}/scan-sync`, b),
  jobs: (status) => request('GET', `/api/jobs?limit=200${status ? `&status=${encodeURIComponent(status)}` : ''}`),
  cancelJob: (id) => request('POST', `/api/jobs/${id}/cancel`),
  jobsStats: () => request('GET', '/api/jobs/stats'),
  jobsExport: (status) => request('GET', `/api/jobs/export?limit=2000${status ? `&status=${encodeURIComponent(status)}` : ''}`),

  /** 失效路径：提案（只读）与应用（用户已确认）。 */
  relocatePreview: () => request('GET', '/api/projects/relocate/preview'),
  relocate: (moves) => request('POST', '/api/projects/relocate', { moves }),

  tasks: (id) => request('GET', `/api/projects/${id}/tasks`),
  addTask: (id, b) => request('POST', `/api/projects/${id}/tasks`, b),
  updateTask: (id, b) => request('PATCH', `/api/tasks/${id}`, b),
  stages: (id) => request('GET', `/api/projects/${id}/stages`),
  tests: (id) => request('GET', `/api/projects/${id}/tests`),
  builds: (id) => request('GET', `/api/projects/${id}/builds`),
  git: (id) => request('GET', `/api/projects/${id}/git`),
  changes: (id) => request('GET', `/api/projects/${id}/changes`),
  risks: (id) => request('GET', `/api/projects/${id}/risks`),
  issues: (id) => request('GET', `/api/projects/${id}/issues`),
  addIssue: (id, b) => request('POST', `/api/projects/${id}/issues`, b),
  updateIssue: (id, b) => request('PATCH', `/api/issues/${id}`, b),
  updateRisk: (id, b) => request('PATCH', `/api/risks/${id}`, b),
  regressions: (id) => request('GET', `/api/projects/${id}/regressions`),
  ackRegression: (id) => request('POST', `/api/regressions/${id}/acknowledge`),
  specs: (id) => request('GET', `/api/projects/${id}/specs`),
  memory: (id) => request('GET', `/api/projects/${id}/memory`),
  versionMemory: (id, b) => request('POST', `/api/projects/${id}/memory`, b),
  decisions: (id) => request('GET', `/api/projects/${id}/decisions`),
  createDecision: (id, b) => request('POST', `/api/projects/${id}/decisions`, b),
  updateDecision: (id, b) => request('PATCH', `/api/decisions/${id}`, b),
  nextAction: (id) => request('GET', `/api/projects/${id}/next-action`),
  generateNextAction: (id, b) => request('POST', `/api/projects/${id}/next-action`, b),
  prompts: (id) => request('GET', `/api/projects/${id}/prompts`),
  generatePrompt: (id, b) => request('POST', `/api/projects/${id}/prompts`, b),
  handoff: (id) => request('GET', `/api/projects/${id}/handoff`),
  exportHandoff: (id, b) => request('POST', `/api/projects/${id}/handoff/export`, b),
  sessions: (id) => request('GET', `/api/projects/${id}/sessions`),
  importSession: (id, b) => request('POST', `/api/projects/${id}/sessions/import`, b),
  timeline: (id) => request('GET', `/api/projects/${id}/timeline`),
  aiSummary: (id) => request('POST', `/api/projects/${id}/ai/summary`),
  aiRisks: (id) => request('POST', `/api/projects/${id}/ai/risks`),
  aiTasks: (id) => request('POST', `/api/projects/${id}/ai/tasks`),
  aiDrift: (id) => request('POST', `/api/projects/${id}/ai/drift`),
  diagnostics: () => request('GET', '/api/diagnostics/commands'),
};
