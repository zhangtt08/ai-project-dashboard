/**
 * Project command trust — one decision function for "may Commander run this folder's scripts".
 *
 * Why this exists: a full scan of an added folder runs the build/test commands it detects
 * (`src/server/routes.js` used to default `runCommands` to true, and the scanners detect
 * `npm run build` / `npm test` out of whatever package.json is sitting there). Dragging a folder
 * in — or first-run discovery importing twenty of them — must not mean executing a stranger's
 * package.json unattended. Scripts are only run when the folder is *trusted*, and trust is a
 * decision, not a default.
 *
 * Where trust comes from, exactly three places:
 *   1. Rows that already existed before this flag shipped get `trusted = 1` from MIGRATION_6.
 *      Those folders were picked by this person on this machine; silently switching them to
 *      "no build, no test results" would break the app's own self-scan and every tracked
 *      project, and it would arrive as a surprise rather than as a decision they made.
 *   2. Commander's own demo fixtures (`<dataDir>/demo-projects`, written by
 *      src/demo/fixture-factory.js) are trusted at insert time — this program wrote those files.
 *   3. A person says so, in the UI (POST /api/projects/:id/trust) or through the Agent tool
 *      `commander.project.trust`, and the row flips.
 * Everything else — POST /api/projects, drag & drop import, discovery import, first-run import —
 * lands at `trusted = 0`, which means metadata + git + specs only, never a subprocess of theirs.
 *
 * This module is deliberately import-free: the same function is the whole policy, so a reviewer
 * can read the rule once instead of chasing it through routes, orchestrator and the queue.
 */
import { nowIso } from './util.js';

/** The two commands a trusted project may have auto-run by a scan. */
export const TRUST_REASON_CODE = 'workspace_untrusted';

/**
 * @param {object|null} project the projects row (needs `trusted`, tolerates missing columns)
 * @param {boolean} [requested] what the caller asked for (scan payload / handler default)
 * @returns {{allowed:boolean, requested:boolean, trusted:boolean, reason:string}}
 */
export function commandsAllowedFor(project, requested = true) {
  const trusted = isTrusted(project);
  if (!requested) {
    return { allowed: false, requested: false, trusted, reason: '本次扫描没有要求执行命令（runCommands=false）。' };
  }
  if (!trusted) {
    return {
      allowed: false, requested: true, trusted: false,
      reason: '该工作区尚未标记为可信，Commander 只读文件、读 Git、解析文档，不会执行它的 package.json 脚本。在项目页「信任」里点一下才会跑构建与测试。',
    };
  }
  return { allowed: true, requested: true, trusted: true, reason: '' };
}

/** Missing column (older database, hand-written row) means untrusted — the safe direction. */
export function isTrusted(project) {
  if (!project) return false;
  return project.trusted === true || project.trusted === 1;
}

/** What the UI shows, so the page and the server can never disagree about the reason. */
export function trustState(project) {
  const trusted = isTrusted(project);
  return {
    trusted,
    source: trusted ? trustedSource(project) : 'untrusted',
    labelZh: trusted ? '已信任：扫描会执行检测到的构建/测试命令' : '未信任：只分析文件，不执行任何脚本',
    meaningZh: trusted
      ? '信任的涵义是：这个目录里的 package.json / Makefile / 脚本由你本人或你了解的人维护，跑起来不会把数据发走或删东西。'
      : '未信任的涵义是：Commander 不执行这个目录里的任何命令。别人的项目在你点头之前只是一堆文本文件。',
    howToEnableZh: '项目页 →「信任」标签 →「信任并允许执行命令」。这一步只在数据库里把这一行改成已信任，不会立刻跑任何东西；下一次扫描才开始执行命令。',
    decidedAt: trusted ? (project.trusted_at || null) : null,
  };
}

function trustedSource(project) {
  if (project.trusted_source === 'migration') return 'migration';
  if (project.trusted_source === 'demo') return 'demo';
  if (project.trusted_source === 'user') return 'user';
  // The Agent tool commander.project.trust records this. It is a distinct provenance on
  // purpose: "a person clicked it in the UI" and "a person told an agent to do it" have to be
  // tellable apart afterwards, and folding them into 'user' would erase that.
  if (project.trusted_source === 'agent') return 'agent';
  return 'unknown';
}

/** The row patch a trust decision writes. Kept here so no caller invents its own shape. */
export function trustPatch(trusted, { source = 'user' } = {}) {
  return {
    trusted: trusted ? 1 : 0,
    trusted_at: trusted ? nowIso() : null,
    trusted_source: trusted ? source : null,
  };
}
