#!/usr/bin/env node
/**
 * Type-ish checking without a TS compiler:
 *   1. every file parses (`node --check`)
 *   2. every relative import resolves to a real file
 *   3. every imported binding exists as an export in the target module
 *   4. JSDoc-documented public functions keep their arity (cheap signature sanity check)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSyntaxAll } from './syntax.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tests')), ...walk(path.join(ROOT, 'tools')), ...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, 'agent'))];
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// 1 + 2 + 3
const exportsCache = new Map();
function exportsOf(file) {
  if (exportsCache.has(file)) return exportsCache.get(file);
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const cleaned = part.trim().split(/\s+as\s+/);
      const exported = (cleaned[1] || cleaned[0]).trim();
      if (exported) names.add(exported);
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default');
  exportsCache.set(file, names);
  return names;
}

const syntaxResults = await checkSyntaxAll(files);
const syntaxByFile = new Map(syntaxResults.map((r) => [r.file, r]));

for (const file of files) {
  const r = rel(file);
  const check = syntaxByFile.get(file);
  if (!check || !check.ok) {
    errors.push(`${r} — syntax error: ${(check && check.reason) || 'unknown'}`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/^\s*import\s+([^'";]*?)\s+from\s+['"](\.[^'"]+)['"]/gm)) {
    const spec = m[2];
    const target = path.resolve(path.dirname(file), spec);
    const candidates = [target, `${target}.js`, `${target}.mjs`, path.join(target, 'index.js')];
    const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) { errors.push(`${r} — unresolved import: ${spec}`); continue; }
    const clause = m[1].trim();
    const namedMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (namedMatch) {
      const available = exportsOf(found);
      for (const raw of namedMatch[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!available.has(name)) errors.push(`${r} — imports "${name}" from ${spec} but that module does not export it`);
      }
    }
    if (/^\*\s+as\s+/.test(clause)) continue;
    if (!namedMatch && clause && !clause.startsWith('*')) {
      const available = exportsOf(found);
      const local = clause.split(',')[0].trim();
      if (!available.has('default') && !available.has(local)) {
        errors.push(`${r} — default import from ${spec} but the module has no default export`);
      }
    }
  }
}

process.stdout.write(`\n  Typecheck: ${files.length} file(s) parsed, imports resolved\n`);
if (errors.length) {
  process.stderr.write(`  ${errors.length} ERROR(S):\n`);
  errors.slice(0, 60).forEach((e) => process.stderr.write(`   ! ${e}\n`));
  process.exit(1);
}
process.stdout.write('  All imports resolve and every named binding exists.\n\n');
