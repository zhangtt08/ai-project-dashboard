/**
 * The Windows launcher must stay a Windows batch file.
 *
 * Why this is a test and not a code-review note: `启动.bat` shipped with two bash-isms
 * (`del /q "data\server-url.txt" >/dev/null 2>&1` and `timeout /t 1 /nobreak >/dev/null`).
 * cmd.exe does not understand `/dev/null` — it tries to open a file at the path `dev\null`
 * relative to the current directory, fails, and prints 「系统找不到指定的路径。」. The command
 * itself then never runs: measured in a temp copy of the real file, the stale
 * `data\server-url.txt` SURVIVED the line that was supposed to delete it, which is the shape
 * that makes the launcher open last run's URL instead of this run's.
 *
 * The assertion is on the artifact's bytes (a batch file's redirect target), not on intent,
 * so re-introducing a bash-ism in any other line of any other .bat fails here too.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function batchFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data' || entry.name.startsWith('.')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (/\.bat$/i.test(entry.name) || /\.cmd$/i.test(entry.name)) out.push(p);
    }
  };
  walk(ROOT);
  return out.sort();
}

/** A redirect whose target mentions `dev/null` — the only way a Unix sink leaks into cmd. */
const BASH_SINK = />>?\s*"?'?[\\/]?dev[\\/]/i;

describe('the Windows launcher is written in batch, not bash', () => {
  const files = batchFiles();

  test('the repo does have batch files to check', () => {
    assert.ok(files.length >= 1, `found none under ${ROOT}`);
    assert.ok(files.some((f) => path.basename(f) === '启动.bat'), '启动.bat must be present');
  });

  test('no batch line redirects to /dev/null; the NUL device is the only sink', () => {
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s*rem\b/i.test(line)) return;
        assert.equal(
          BASH_SINK.test(line), false,
          `${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1} sends output to a Unix path — cmd.exe will fail the whole command instead of discarding output. Use >nul (and 2>&1) . Line: ${line.trim()}`,
        );
      });
    }
  });

  test('the two lines that had the bash-ism now discard output through NUL', () => {
    const bat = fs.readFileSync(path.join(ROOT, '启动.bat'), 'utf8');
    assert.match(bat, /del \/q "data\\server-url\.txt" >nul 2>&1/, 'the stale-URL delete must discard its output via NUL');
    assert.match(bat, /timeout \/t 1 \/nobreak >nul/, 'the ready-poll must discard its output via NUL');
    // The wait loop must still exist and still be bounded: without the counter the launcher
    // polls forever after a failed start and the user sees a silent window.
    assert.match(bat, /:waiturl/, 'the ready-poll label');
    assert.match(bat, /if %tries% lss 40 goto waiturl/, 'the ready-poll must stay bounded at 40 attempts');
  });

  test('the fallback branch still refuses to touch a running instance', () => {
    // It starts its OWN server through `node src\server\cli.js start`, and cli.js walks the
    // port up when 8787 is taken. Killing whatever owns 8787 would be the user's live service.
    const bat = fs.readFileSync(path.join(ROOT, '启动.bat'), 'utf8');
    assert.doesNotMatch(bat, /taskkill/i, 'the launcher must never kill a process it did not start');
    assert.doesNotMatch(bat, /for \/f "tokens=5[^\n]*netstat/i, 'no port-to-PID lookup either — that is how a launcher starts killing strangers');
  });
});
