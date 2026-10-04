/**
 * WorkspaceResolver — powers the drag-and-drop import module (requirement: 可识别的模块).
 *
 * Browsers cannot read the absolute path of a dropped folder (security model), so the
 * drop zone only knows the folder NAME + its top-level entries. This module resolves
 * that name back to a real local directory by searching a configurable set of roots,
 * then runs the real ProjectScanner on each candidate so the UI can show what was
 * recognised (language / framework / file count) before the user confirms.
 *
 * READ-ONLY: this module only probes the filesystem, it never writes (ADR-009).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';
import { PROJECT_MARKERS } from './discovery.js';
import { toPosix } from './util.js';

const log = logger.child('resolver');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache',
  '$Recycle.Bin', 'System Volume Information', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', 'AppData', '.vscode', '.idea',
]);

/** Default search roots, ordered by likelihood. */
export function defaultSearchRoots() {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    home,
  ];
  for (const drive of ['C:\\', 'D:\\', 'E:\\']) {
    if (fs.existsSync(drive)) roots.push(drive);
  }
  return roots;
}

function normaliseName(name) {
  return String(name || '').trim().toLowerCase().replace(/[/\\]+$/, '');
}

/**
 * Search the roots for directories whose name matches.
 * @returns {Array<{path:string, root:string, match:'exact'|'fuzzy'}>}
 */
export function findCandidates(folderName, { roots = null, maxDepth = 2, maxResults = 12, timeBudgetMs = 4000 } = {}) {
  const want = normaliseName(folderName);
  if (!want) return [];
  const searchRoots = (roots && roots.length ? roots : defaultSearchRoots())
    .map((r) => path.resolve(r))
    .filter((r) => {
      try { return fs.existsSync(r) && fs.statSync(r).isDirectory(); } catch { return false; }
    });

  const candidates = [];
  const started = Date.now();

  const walk = (dir, depth, rootLabel) => {
    if (candidates.length >= maxResults || Date.now() - started > timeBudgetMs) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (candidates.length >= maxResults || Date.now() - started > timeBudgetMs) return;
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const name = entry.name.toLowerCase();
      if (name === want) {
        candidates.push({ path: full, root: rootLabel, match: 'exact' });
      } else if (depth === 1 && (name.includes(want) || want.includes(name)) && name.length >= 4) {
        // fuzzy matches only at the top level of each root, to keep noise down
        candidates.push({ path: full, root: rootLabel, match: 'fuzzy' });
      }
      if (depth < maxDepth && name === want) continue; // do not descend into an exact match
      if (depth < maxDepth) walk(full, depth + 1, rootLabel);
    }
  };

  for (const root of searchRoots) {
    walk(root, 1, root);
    if (candidates.length >= maxResults) break;
  }

  // Exact matches first, then shallower paths.
  const rank = (c) => (c.match === 'exact' ? 0 : 1) * 10000 + c.path.split(/[\\/]/).length;
  return candidates
    .filter((c, i, arr) => arr.findIndex((x) => x.path.toLowerCase() === c.path.toLowerCase()) === i)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, maxResults);
}

/**
 * Recognise a candidate directory with the real scanner (bounded: metadata only,
 * no command execution). Returns the fields the drop-zone UI shows as badges.
 */
export async function recogniseCandidate(root, { scanner, limits = { maxFiles: 4000 } } = {}) {
  try {
    const meta = await scanner.scan(root, { limits });
    if (!meta.ok) return { path: root, recognised: false, reason: meta.reason };
    return {
      path: meta.root,
      recognised: true,
      name: meta.name,
      language: meta.primaryLanguage,
      framework: meta.framework,
      frameworks: (meta.frameworks || []).slice(0, 4),
      packageManager: meta.packageManager,
      fileCount: meta.fileCount,
      isGit: !!meta.isGitRepositoryHint,
      hasSpec: (meta.specCandidates || []).length > 0,
      truncated: !!meta.truncated,
    };
  } catch (err) {
    log.warn('recognise_failed', { root, error: err.message });
    return { path: root, recognised: false, reason: err.message };
  }
}

/**
 * Does this directory carry at least one real project marker (or a git repo)?
 *
 * A relocation must not point a record at an empty folder that merely happens to share
 * the name — so an otherwise-identical path with no marker is reported, never suggested.
 */
export function looksLikeProject(dir) {
  const markers = [];
  try {
    if (fs.existsSync(path.join(dir, '.git'))) markers.push('.git');
    for (const m of PROJECT_MARKERS) {
      if (markers.length >= 3) break;
      if (fs.existsSync(path.join(dir, m.file))) markers.push(m.file);
    }
  } catch {
    return { ok: false, markers: [], reason: '无法读取该目录' };
  }
  return { ok: markers.length > 0, markers };
}

/**
 * 失效路径的重新定位计划 — the answer to "我的项目文件夹整体挪了位置，11 条记录里 9 条打不开".
 *
 * For every registered project this probes the filesystem for where that folder actually is
 * now. Nothing is written here: the result is a proposal the UI shows and the user confirms.
 * Every verdict is a directly checkable fact — a path either exists on disk or it does not —
 * so no similarity score and no guess is ever presented as a match.
 *
 * @param {Array<{id:string,name:string,workspacePath:string}>} projects
 * @param {{roots?:string[], claimed?:Map<string,string>}} options
 * @returns {{checkedAt:string, roots:string[], items:Array<object>, summary:object}}
 */
export function planRelocations(projects, { roots = null, claimed = null } = {}) {
  const searchRoots = (roots && roots.length ? roots : defaultSearchRoots()).map((r) => path.resolve(r));
  // The recorded path's own parent is always worth searching: a folder that was moved into a
  // subdirectory one level down is found there and nowhere else in the configured roots.
  for (const p of projects) {
    const parent = path.dirname(String(p.workspacePath || ''));
    if (parent && parent !== path.dirname(parent) && !searchRoots.some((r) => r.toLowerCase() === parent.toLowerCase())) {
      searchRoots.push(parent);
    }
  }

  const taken = claimed || new Map();
  const items = [];
  for (const p of projects) {
    const recorded = String(p.workspacePath || '');
    const abs = path.resolve(recorded);
    if (fs.existsSync(abs)) {
      items.push({ projectId: p.id, projectName: p.name, workspacePath: recorded, state: 'present' });
      continue;
    }
    const folderName = path.basename(abs);
    const matches = findCandidates(folderName, { roots: searchRoots, maxDepth: 3, maxResults: 12, timeBudgetMs: 6000 })
      .filter((c) => c.match === 'exact')
      .filter((c) => path.resolve(c.path).toLowerCase() !== abs.toLowerCase());

    const candidates = [];
    for (const c of matches) {
      const full = path.resolve(c.path);
      if (taken.has(full.toLowerCase()) && taken.get(full.toLowerCase()) !== p.id) {
        candidates.push({ path: toPosix(full), usable: false, reason: `已由「${taken.get(full.toLowerCase())}」管理` });
        continue;
      }
      const probe = looksLikeProject(full);
      candidates.push({
        path: toPosix(full),
        usable: probe.ok,
        markers: probe.markers,
        reason: probe.ok ? null : '同名的空目录（没有 package.json / .git / 任何工程标记），不能作为目标',
      });
    }

    const usable = candidates.filter((c) => c.usable);
    let state = 'not_found';
    if (usable.length === 1) state = 'unique';
    else if (usable.length > 1) state = 'ambiguous';
    items.push({
      projectId: p.id,
      projectName: p.name,
      workspacePath: recorded,
      folderName,
      state,
      candidates,
      // Where the recorded path used to live vs. where the match was found — the one-line
      // reason a human uses to decide whether this is really the same folder.
      movedUnder: usable.length ? path.dirname(usable[0].path) : null,
    });
  }

  const summary = {
    checked: items.length,
    present: items.filter((i) => i.state === 'present').length,
    missing: items.filter((i) => i.state !== 'present').length,
    unique: items.filter((i) => i.state === 'unique').length,
    ambiguous: items.filter((i) => i.state === 'ambiguous').length,
    notFound: items.filter((i) => i.state === 'not_found').length,
  };
  return { checkedAt: new Date().toISOString(), roots: searchRoots.map(toPosix), items, summary };
}
