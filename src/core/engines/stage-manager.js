/**
 * StageManager — requirement #27.
 * Infers project stages from specifications, README headings and task distribution.
 * When the evidence is insufficient it reports `unknown` rather than inventing stages.
 */
import { STAGE_STATUS, TASK_STATUS, GATE_RESULT, CONFIDENCE } from '../../domain/constants.js';
import { newId } from '../util.js';
import { parseStageTitle } from './spec-manager.js';
import { evFile } from '../evidence.js';
import { logger } from '../logger.js';

const log = logger.child('stage');

export class StageManager {
  constructor({ repo } = {}) { this.repo = repo; }

  /** Collect stage candidates from specs/readme headings (deterministic). */
  inferCandidates({ specs = [] } = {}) {
    const found = new Map();
    for (const spec of specs) {
      const parsed = spec.parsed || {};
      for (const s of parsed.stages || []) {
        // A stage without a name is still a stage — it is numbered, so say so. Resolving the name
        // BEFORE the dedupe key is what keeps one odd document from throwing a full scan down.
        const name = s.name || `Stage ${s.index}`;
        const key = `${s.index}:${name.toLowerCase()}`;
        if (found.has(key)) continue;
        found.set(key, {
          name,
          index: s.index,
          description: `Declared in ${spec.path}`,
          evidence: [evFile(spec.path, `line ${s.line}`)],
          confidence: CONFIDENCE.HIGH,
        });
      }
      for (const h of parsed.headings || []) {
        const m = parseStageTitle(h.title);
        if (!m) continue;
        const key = `${m.index || ''}:${m.name.toLowerCase()}`;
        if (found.has(key)) continue;
        found.set(key, {
          name: m.name,
          index: m.index || found.size + 1,
          description: `Heading in ${spec.path}`,
          evidence: [evFile(spec.path, `line ${h.line}`)],
          confidence: CONFIDENCE.MEDIUM,
        });
      }
    }
    return [...found.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
  }

  /** @returns {{stages:Array, strategy:string, confidence:string}} */
  plan({ specs = [], tasks = [], acceptance = [] } = {}) {
    const candidates = this.inferCandidates({ specs });
    if (!candidates.length) {
      if (!tasks.length) {
        return {
          stages: [],
          strategy: 'none',
          confidence: CONFIDENCE.UNKNOWN,
          note: '规范中没有阶段声明，也不存在任务——阶段未知。',
        };
      }
      return {
        stages: [{
          name: '未规划的工作',
          index: 1,
          description: '存在任务，但无法从文档推断出阶段结构。',
          evidence: [],
          confidence: CONFIDENCE.LOW,
        }],
        strategy: 'task_bucket',
        confidence: CONFIDENCE.LOW,
        note: '阶段结构仅根据任务账本推断。',
      };
    }

    // Attach tasks to stages by keyword overlap between task title and stage name.
    const stages = candidates.map((c) => {
      const tokens = new Set(c.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3));
      const related = tasks.filter((t) => {
        const title = t.title.toLowerCase();
        return [...tokens].some((tok) => title.includes(tok));
      });
      const relatedCriteria = acceptance.filter((a) => (a.stage_name || '').toLowerCase() === c.name.toLowerCase());
      return { ...c, tasks: related, criteria: relatedCriteria };
    });

    return { stages, strategy: 'spec_declared', confidence: CONFIDENCE.HIGH, note: '' };
  }

  static statusFor(stage) {
    const tasks = stage.tasks || [];
    if (tasks.some((t) => t.status === TASK_STATUS.BLOCKED)) return STAGE_STATUS.BLOCKED;
    const done = tasks.filter((t) => t.status === TASK_STATUS.DONE).length;
    const open = tasks.filter((t) => t.status !== TASK_STATUS.DONE && t.status !== TASK_STATUS.CANCELLED).length;
    const unmetCriteria = (stage.criteria || []).filter((c) => c.status === 'unmet').length;
    if (tasks.length === 0 && (stage.criteria || []).length === 0) return STAGE_STATUS.NOT_STARTED;
    if (open === 0 && unmetCriteria === 0 && (done > 0 || (stage.criteria || []).length > 0)) return STAGE_STATUS.COMPLETED;
    if (done > 0 || tasks.some((t) => t.status === TASK_STATUS.IN_PROGRESS)) return STAGE_STATUS.IN_PROGRESS;
    return STAGE_STATUS.NOT_STARTED;
  }

  /** Materialise stages in the DB (idempotent by name). */
  sync(projectId, planned) {
    if (!this.repo) throw new Error('StageManager requires a repository');
    const existing = this.repo.list('stages', { project_id: projectId }, { orderBy: 'order_index' });
    const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]));
    const out = [];
    planned.stages.forEach((s, idx) => {
      const status = StageManager.statusFor(s);
      const key = s.name.toLowerCase();
      const taskIds = (s.tasks || []).map((t) => t.id);
      const found = byName.get(key);
      if (found) {
        const patch = { order_index: idx, status, description: s.description || found.description };
        if (status === STAGE_STATUS.COMPLETED && !found.completed_at) patch.completed_at = new Date().toISOString();
        if (status === STAGE_STATUS.IN_PROGRESS && !found.started_at) patch.started_at = new Date().toISOString();
        out.push(this.repo.update('stages', found.id, patch));
      } else {
        out.push(this.repo.insert('stages', {
          id: newId('stg'),
          project_id: projectId,
          name: s.name,
          description: s.description || '',
          status,
          order_index: idx,
          source: planned.strategy,
          confidence: s.confidence || CONFIDENCE.MEDIUM,
          started_at: status === STAGE_STATUS.IN_PROGRESS || status === STAGE_STATUS.COMPLETED ? new Date().toISOString() : null,
          completed_at: status === STAGE_STATUS.COMPLETED ? new Date().toISOString() : null,
        }));
      }
      for (const taskId of taskIds) this.repo.update('tasks', taskId, { stage_id: (out[out.length - 1] || {}).id });
    });
    log.info('synced', { count: out.length, strategy: planned.strategy });
    return { stages: out, strategy: planned.strategy, confidence: planned.confidence, note: planned.note || '' };
  }

  currentStage(stages, tasks) {
    if (!stages.length) return null;
    const inProgress = stages.find((s) => s.status === STAGE_STATUS.IN_PROGRESS);
    if (inProgress) return inProgress;
    const blocked = stages.find((s) => s.status === STAGE_STATUS.BLOCKED);
    if (blocked) return blocked;
    const notStarted = stages.find((s) => s.status === STAGE_STATUS.NOT_STARTED);
    if (notStarted) return notStarted;
    return stages[stages.length - 1];
  }
}

export const GATE_ORDER = [GATE_RESULT.PASS, GATE_RESULT.FAIL, GATE_RESULT.BLOCKED, GATE_RESULT.UNKNOWN];
