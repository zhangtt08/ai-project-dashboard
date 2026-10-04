/**
 * ProjectScanner — requirement #13.
 *
 * Deterministic only. No AI. Produces a normalized ProjectMetadata object that every
 * downstream engine consumes.
 *
 * Language/framework detection is table-driven (`LANGUAGE_DETECTORS` / `FRAMEWORK_DETECTORS`)
 * so Python/Go/Rust support can be added without touching the walker (KNOWN_ISSUES TODO-P2-004).
 */
import path from 'node:path';
import { IgnoreEngine } from './ignore-engine.js';
import { readWorkspaceText, readDirSafe, statSafe, resetReadAudit, noteSensitiveSkip, FILE_READ_AUDIT, looksBinary } from './fs-safe.js';
import { detectSensitive } from './sensitive.js';
import { DEFAULT_SCAN_LIMITS } from '../domain/constants.js';
import { sha1, toPosix, nowIso, uniqueBy } from './util.js';

const EXT_LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby',
  '.cs': 'C#', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.vue': 'Vue',
  '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML',
  '.sql': 'SQL', '.sh': 'Shell', '.ps1': 'PowerShell', '.bat': 'Batch', '.cmd': 'Batch',
  '.json': 'JSON', '.md': 'Markdown',
};

const CODE_FILE_ROLE = (rel) => {
  const p = rel.toLowerCase();
  if (/\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p) || /(^|\/)__(tests|mocks)__\//.test(p)) return 'test';
  if (/(^|\/)(e2e|tests?\/e2e|playwright)\//.test(p)) return 'e2e';
  if (/(^|\/)(src|app|lib|packages|components)\//.test(p)) return 'source';
  if (/(^|\/)docs?\//.test(p) || /\.md$/.test(p)) return 'docs';
  return 'unknown';
};

export const LANGUAGE_DETECTORS = [
  { name: 'node', match: (ctx) => ctx.has('package.json') },
  { name: 'typescript', match: (ctx) => ctx.has('tsconfig.json') || ctx.countExt('.ts') + ctx.countExt('.tsx') > 0 },
  { name: 'python', match: (ctx) => ctx.has('pyproject.toml') || ctx.has('requirements.txt') || ctx.countExt('.py') > 0 },
  { name: 'go', match: (ctx) => ctx.has('go.mod') },
  { name: 'rust', match: (ctx) => ctx.has('Cargo.toml') },
  { name: 'php', match: (ctx) => ctx.has('composer.json') },
  { name: 'ruby', match: (ctx) => ctx.has('Gemfile') },
  { name: 'java', match: (ctx) => ctx.has('pom.xml') || ctx.has('build.gradle') },
];

export const FRAMEWORK_DETECTORS = [
  { name: 'Next.js', match: (ctx) => ctx.hasAny(/^next\.config\.(js|mjs|ts|cjs)$/) || ctx.dep('next') },
  { name: 'Vite', match: (ctx) => ctx.hasAny(/^vite\.config\.(js|mjs|ts|cjs)$/) || ctx.dep('vite') },
  { name: 'React', match: (ctx) => ctx.dep('react') || ctx.countExt('.tsx') + ctx.countExt('.jsx') > 0 },
  { name: 'Vue', match: (ctx) => ctx.dep('vue') || ctx.countExt('.vue') > 0 },
  { name: 'Svelte', match: (ctx) => ctx.dep('svelte') || ctx.countExt('.svelte') > 0 },
  { name: 'Express', match: (ctx) => ctx.dep('express') },
  { name: 'Fastify', match: (ctx) => ctx.dep('fastify') },
  { name: 'NestJS', match: (ctx) => ctx.dep('@nestjs/core') },
  { name: 'Electron', match: (ctx) => ctx.dep('electron') },
  { name: 'Expo/RN', match: (ctx) => ctx.dep('react-native') || ctx.dep('expo') },
  { name: 'FastAPI', match: (ctx) => ctx.pythonDep('fastapi') },
  { name: 'Django', match: (ctx) => ctx.pythonDep('django') },
  { name: 'Playwright', match: (ctx) => ctx.hasAny(/^playwright\.config\.(ts|js|mjs)$/) || ctx.dep('@playwright/test') },
  { name: 'Vitest', match: (ctx) => ctx.hasAny(/^vitest\.config\.(ts|js|mts)$/) || ctx.dep('vitest') },
  { name: 'Jest', match: (ctx) => ctx.hasAny(/^jest\.config\.(js|ts|cjs|mjs|json)$/) || ctx.dep('jest') },
];

export function detectPackageManager(relFiles, packageJson) {
  const names = new Set(relFiles.map((f) => f.split('/').pop()));
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun';
  if (names.has('package-lock.json')) return 'npm';
  if (names.has('poetry.lock')) return 'poetry';
  if (names.has('Pipfile.lock')) return 'pipenv';
  if (names.has('requirements.txt') || names.has('pyproject.toml')) return 'pip';
  if (names.has('go.mod')) return 'go';
  if (names.has('Cargo.toml')) return 'cargo';
  if (packageJson) return 'npm';
  return 'unknown';
}

function normaliseSpecKind(rel) {
  const base = rel.split('/').pop().toLowerCase();
  if (base === 'spec.md' || base === 'specification.md') return 'spec';
  if (base === 'prd.md') return 'prd';
  if (base === 'requirements.md' || base === 'req.md') return 'requirements';
  if (base === 'readme.md') return 'readme';
  if (base === 'todo.md' || base === 'tasks.md' || base === 'roadmap.md') return 'todo';
  if (rel.toLowerCase().includes('docs/')) return 'doc';
  return 'other';
}

const SPEC_CANDIDATE_RE = /^(spec|specification|prd|requirements|req|readme|todo|tasks|roadmap|plan|design|architecture)\.md$/i;

export class ProjectScanner {
  constructor({ limits = {} } = {}) { this.limits = { ...DEFAULT_SCAN_LIMITS, ...limits }; }

  /**
   * @param {string} root absolute workspace path
   */
  async scan(root, { userPatterns = [], limits = {}, name = null, signal = null } = {}) {
    const started = Date.now();
    const lim = { ...this.limits, ...limits };
    resetReadAudit();
    const warnings = [];

    const rootStat = await statSafe(root);
    if (!rootStat) {
      return { ok: false, reason: 'workspace_not_found', root: toPosix(root), scannedAt: nowIso(), warnings };
    }
    if (!rootStat.isDirectory()) {
      return { ok: false, reason: 'not_a_directory', root: toPosix(root), scannedAt: nowIso(), warnings };
    }

    const ignore = await IgnoreEngine.fromProject({ root, userPatterns, limits: lim });
    const files = [];
    const dirs = [];
    const sensitiveFiles = [];
    const largestFiles = [];
    let truncated = false;
    // A cancelled scan must stop walking, not keep reading the disk behind a job that already
    // says 已取消. `aborted` is reported back so the orchestrator can refuse to persist a
    // half-read tree as if it were a complete observation.
    let aborted = false;

    const walk = async (dirAbs, dirRel, depth) => {
      if (signal && signal.aborted) { aborted = true; return; }
      if (truncated || aborted) return;
      if (depth > lim.maxDepth) { truncated = true; warnings.push(`maxDepth ${lim.maxDepth} reached`); return; }
      const entries = await readDirSafe(dirAbs);
      for (const entry of entries) {
        if (truncated || aborted) return;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const chk = ignore.check(rel, { isDir: true });
          if (chk.ignored) continue;
          dirs.push(toPosix(rel));
          await walk(path.join(dirAbs, entry.name), rel, depth + 1);
        } else if (entry.isFile()) {
          const relPosix = toPosix(rel);
          const sens = detectSensitive(relPosix);
          if (sens.sensitive) {
            const st = await statSafe(path.join(dirAbs, entry.name));
            sensitiveFiles.push({ path: relPosix, rule: sens.rule, sizeBytes: st ? st.size : null });
            noteSensitiveSkip();
            // NEVER read. Not even for stats beyond size.
            continue;
          }
          const chk = ignore.check(relPosix);
          if (chk.ignored) continue;
          const st = await statSafe(path.join(dirAbs, entry.name));
          if (!st) continue;
          if (files.length >= lim.maxFiles) {
            truncated = true;
            warnings.push(`maxFiles ${lim.maxFiles} reached; scan is partial`);
            return;
          }
          files.push({ path: relPosix, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), ext: path.extname(entry.name).toLowerCase() });
          largestFiles.push({ path: relPosix, sizeBytes: st.size });
          if (largestFiles.length > 200) {
            largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
            largestFiles.length = 100;
          }
        }
      }
    };

    await walk(root, '', 1);
    largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
    largestFiles.length = Math.min(largestFiles.length, 25);

    const relPaths = files.map((f) => f.path);
    const extCounts = new Map();
    const roleCounts = { source: 0, test: 0, e2e: 0, docs: 0, unknown: 0 };
    for (const f of files) {
      extCounts.set(f.ext, (extCounts.get(f.ext) || 0) + 1);
      const role = CODE_FILE_ROLE(f.path);
      f.role = role;
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }

    const hasAnyFile = (rx) => relPaths.some((p) => rx.test(p.split('/').pop()));
    const packageJsonResult = await readWorkspaceText(root, 'package.json', { maxBytes: 512 * 1024 });
    let packageJson = null;
    if (packageJsonResult.ok) {
      try {
        const raw = JSON.parse(packageJsonResult.text);
        packageJson = {
          name: typeof raw.name === 'string' ? raw.name : null,
          version: typeof raw.version === 'string' ? raw.version : null,
          private: !!raw.private,
          type: raw.type === 'module' ? 'module' : 'commonjs',
          scripts: raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {},
          dependencies: raw.dependencies && typeof raw.dependencies === 'object' ? raw.dependencies : {},
          devDependencies: raw.devDependencies && typeof raw.devDependencies === 'object' ? raw.devDependencies : {},
          workspaces: raw.workspaces || null,
          engines: raw.engines || null,
        };
      } catch (err) {
        warnings.push(`package.json could not be parsed: ${err.message}`);
      }
    }

    const pythonDeps = new Set();
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
      const r = await readWorkspaceText(root, f, { maxBytes: 256 * 1024 });
      if (r.ok) {
        r.text.toLowerCase().split(/\r?\n/).forEach((line) => {
          const m = line.match(/^\s*["']?([a-z0-9_.-]+)["']?\s*[=><~!\[]/i);
          if (m) pythonDeps.add(m[1].toLowerCase());
        });
      }
    }

    const allDeps = new Set([
      ...Object.keys(packageJson ? packageJson.dependencies : {}),
      ...Object.keys(packageJson ? packageJson.devDependencies : {}),
    ].map((d) => d.toLowerCase()));

    const ctx = {
      has: (f) => relPaths.includes(f),
      hasAny: (rx) => hasAnyFile(rx),
      dep: (d) => allDeps.has(d.toLowerCase()),
      pythonDep: (d) => pythonDeps.has(d.toLowerCase()),
      countExt: (ext) => extCounts.get(ext) || 0,
      files: relPaths,
    };

    const languages = [];
    for (const [ext, count] of [...extCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const lang = EXT_LANG[ext];
      if (!lang) continue;
      const existing = languages.find((l) => l.name === lang);
      if (existing) existing.files += count;
      else languages.push({ name: lang, files: count });
    }
    languages.sort((a, b) => b.files - a.files);
    const primaryLanguage = languages.length ? languages[0].name : 'unknown';

    const frameworks = FRAMEWORK_DETECTORS.filter((d) => {
      try { return d.match(ctx); } catch { return false; }
    }).map((d) => d.name);
    const primaryFramework = frameworks[0] || 'unknown';

    const ecosystems = LANGUAGE_DETECTORS.filter((d) => {
      try { return d.match(ctx); } catch { return false; }
    }).map((d) => d.name);

    const markdownDocs = [];
    for (const f of files) {
      if (aborted) break;
      if (f.ext === '.md' || f.ext === '.mdx') {
        const r = await readWorkspaceText(root, f.path, { maxBytes: 256 * 1024 });
        const base = f.path.split('/').pop();
        const kind = normaliseSpecKind(f.path);
        markdownDocs.push({
          path: f.path,
          kind,
          title: r.ok ? (r.text.split(/\r?\n/).find((l) => l.trim().startsWith('#')) || '').replace(/^#+\s*/, '').trim() : '',
          bytes: f.sizeBytes,
          readable: r.ok,
          isSpecCandidate: SPEC_CANDIDATE_RE.test(base) || kind === 'doc',
          role: f.role,
        });
      }
    }

    const configFiles = {
      tsconfig: relPaths.some((p) => /(^|\/)tsconfig(\..*)?\.json$/.test(p)),
      vite: ctx.hasAny(/^vite\.config\.(js|mjs|ts|cjs)$/),
      next: ctx.hasAny(/^next\.config\.(js|mjs|ts|cjs)$/),
      playwright: ctx.hasAny(/^playwright\.config\.(ts|js|mjs)$/),
      vitest: ctx.hasAny(/^vitest\.config\.(ts|js|mts)$/),
      jest: ctx.hasAny(/^jest\.config\.(js|ts|cjs|mjs|json)$/),
      eslint: relPaths.some((p) => /(^|\/)\.eslintrc(\.|$)|(^|\/)eslint\.config\./.test(p)),
      prettier: relPaths.some((p) => /(^|\/)\.prettierrc(\.|$)|(^|\/)prettier\.config\./.test(p)),
      tailwind: relPaths.some((p) => /(^|\/)tailwind\.config\./.test(p)),
      docker: relPaths.some((p) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/.test(p)),
      ci: relPaths.some((p) => /^\.github\/workflows\//.test(p)),
    };

    const directories = {
      src: relPaths.some((p) => /^src\//.test(p)),
      tests: relPaths.some((p) => /^tests?\//.test(p)),
      e2e: relPaths.some((p) => /(^|\/)e2e\//.test(p)),
      docs: relPaths.some((p) => /^docs?\//.test(p)),
      app: relPaths.some((p) => /^app\//.test(p)),
      pages: relPaths.some((p) => /^pages\//.test(p)),
      monorepoApps: relPaths.some((p) => /^apps\//.test(p)),
      monorepoPackages: relPaths.some((p) => /^packages\//.test(p)),
    };

    const todos = await this.#collectMarkers(root, files, lim, signal);

    const fingerprintInput = files
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .slice(0, 5000)
      .map((f) => `${f.path}:${f.sizeBytes}:${f.mtimeMs}`)
      .join('|');
    const fileFingerprint = sha1(`${files.length}|${dirs.length}|${fingerprintInput}`);

    const gitDirStat = await statSafe(path.join(root, '.git'));
    const isGitRepositoryHint = !!gitDirStat && gitDirStat.isDirectory();

    return {
      ok: true,
      root: toPosix(root),
      name: name || (packageJson && packageJson.name) || path.basename(root),
      scannedAt: nowIso(),
      durationMs: Date.now() - started,
      truncated,
      aborted,
      warnings,
      fileCount: files.length,
      dirCount: dirs.length,
      totalBytes: files.reduce((a, f) => a + f.sizeBytes, 0),
      fileFingerprint,
      primaryLanguage,
      languages,
      ecosystems,
      framework: primaryFramework,
      frameworks,
      packageManager: detectPackageManager(relPaths, packageJson),
      packageJson,
      isGitRepositoryHint,
      configFiles,
      directories,
      roleCounts,
      extCounts: Object.fromEntries(extCounts),
      markdownDocs,
      specCandidates: markdownDocs.filter((d) => d.isSpecCandidate).map((d) => d.path),
      sensitiveFiles: uniqueBy(sensitiveFiles, (f) => f.path),
      sensitiveCount: sensitiveFiles.length,
      largestFiles,
      todos,
      topLevelFiles: uniqueBy(files.filter((f) => !f.path.includes('/')).map((f) => f.path), (x) => x).slice(0, 50),
      readAudit: { ...FILE_READ_AUDIT },
      ignoreStats: ignore.stats,
      ignoreDescribe: ignore.describe(),
    };
  }

  async #collectMarkers(root, files, lim, signal = null) {
    const out = [];
    const candidates = files.filter((f) => ['source', 'test', 'e2e', 'unknown'].includes(f.role) && f.sizeBytes <= 512 * 1024);
    const limit = Math.min(candidates.length, 2000);
    for (let i = 0; i < limit; i += 1) {
      if (signal && signal.aborted) return out;
      const f = candidates[i];
      const r = await readWorkspaceText(root, f.path, { maxBytes: 512 * 1024 });
      if (!r.ok) continue;
      const lines = r.text.split(/\r?\n/);
      for (let ln = 0; ln < lines.length; ln += 1) {
        const line = lines[ln];
        const m = line.match(/(TODO|FIXME|HACK|XXX)\b[:\s]*(.{0,160})/);
        if (m) {
          out.push({ kind: m[1], text: m[2].trim(), path: f.path, line: ln + 1 });
          if (out.length >= 500) return out;
        }
      }
    }
    return out;
  }
}

export function scanSummary(meta) {
  if (!meta || !meta.ok) return { ok: false, reason: meta ? meta.reason : 'unknown' };
  return {
    ok: true,
    name: meta.name,
    language: meta.primaryLanguage,
    framework: meta.framework,
    packageManager: meta.packageManager,
    fileCount: meta.fileCount,
    truncated: meta.truncated,
    sensitiveCount: meta.sensitiveCount,
    markerCount: meta.todos.length,
  };
}

export { CODE_FILE_ROLE, normaliseSpecKind, looksBinary };
