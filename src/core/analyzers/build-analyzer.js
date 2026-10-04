/**
 * BuildAnalyzer — requirement #18.
 * Runs the detected command through CommandRunner and records a truthful result.
 * Supported statuses: pass | fail | timeout | unsupported | unknown.
 */
import { BUILD_STATUS, RUN_STATUS } from '../../domain/constants.js';
import { detectCommand } from '../build-detect.js';
import { logger } from '../logger.js';
import { nowIso, summarizeOutput } from '../util.js';

const log = logger.child('build');

export class BuildAnalyzer {
  constructor({ runner, buildTimeoutMs = 600000 } = {}) {
    this.runner = runner;
    this.buildTimeoutMs = buildTimeoutMs;
  }

  /**
   * @param {{root:string, metadata:object}} project
   * @param {string} kind build | lint | typecheck
   * @param {{signal?:AbortSignal}} [options] aborts the child process when the job is cancelled
   */
  async run(project, kind = 'build', { signal = null } = {}) {
    const detected = detectCommand(project.metadata, kind);
    const ts = nowIso();

    if (detected.unsupported) {
      log.info('unsupported', { kind, reason: detected.reason });
      return {
        kind,
        command: '',
        status: BUILD_STATUS.UNSUPPORTED,
        exitCode: null,
        durationMs: 0,
        stdoutSummary: '',
        stderrSummary: '',
        truncated: false,
        unsupportedReason: detected.reason,
        ts,
      };
    }

    const res = await this.runner.run({
      command: detected.command,
      args: detected.args,
      cwd: project.root,
      timeoutMs: this.buildTimeoutMs,
      purpose: `${kind} command for project`,
      signal,
    });

    let status = BUILD_STATUS.UNKNOWN;
    if (res.blocked) status = BUILD_STATUS.UNKNOWN;
    else if (res.timedOut) status = BUILD_STATUS.TIMEOUT;
    else if (res.cancelled) status = BUILD_STATUS.UNKNOWN;
    else if (res.executableMissing) status = BUILD_STATUS.UNSUPPORTED;
    else if (res.exitCode === 0) status = BUILD_STATUS.PASS;
    else if (typeof res.exitCode === 'number' && res.exitCode > 0) status = BUILD_STATUS.FAIL;

    log.info('result', { kind, status, exitCode: res.exitCode, durationMs: res.durationMs });

    return {
      kind,
      command: res.command,
      status,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      cancelled: !!res.cancelled,
      stdoutSummary: summarizeOutput(res.stdout, 1600),
      stderrSummary: summarizeOutput(res.stderr, 2400),
      truncated: !!res.truncated,
      timedOut: !!res.timedOut,
      blocked: !!res.blocked,
      blockReason: res.blockReason || '',
      unsupportedReason: res.executableMissing ? `executable not found: ${detected.command}` : '',
      ts,
      source: detected.source,
    };
  }
}

export function toRunStatus(buildStatus) {
  switch (buildStatus) {
    case BUILD_STATUS.PASS: return RUN_STATUS.PASS;
    case BUILD_STATUS.FAIL: return RUN_STATUS.FAIL;
    case BUILD_STATUS.TIMEOUT: return RUN_STATUS.TIMEOUT;
    case BUILD_STATUS.UNSUPPORTED: return RUN_STATUS.UNSUPPORTED;
    default: return RUN_STATUS.UNKNOWN;
  }
}
