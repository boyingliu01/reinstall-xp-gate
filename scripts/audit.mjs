#!/usr/bin/env node
/**
 * Standalone gate audit: answer "are the gates still effective right now"
 * without reinstalling anything.
 *
 * `reinstall.mjs` was previously the only entry point, which meant the only way
 * to ask whether the gates still block was to tear down and rebuild the
 * installation. Those are different questions and should not share a command.
 *
 * Two layers, reported separately:
 *   1. Static parity -- are the skills/plugins/hooks on disk the right ones
 *      (delegated to verify.mjs, unchanged)
 *   2. Gray box -- do the gates actually reject a planted defect
 *      (lib/gatecheck.mjs; this is the part verify.mjs never had)
 *
 * Exit 1 if either layer fails, so it is usable as CI.
 *
 * Usage:
 *   node scripts/audit.mjs             # both layers
 *   node scripts/audit.mjs --static    # parity only, no gate execution
 *   node scripts/audit.mjs --gates     # gray box only
 *   node scripts/audit.mjs --json
 */
import { auditGates } from './lib/gatecheck.mjs';
import { item, section, table, MARK } from './lib/report.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

if (has('--help') || has('-h')) {
  console.log(`Usage: node scripts/audit.mjs [--static] [--gates] [--json]

  --static   Only check on-disk parity (skills, plugins, hooks)
  --gates    Only check that gates block planted defects
  --json     Machine-readable output

Exit code 1 if any check fails.`);
  process.exit(0);
}

const wantStatic = !has('--gates');
const wantGates = !has('--static');

async function runStatic() {
  // verify.mjs already knows how to compare the installed tree; reuse it via
  // its --json mode rather than duplicating the parity logic here.
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, [path.join(here, 'verify.mjs'), '--quick', '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const raw = String(r.stdout || '');
  const start = raw.indexOf('{');
  if (start < 0) return { ok: false, checks: [], error: (r.stderr || raw).slice(0, 300) };
  try {
    return JSON.parse(raw.slice(start));
  } catch (error) {
    return { ok: false, checks: [], error: `verify.mjs output not parseable: ${error.message}` };
  }
}

const result = { ok: true, static: null, gates: null };

if (wantStatic) {
  result.static = await runStatic();
  if (!result.static.ok) result.ok = false;
}

if (wantGates) {
  const audit = await auditGates();
  result.gates = audit;
  if (!audit.summary.pass) result.ok = false;
}

if (has('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (result.static) {
  section('Layer 1 — on-disk parity');
  if (result.static.error) {
    item(MARK.FAIL, `verify.mjs did not produce results: ${result.static.error}`);
  } else {
    for (const c of result.static.checks) {
      const mark = c.status === 'FAIL' ? MARK.FAIL : c.status === 'WARN' ? MARK.WARN : c.status === 'SKIP' ? MARK.SKIP : MARK.PASS;
      item(mark, `${c.name}: ${c.detail}`);
    }
  }
}

if (result.gates) {
  section('Layer 2 — do the gates actually block');
  console.log('  Each case runs twice: a clean tree (control) and the same tree with');
  console.log('  a defect planted. A gate is trustworthy only if it separates them.\n');
  table(
    ['Gate', 'Clean', 'Planted', 'Verdict'],
    result.gates.cases.map((c) => [
      String(c.id),
      c.cleanVerdict,
      c.dirtyVerdict,
      c.knownGap ? 'KNOWN GAP' : c.ok ? 'ok' : 'FAILED',
    ]),
  );
  const s = result.gates.summary;
  console.log('');
  if (s.failed) item(MARK.FAIL, `${s.failed}/${s.total} gate case(s) did not block a planted defect`);
  else item(MARK.PASS, `${s.ok}/${s.total} gate case(s) blocked the planted defect and passed the control`);
  if (s.knownGaps) item(MARK.WARN, `${s.knownGaps} case(s) are known upstream gaps, reported but not counted`);
}

console.log('');
item(result.ok ? MARK.PASS : MARK.FAIL, result.ok ? 'audit passed' : 'audit FAILED');
process.exit(result.ok ? 0 : 1);
