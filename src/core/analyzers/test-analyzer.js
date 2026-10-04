/**
 * TestAnalyzer — requirements #19 & #20.
 * Runs a test suite, parses the reporter output, and records both the run and its
 * individual failing cases. History is append-only: runs are never overwritten.
 */
import { RUN_STATUS, CONFIDENCE } from '../../domain/constants.js';
import { detectCommand } from '../build-detect.js';
import { parseTestOutput } from '../test-parser.js';
import { logger } from '../logger.js';
import { nowIso, summarizeOutput } from '../util.js';

const log = logger.child('test');

export class TestAnalyzer {
  constructor({ runner, testTimeoutMs = 900000 } = {}) {
    this.runner = runner;
    this.testTimeoutMs = testTimeoutMs;
  }

  /**
   * @param {{root:string, metadata:object}} project
   * @param {'unit'|'integration'|'e2e'} suite
   * @param {{signal?:AbortSignal}} [options] kills the test process when the job is cancelled
   */
  async runSuite(project, suite = 'unit', { signal = null } = {}) {
    const kind = suite === 'e2e' ? 'e2e' : suite === 'integration' ? 'integrationTest' : 'test';
    const detected = detectCommand(project.metadata, kind);
    const ts = nowIso();

    if (detected.unsupported) {
      log.info('unsupported', { suite, reason: detected.reason });
      return {
        suite,
        framework: 'unknown',
        command: '',
        status: RUN_STATUS.UNSUPPORTED,
        total: 0, passed: 0, failed: 0, skipped: 0,
        durationMs: 0, exitCode: null,
        parseConfidence: CONFIDENCE.UNKNOWN,
        unsupportedReason: detected.reason,
        cases: [],
        rawTail: '',
        ts,
      };
    }

    const res = await this.runner.run({
      command: detected.command,
      args: detected.args,
      cwd: project.root,
      timeoutMs: this.testTimeoutMs,
      purpose: `${suite} test suite`,
      signal,
    });

    const parsed = parseTestOutput(res.stdout, res.stderr, { exitCode: res.exitCode, suite });

    // Normalise: if the process failed but the reporter claimed 0 failures while some
    // tests did not pass, derive the failing count from the totals instead of lying.
    if (res.exitCode !== 0 && parsed.failed === 0 && parsed.total > parsed.passed) {
      parsed.failed = parsed.total - parsed.passed;
      parsed.summaryLine = parsed.summaryLine ? `${parsed.summaryLine} (derived failed=${parsed.failed})` : `derived failed=${parsed.failed}`;
    }

    let status;
    if (res.blocked) status = RUN_STATUS.UNKNOWN;
    else if (res.timedOut) status = RUN_STATUS.TIMEOUT;
    else if (res.executableMissing) status = RUN_STATUS.UNSUPPORTED;
    else if (res.exitCode === 0 && parsed.failed === 0 && parsed.total > 0) status = RUN_STATUS.PASS;
    else if (parsed.failed > 0 || (parsed.failures && parsed.failures.length > 0)) status = RUN_STATUS.FAIL;
    else if (res.exitCode !== 0 && parsed.total > 0) status = RUN_STATUS.FAIL;
    else if (res.exitCode !== 0) status = RUN_STATUS.ERROR;
    else status = RUN_STATUS.UNKNOWN;

    // Never claim a pass when the process failed and we could not parse anything.
    if (res.exitCode !== 0 && parsed.total === 0) status = RUN_STATUS.ERROR;
    if (res.exitCode !== 0 && status === RUN_STATUS.PASS) status = RUN_STATUS.FAIL;

    const cases = (parsed.failures || []).map((f) => ({
      name: f.name,
      file: f.file || '',
      status: 'failed',
      durationMs: 0,
      errorSummary: f.error || '',
      suite,
    }));

    log.info('result', {
      suite,
      framework: parsed.framework,
      status,
      total: parsed.total,
      passed: parsed.passed,
      failed: parsed.failed,
      exitCode: res.exitCode,
      note: parsed.parserNote || undefined,
    });

    return {
      suite,
      framework: parsed.framework,
      command: res.command,
      status,
      total: parsed.total,
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
      durationMs: parsed.durationMs || res.durationMs,
      commandDurationMs: res.durationMs,
      exitCode: res.exitCode,
      parseConfidence: parsed.confidence,
      parserNote: parsed.parserNote || '',
      summaryLine: parsed.summaryLine || '',
      timedOut: !!res.timedOut,
      blocked: !!res.blocked,
      cases,
      rawTail: summarizeOutput(res.stdout || res.stderr, 3000),
      ts,
    };
  }

  /** Convenience: unit + integration + e2e. Missing suites return `unsupported`, not failures. */
  async runAll(project, suites = ['unit', 'integration', 'e2e']) {
    const out = {};
    for (const s of suites) out[s] = await this.runSuite(project, s);
    return out;
  }
}

export function testRunToSnapshot(run) {
  if (!run) return { status: RUN_STATUS.UNKNOWN, total: 0, passed: 0, failed: 0, skipped: 0, framework: 'unknown', confidence: CONFIDENCE.UNKNOWN };
  return {
    status: run.status,
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    skipped: run.skipped,
    framework: run.framework,
    confidence: run.parseConfidence,
    command: run.command,
  };
}
