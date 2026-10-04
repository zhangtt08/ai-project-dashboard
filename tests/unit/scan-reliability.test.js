/**
 * 扫描可靠性的四条判据 —— the things a person pressing a button is entitled to believe:
 *   · the same scan cannot be queued twice by an impatient click;
 *   · cancelling keeps the job CANCELLED instead of relabelling the user's own action as a failure;
 *   · progress is a real step index from the queue, not an invented percentage;
 *   · an odd README cannot throw a whole scan down.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisQueue } from '../../src/core/jobs.js';
import { StageManager } from '../../src/core/engines/stage-manager.js';
import { parseMarkdown } from '../../src/core/engines/spec-manager.js';
import { FULL_SCAN_STEPS } from '../../src/core/orchestrator.js';
import { killProcessTree } from '../../src/core/command-runner.js';
import { JOB_TYPE, JOB_STATUS } from '../../src/domain/constants.js';
import { openDatabase } from '../../src/db/database.js';
import { Repository } from '../../src/db/repositories.js';

const OPEN = [];
after(() => {
  for (const db of OPEN) { try { db.close(); } catch { /* already closed */ } }
  OPEN.length = 0;
});

function makeRepo() {
  const db = openDatabase(':memory:');
  OPEN.push(db);
  return new Repository(db);
}

/** analysis_jobs.project_id is a real foreign key — a queue test needs the project it points at. */
function makeQueueRepo({ concurrency = 1 } = {}) {
  const repo = makeRepo();
  const seed = (id) => repo.insert('projects', { id, name: id, workspace_path: `/apc-test/${id}` });
  for (const id of ['prj_a', 'prj_b', 'prj_c', 'prj_d', 'prj_e', 'prj_f']) seed(id);
  return { repo, queue: new AnalysisQueue({ repo, concurrency }) };
}

describe('分析队列：重复点按的幂等', () => {
  test('a second scan of the same project returns the job already queued, not a second one', () => {
    const { repo, queue } = makeQueueRepo();
    const first = queue.enqueue({ projectId: 'prj_a', type: JOB_TYPE.FULL_SCAN, payload: {}, dedupe: true });
    const second = queue.enqueue({ projectId: 'prj_a', type: JOB_TYPE.FULL_SCAN, payload: {}, dedupe: true });
    assert.equal(second.id, first.id, 'the impatient click must reuse the queued job');
    assert.equal(second.reused, true, 'the caller must be able to tell it was deduped');
    assert.equal(repo.list('analysis_jobs', {}).length, 1, 'no second row may exist');
  });

  test('a different type for the same project is still its own job', () => {
    const { queue } = makeQueueRepo();
    const a = queue.enqueue({ projectId: 'prj_a', type: JOB_TYPE.FULL_SCAN, dedupe: true });
    const b = queue.enqueue({ projectId: 'prj_a', type: JOB_TYPE.QUICK_SCAN, dedupe: true });
    assert.notEqual(a.id, b.id, 'dedupe is per (project, type), not per project');
  });

  test('without dedupe the queue behaves as before (commands can still be run twice)', () => {
    const { queue } = makeQueueRepo();
    const a = queue.enqueue({ projectId: 'prj_a', type: JOB_TYPE.BUILD, payload: { kind: 'build' } });
    const b = queue.enqueue({ projectId: 'prj_a', type: JOB_TYPE.BUILD, payload: { kind: 'build' } });
    assert.notEqual(a.id, b.id);
  });
});

describe('分析队列：取消', () => {
  test('a cancelled job stays CANCELLED after its handler settles', async () => {
    const { repo, queue } = makeQueueRepo();
    let sawSignal = false;
    queue.register(JOB_TYPE.FULL_SCAN, async (payload, ctx) => {
      // Behaves like the real pipeline: it keeps working until the abort reaches it. The window is
      // seconds wide so the assertion measures the cancel, not which side of a 40ms race won.
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(done, 2000);
        if (ctx.signal) { if (ctx.signal.aborted) done(); else ctx.signal.addEventListener('abort', done); }
      });
      sawSignal = !!(ctx.signal && ctx.signal.aborted);
      throw new Error('cancelled by user');
    });
    const job = queue.enqueue({ projectId: 'prj_c', type: JOB_TYPE.FULL_SCAN, maxAttempts: 3 });
    queue.start(2);
    for (let i = 0; i < 500 && (repo.get('analysis_jobs', job.id) || {}).status !== JOB_STATUS.RUNNING; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(queue.cancel(job.id), true, 'cancelling a running job reports success');
    // Wait for the handler to actually settle — `cancel()` flips the row to CANCELLED immediately,
    // so polling the row would return before the abort had reached anything.
    for (let i = 0; i < 400 && queue.running.size > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    queue.stop();
    const row = repo.get('analysis_jobs', job.id);
    assert.equal(sawSignal, true, 'the handler must see the abort signal — that is what kills its child process');
    assert.equal(row.status, JOB_STATUS.CANCELLED, `expected cancelled, got ${row.status} ("${row.error}")`);
    assert.notEqual(row.status, JOB_STATUS.FAILED, 'a user cancel must not be recorded as a project failure');
    assert.notEqual(row.status, JOB_STATUS.QUEUED, 'and it must not be retried behind the user');
  });

  test('cancelling a job that already finished says so instead of pretending', () => {
    const { repo, queue } = makeQueueRepo();
    const job = queue.enqueue({ projectId: 'prj_d', type: JOB_TYPE.FULL_SCAN });
    repo.update('analysis_jobs', job.id, { status: JOB_STATUS.COMPLETED });
    assert.equal(queue.cancel(job.id), false);
  });

  test('findActive sees a running job and nothing after it ends', () => {
    const { repo, queue } = makeQueueRepo();
    const job = queue.enqueue({ projectId: 'prj_e', type: JOB_TYPE.FULL_SCAN, dedupe: true });
    assert.equal(queue.findActive('prj_e', JOB_TYPE.FULL_SCAN).id, job.id);
    repo.update('analysis_jobs', job.id, { status: JOB_STATUS.COMPLETED });
    assert.equal(queue.findActive('prj_e', JOB_TYPE.FULL_SCAN), null);
    assert.equal(queue.enqueue({ projectId: 'prj_e', type: JOB_TYPE.FULL_SCAN, dedupe: true }).reused, undefined, 'a finished scan is not deduped against');
  });
});

describe('分析队列：进度', () => {
  test('progress is persisted while running and ignored once the job left RUNNING', async () => {
    const { repo, queue } = makeQueueRepo();
    const job = queue.enqueue({ projectId: 'prj_f', type: JOB_TYPE.FULL_SCAN });
    // Not running yet — a report must not resurrect a job that never started.
    assert.equal(queue.reportProgress(job.id, { step: 1, total: FULL_SCAN_STEPS.length, label: FULL_SCAN_STEPS[0] }), null);
    repo.update('analysis_jobs', job.id, { status: JOB_STATUS.RUNNING });
    queue.reportProgress(job.id, { step: 6, total: 15, label: '构建' });
    const row = repo.get('analysis_jobs', job.id);
    assert.equal(row.progress.step, 6);
    assert.equal(row.progress.label, '构建');
    assert.ok(row.progress.at, 'the report is timestamped so the UI can tell when it was last true');
  });

  test('the step list matches the numbered stages the orchestrator actually walks', () => {
    assert.ok(FULL_SCAN_STEPS.includes('构建') && FULL_SCAN_STEPS.includes('测试'));
    assert.equal(new Set(FULL_SCAN_STEPS).size, FULL_SCAN_STEPS.length, 'step names are keys — a duplicate would make the index lie');
  });
});

describe('取消要杀到进程树', () => {
  test('killProcessTree is exported from the one module that may spawn', () => {
    assert.equal(typeof killProcessTree, 'function');
    // A pid of 0 / null must be refused rather than handed to taskkill (which would widen the blast radius).
    assert.equal(killProcessTree(null), false);
    assert.equal(killProcessTree(0), false);
  });
});

describe('规范解析不能被一份 README 打断', () => {
  test('checkboxes under a stage heading are not recorded as stages', () => {
    const parsed = parseMarkdown('# T\n\n## Stage 1 — Setup\n\n- [x] scaffold\n- [ ] deploy\n', { path: 'README.md' });
    assert.equal(parsed.stages.length, 1, `expected exactly the one declared stage, got ${JSON.stringify(parsed.stages)}`);
    assert.equal(parsed.stages[0].name, 'Setup');
    assert.equal(parsed.checkboxes.length, 2, 'the checkboxes are still recorded, just not as stages');
  });

  test('a stage entry with no name still yields a stage instead of throwing', () => {
    const sm = new StageManager({ repo: null });
    const out = sm.inferCandidates({ specs: [{ path: 'SPEC.md', parsed: { stages: [{ index: 3 }, { index: 4, name: 'Ship' }] } }] });
    assert.deepEqual(out.map((s) => s.name), ['Stage 3', 'Ship']);
  });

  test('plan() survives a nameless stage end to end (the shape that killed full scans)', () => {
    const sm = new StageManager({ repo: null });
    const planned = sm.plan({
      specs: [{ path: 'README.md', parsed: { stages: [{ index: 1 }], headings: [] } }],
      tasks: [],
      acceptance: [],
    });
    assert.equal(planned.stages.length, 1);
    assert.equal(planned.stages[0].name, 'Stage 1');
  });
});
