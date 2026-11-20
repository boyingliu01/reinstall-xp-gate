#!/usr/bin/env node
/**
 * Write `coverage/coverage-summary.json` from Node's built-in coverage report.
 *
 * WHY THIS EXISTS
 * ---------------
 * xp-gate's Gate 5 refuses a JavaScript commit with
 * "coverage/coverage-summary.json not found", because it expects the istanbul
 * shape that vitest and jest emit. This repo deliberately has no test framework
 * (`node:test` is built in, zero dependencies), so nothing ever produced that
 * file and the gate blocked every commit on an artefact the project could never
 * generate.
 *
 * The options were to add vitest purely to satisfy a file-shape expectation, or
 * to translate what Node already measures. Node 24's `--experimental-test-coverage`
 * prints real per-file line/branch/function percentages, so the measurement is
 * not the problem -- only its format is. Translating is the honest choice: it
 * keeps the zero-dependency property and gives the gate an actual number instead
 * of a hand-written constant.
 *
 * The thresholds below are the gate's own (80% lines). Failing here is the point:
 * if coverage drops, the commit should not claim otherwise.
 *
 * Usage:
 *   node scripts/coverage.mjs            # write the summary, exit 1 below floor
 *   node scripts/coverage.mjs --json     # machine-readable
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINE_FLOOR = 80;

/** `[[...]]`-free parse: keep only lines that look like `name.mjs | 12.3 | ...`. */
function reportLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\u2139\s]+/, '').trim())
    .filter((line) => line.includes('|') && /\.mjs\b/.test(line));
}

/** One `file | line% | branch% | funcs% | ...` row, or null if it is a header. */
function fileRow(line) {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length < 4) return null;
  const [file, lines, branches, funcs] = cells;
  if (!Number.isFinite(Number(lines))) return null;
  return { file: file.trim(), lines: Number(lines), branches: Number(branches), funcs: Number(funcs) };
}

/** istanbul's per-file shape; Gate 5 reads `lines.pct` and nothing else. */
function istanbulEntry(row) {
  return {
    lines: { pct: row.lines },
    branches: { pct: row.branches },
    functions: { pct: row.funcs },
    statements: { pct: row.lines },
  };
}

function collect() {
  const files = fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join('tests', f));
  const r = spawnSync(process.execPath, ['--experimental-test-coverage', '--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const rows = reportLines(out).map(fileRow).filter(Boolean);
  return { rows, exitCode: r.status, peak: out };
}

const { rows, exitCode, peak } = collect();
if (rows.length === 0) {
  // Zero rows is a broken measurement, not full coverage. Saying so is the whole
  // lesson of scripts/hp-gate.mjs, where an empty parse read as a clean pass.
  console.error('coverage: node produced no per-file rows -- cannot report a percentage');
  console.error(peak.split(/\r?\n/).slice(-15).join('\n'));
  process.exit(1);
}

// Relative paths only: an absolute one buries the machine's temp directory in a
// committed artefact, and the gate reads `total` anyway.
const summary = { total: {}, ...Object.fromEntries(rows.map((r) => [r.file, istanbulEntry(r)])) };
const worst = rows.reduce((a, b) => (a.lines <= b.lines ? a : b));
summary.total = istanbulEntry({
  lines: Number((rows.reduce((s, r) => s + r.lines, 0) / rows.length).toFixed(2)),
  branches: Number((rows.reduce((s, r) => s + r.branches, 0) / rows.length).toFixed(2)),
  funcs: Number((rows.reduce((s, r) => s + r.funcs, 0) / rows.length).toFixed(2)),
});

fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
fs.writeFileSync(path.join(root, 'coverage', 'coverage-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: summary.total.lines.pct, worst, files: rows.length }, null, 2));
} else {
  console.log(`coverage: ${rows.length} files, lines ${summary.total.lines.pct}%`
    + ` (floor ${LINE_FLOOR}%), worst ${worst.file} at ${worst.lines}%`);
}

// The test run itself failing must fail this step too; the coverage gate is not
// a substitute for the suite.
const broken = exitCode !== 0 || summary.total.lines.pct < LINE_FLOOR;
process.exit(broken ? 1 : 0);
