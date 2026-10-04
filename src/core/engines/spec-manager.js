/**
 * SpecificationManager — requirement #23.
 *
 * Recognises specifications by CONTENT, not just file name (a doc named `notes.md`
 * that contains "## Acceptance Criteria" is still a specification).
 * Extracts: goals, requirements, acceptance criteria, out-of-scope, constraints.
 */
import { readWorkspaceText } from '../fs-safe.js';
import { newId, nowIso, sha256 } from '../util.js';
import { evFile, evSpec } from '../evidence.js';
import { logger } from '../logger.js';

const log = logger.child('spec');

const SECTION_RULES = [
  { key: 'goals', rx: /^(goals?|objectives?|purpose|summary|overview)\b/i },
  { key: 'requirements', rx: /^(requirements?|functional requirements?|user stories|features?)\b/i },
  { key: 'acceptance', rx: /^(acceptance criteria|acceptance|definition of done|dod|success criteria)\b/i },
  { key: 'outOfScope', rx: /^(out of scope|non[- ]goals?|not in scope|excluded)\b/i },
  { key: 'constraints', rx: /^(constraints?|assumptions?|limitations?|non[- ]functional)\b/i },
  { key: 'stages', rx: /^(stages?|phases?|milestones?|roadmap|plan)\b/i },
  { key: 'risks', rx: /^(risks?|known issues)\b/i },
];

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const CHECKBOX_RE = /^\s*[-*+]\s*\[( |x|X)\]\s+(.*)$/;
// NOTE: the checkbox prefix must stay NON-capturing so group 1 is always the bullet text.
const BULLET_RE = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const REQ_REF_RE = /\b((?:REQ|REQUIREMENT|STORY|US|AC)[-_ ]?\d+(?:\.\d+)?)\b/i;
/**
 * Parse a stage-like title. Two explicit forms only — a bare word such as "Stages"
 * must NOT be treated as a stage declaration.
 *   "Stage 1 — Foundations"  -> { index: 1, name: "Foundations" }
 *   "Phase — Discovery"      -> { index: null, name: "Discovery" }
 */
export function parseStageTitle(title) {
  const t = String(title || '').trim();
  let m = /^(?:stage|phase|milestone|step|iteration|sprint)\s*[—\-:.)]\s*(.+)$/i.exec(t);
  if (m && m[1] && m[1].trim()) return { index: null, name: m[1].trim() };
  m = /^(?:stage|phase|milestone|step|iteration|sprint)\s+(\d+)\b\s*[—\-:.)]?\s*(.*)$/i.exec(t);
  if (m) return { index: Number(m[1]), name: (m[2] || '').trim() || `Stage ${m[1]}` };
  return null;
}

function classifySection(heading) {
  const h = heading.trim().toLowerCase();
  for (const r of SECTION_RULES) if (r.rx.test(h)) return r.key;
  return null;
}

export function parseMarkdown(text, { path: relPath = '' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const result = {
    path: relPath,
    title: '',
    goals: [],
    requirements: [],
    acceptance: [],
    outOfScope: [],
    constraints: [],
    stages: [],
    checkboxes: [],
    headings: [],
    sections: {},
  };
  let current = null;
  let currentStage = null;

  lines.forEach((line, i) => {
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      result.headings.push({ level, title, line: i + 1 });
      if (!result.title && level === 1) result.title = title;
      const stageMatch = parseStageTitle(title);
      if (stageMatch && level <= 3) {
        currentStage = {
          name: stageMatch.name,
          index: stageMatch.index || result.stages.length + 1,
          line: i + 1,
        };
        result.stages.push(currentStage);
      }
      current = classifySection(title.replace(/^\d+[.)]?\s*/, ''));
      if (current) result.sections[current] = result.sections[current] || { heading: title, items: [] };
      return;
    }

    const cb = CHECKBOX_RE.exec(line);
    if (cb) {
      const item = { text: cb[2].trim(), checked: cb[1].toLowerCase() === 'x', line: i + 1, path: relPath, stage: currentStage ? currentStage.name : null };
      result.checkboxes.push(item);
      const bucket = current || 'acceptance';
      // `stages` is a structured list of stage DECLARATIONS ({name,index,line}); a checkbox is
      // not one. Pushing it there used to append a row with no `name`, and the first full scan of
      // any README shaped like "## Stage 1 — Setup" + "- [x] scaffold" then died with
      // `Cannot read properties of undefined (reading 'toLowerCase')`. The checkbox still lands in
      // sections.stages.items, so nothing about the document is lost — it just stops being
      // mistaken for a stage.
      if (bucket !== 'stages') {
        if (Array.isArray(result[bucket])) result[bucket].push(item);
        else if (bucket in result) result[bucket].push(item);
      }
      if (result.sections[bucket]) result.sections[bucket].items.push(item);
      return;
    }

    const bullet = BULLET_RE.exec(line) || NUMBERED_RE.exec(line);
    if (bullet && current) {
      const textValue = (bullet[1] || '').trim();
      if (!textValue) return;
      if (current === 'stages') {
        const sm = parseStageTitle(textValue.replace(/\*\*/g, ''));
        if (sm) {
          result.stages.push({ name: sm.name, index: sm.index || result.stages.length + 1, line: i + 1 });
        } else {
          // Not a stage declaration — keep it as a plain bullet in the section, not a stage.
          if (result.sections[current]) result.sections[current].items.push({ text: textValue, line: i + 1, path: relPath });
        }
        return;
      }
      const refMatch = REQ_REF_RE.exec(textValue);
      const item = { text: textValue, ref: refMatch ? refMatch[1].toUpperCase() : '', line: i + 1, path: relPath };
      if (Array.isArray(result[current])) result[current].push(item);
      if (result.sections[current]) result.sections[current].items.push(item);
    }
  });

  // Requirements without an explicit REQ-n get a stable synthetic ref.
  result.requirements = result.requirements.map((r, idx) => ({ ...r, ref: r.ref || `REQ-${idx + 1}` }));
  return result;
}

/** Does this markdown look like a specification, whatever it is called? */
export function looksLikeSpec(parsed, { path = '' } = {}) {
  let score = 0;
  const base = path.split('/').pop().toLowerCase();
  if (/^(spec|specification|prd|requirements|req)\.md$/.test(base)) score += 3;
  if (base === 'readme.md') score += 0;
  if (parsed.acceptance.length) score += 2;
  if (parsed.requirements.length) score += 2;
  if (parsed.goals.length) score += 1;
  if (parsed.outOfScope.length) score += 1;
  if (parsed.constraints.length) score += 1;
  if (parsed.stages.length >= 1) score += 2; // a declared stage/phase structure is a strong specification signal
  if (parsed.checkboxes.length) score += 1;
  return score >= 2;
}

export function specKindFromPath(relPath, parsed) {
  const base = relPath.split('/').pop().toLowerCase();
  if (base === 'spec.md' || base === 'specification.md') return 'spec';
  if (base === 'prd.md') return 'prd';
  if (base === 'requirements.md') return 'requirements';
  if (base === 'readme.md') return parsed && (parsed.acceptance.length || parsed.requirements.length) ? 'readme_with_spec' : 'readme';
  if (base === 'todo.md' || base === 'tasks.md') return 'todo_list';
  if (/^docs?\//.test(relPath)) return 'doc';
  return 'other';
}

export class SpecificationManager {
  /**
   * @param {{root:string, metadata:object}} project
   * @returns {Promise<{specifications:Array, acceptanceCriteria:Array, warnings:Array}>}
   */
  async analyze(project) {
    const warnings = [];
    const specifications = [];
    const acceptanceCriteria = [];
    const docs = (project.metadata && project.metadata.markdownDocs) || [];
    const candidates = docs.filter((d) => d.readable !== false && (d.isSpecCandidate || d.role === 'docs' || d.role === 'source' || d.path.includes('/')));

    for (const doc of candidates) {
      const res = await readWorkspaceText(project.root, doc.path, { maxBytes: 512 * 1024 });
      if (!res.ok) {
        if (res.reason === 'sensitive_file_protected') warnings.push(`skipped sensitive document ${doc.path}`);
        continue;
      }
      const parsed = parseMarkdown(res.text, { path: doc.path });
      const isSpec = looksLikeSpec(parsed, { path: doc.path });
      if (!isSpec) continue;
      const kind = specKindFromPath(doc.path, parsed);
      const specId = newId('spc');
      const contentHash = sha256(res.text).slice(0, 16);
      specifications.push({
        id: specId,
        path: doc.path,
        kind,
        title: parsed.title || doc.title || doc.path,
        parsed,
        content_hash: contentHash,
        byte_size: res.bytes,
        score: (parsed.acceptance.length ? 2 : 0) + (parsed.requirements.length ? 2 : 0) + (parsed.goals.length ? 1 : 0),
      });
      for (const a of parsed.acceptance) {
        acceptanceCriteria.push({
          id: newId('acc'),
          spec_id: specId,
          spec_path: doc.path,
          requirement_ref: a.ref || '',
          text: a.text,
          kind: 'checkbox',
          status: a.checked ? 'satisfied' : 'unmet',
          evidence: [evFile(doc.path, `line ${a.line}`)],
          stage_name: a.stage || null,
        });
      }
      for (const r of parsed.requirements) {
        acceptanceCriteria.push({
          id: newId('acc'),
          spec_id: specId,
          spec_path: doc.path,
          requirement_ref: r.ref || '',
          text: r.text,
          kind: 'requirement',
          status: 'unknown',
          evidence: [evSpec(r.ref || doc.path, `line ${r.line}`)],
          stage_name: null,
        });
      }
      for (const o of parsed.outOfScope) {
        acceptanceCriteria.push({
          id: newId('acc'),
          spec_id: specId,
          spec_path: doc.path,
          requirement_ref: '',
          text: o.text,
          kind: 'out_of_scope',
          status: 'unknown',
          evidence: [evSpec(doc.path, `line ${o.line}`)],
          stage_name: null,
        });
      }
    }

    log.info('analyzed', { docs: candidates.length, specs: specifications.length, criteria: acceptanceCriteria.length });
    return { specifications, acceptanceCriteria, warnings };
  }
}

export function specSummary(specs, criteria) {
  if (!specs.length) return { found: false, count: 0, criteriaCount: criteria.length, unmet: 0 };
  return {
    found: true,
    count: specs.length,
    paths: specs.map((s) => s.path),
    criteriaCount: criteria.length,
    unmet: criteria.filter((c) => c.status === 'unmet').length,
    satisfied: criteria.filter((c) => c.status === 'satisfied').length,
    generated: nowIso(),
  };
}
