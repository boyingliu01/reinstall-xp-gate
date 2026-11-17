import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from './proc.mjs';
import { rmrf } from './util.mjs';

/**
 * Gray-box gate verification: prove the gates actually block, not just that
 * they exit 0 on a clean tree.
 *
 * WHY THIS EXISTS
 * ---------------
 * `verify.mjs` up to 1.1.1 contained zero `run()` / `spawnSync` calls: every
 * check read a file and compared a hash. So the skill could report "12 skills
 * x 5 agents, all consistent" on a machine whose gates had silently stopped
 * inspecting anything. That is not hypothetical -- upstream xp-gate#732 makes
 * Gate 3/4 report PASS/SKIP for every `.mjs` file while checking none of them.
 *
 * File parity and gate effectiveness are different claims, and the second one
 * cannot be established by reading files. This module establishes it by
 * building a throwaway git repo, planting a defect the gate is responsible for
 * catching, and requiring the gate to say so. If the gate passes a dirty tree,
 * the gate is broken -- which is exactly what no amount of hash comparison in
 * verify.mjs would ever reveal.
 *
 * DESIGN NOTES
 * ------------
 * - Every case carries a `control`: the same gate on the same tree WITHOUT the
 *   planted defect. Without it, a gate that blocks everything (or is broken in
 *   the other direction) would score as perfect. Recall alone is not a verdict.
 * - The repo is created under os.tmpdir() and removed afterwards. A case that
 *   throws still cleans up via the caller's finally.
 * - Gates run through the real CLI (`xp-gate check <id>`), not by importing
 *   gate internals. The point is to test the artifact the user actually has.
 */

/**
 * The defect planted for the Gate 8 case.
 *
 * The tokens are assembled at runtime rather than written as literals. They
 * have to LOOK real enough for gitleaks to flag them when this file is copied
 * into a fixture repo, but a literal here would be found by gitleaks in THIS
 * repository too -- and then every commit trips Gate 8 on our own test data,
 * which is how a real leak eventually gets waved through as "just the fixture
 * again". Concatenation keeps the scan target real and this file clean.
 */
export const SECRET_FIXTURE = [
  '// planted by xp-gate-reinstall audit -- do not copy into real code',
  `const awsKey = "AKIA${'QWERTYUIOPASDFGH'}";`,
  `const ghToken = "ghp_${'16C7e42F292c6912E7710c838347Ae178B4a'}";`,
  'module.exports = { awsKey, ghToken };',
].join('\n');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgr-gate-'));
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['config', 'user.email', 'audit@localhost'], { cwd: dir });
  run('git', ['config', 'user.name', 'audit'], { cwd: dir });
  // A commit is a cheap way to make the tree look like a project; gates that
  // read the index rather than the working tree need it.
  return dir;
}

function stageAll(dir) {
  run('git', ['add', '-A'], { cwd: dir });
}

/**
 * Resolve the xp-gate launcher for spawnSync.
 *
 * On Windows the global bin is a `.cmd` shim and spawnSync('xp-gate') fails
 * with ENOENT -- it does not apply PATHEXT the way a shell does. Routing
 * through `cmd.exe /d /c` is how the rest of this skill already handles that.
 * The arguments are a fixed internal list (`check <number>`), never user input,
 * so there is no concatenation risk despite what semgrep's
 * detect-child-process rule assumes.
 */
function launcher() {
  return process.platform === 'win32' ? 'xp-gate.cmd' : 'xp-gate';
}

/**
 * Run one gate by id in `dir`; returns { status, output }.
 */
function gateRun(dir, gateId) {
  const cmd = launcher();
  const args = ['check', String(gateId)];
  // run() spawns with envWithPath(), which is how xp-gate resolves from Git
  // Bash where global npm bins are absent from the Windows PATH.
  const r = process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/c', cmd, ...args], { cwd: dir, timeout: 180000 })
    : run(cmd, args, { cwd: dir, timeout: 180000 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  return { status: r.status, output };
}

/**
 * Interpret a gate run. xp-gate prints markers rather than emitting JSON on
 * `check`, so this parses the same text a human would read.
 *
 * `detected` is a separate verdict from `blocked` because the gates are not
 * uniform about severity: Gate 8 exits 1 on a secret, while Gate 2 reports
 * "Found N clones" and still exits 0. Collapsing those into one verdict would
 * either call Gate 2 broken or call a non-blocking gate a blocker. A case says
 * which one it expects.
 *
 * @returns {'blocked'|'detected'|'passed'|'skipped'|'unknown'}
 */
export function verdictOf(output) {
  if (/⏭️|SKIPPED/i.test(output)) return 'skipped';
  // FAILED must be a standalone token, not a substring. A path like
  // ./failed-tests.js or a rule id containing "failed" would otherwise turn a
  // clean run into a false alarm -- and a false alarm is how an audit stops
  // being read at all.
  if (/❌|BLOCKED|\bFAILED\b/.test(output)) return 'blocked';
  // "Found 0 clones." is a clean pass, but Gate 2 prints no ✅ marker at all,
  // so a marker-only parser reports 'unknown' for a perfectly good run -- and a
  // case that "cannot be read" is indistinguishable from one that broke.
  if (/Found 0 clones/i.test(output)) return 'passed';
  // "Found 1 clones." / "Clone found" -- the gate saw duplication but does not
  // fail the build for it (measured: exit 0 with and without clones).
  if (/Found \d+ clones?\.|Clone found/i.test(output)) return 'detected';
  if (/✅|PASSED/i.test(output)) return 'passed';
  return 'unknown';
}

/**
 * The planted-defect cases.
 *
 * `expect: 'blocked'` means the gate must reject the dirty tree. Cases where
 * the gate legitimately cannot see the defect (the `.mjs` gap) are recorded
 * with `knownGap: true` and reported separately -- counting them as failures
 * would make the audit permanently red for a bug this repo cannot fix, and
 * counting them as passes would hide a real hole. They are reported as-is.
 */
export const CASES = [
  {
    id: 8,
    name: 'Gate 8 blocks a planted AWS key + GitHub token',
    plant: (dir) => {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'leaked.js'), SECRET_FIXTURE);
    },
    expect: 'blocked',
  },
  {
    id: 3,
    name: 'Gate 3 blocks a function above the CCN threshold',
    plant: (dir) => {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // Ten mutually exclusive branches: CCN 11, above the default block
      // threshold of 10. Written as plain JS so Gate 1 would accept it too.
      const branches = Array.from({ length: 10 }, (_, i) => `  if (n === ${i}) return ${i};`).join('\n');
      fs.writeFileSync(
        path.join(dir, 'src', 'complex.js'),
        `function tangled(n) {\n${branches}\n  return -1;\n}\nmodule.exports = { tangled };\n`,
      );
    },
    expect: 'blocked',
    // .js is in Gate 3's extension regex, so this case is not affected by
    // xp-gate#732. A pass here therefore proves the harness works even if the
    // .mjs case below is red.
  },
  {
    id: 2,
    name: 'Gate 2 detects a duplicated block (advisory: reports, does not block)',
    plant: (dir) => {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      // Two files with an identical 21-line body: above jscpd's default
      // min-tokens, so it is a genuine clone rather than boilerplate.
      const body = Array.from({ length: 20 }, (_, i) =>
        `function part${i}(x) { return x * ${i} + ${i}; }`).join('\n');
      fs.writeFileSync(path.join(dir, 'src', 'a.js'), `${body}\nmodule.exports = 1;\n`);
      fs.writeFileSync(path.join(dir, 'src', 'b.js'), `${body}\nmodule.exports = 2;\n`);
    },
    // Measured: `xp-gate check 2` exits 0 both with and without clones. Duplicate
    // code is reported, never enforced, so 'blocked' would be a false expectation
    // that could only ever be "fixed" by changing the gate's severity policy.
    expect: 'detected',
  },
];

/**
 * Run every case twice -- once clean (control), once with the defect planted.
 * @returns {Promise<{cases: object[], summary: object}>}
 */
export async function auditGates({ cases = CASES } = {}) {
  const results = [];

  for (const tc of cases) {
    const cleanDir = tmpRepo();
    const dirtyDir = tmpRepo();
    try {
      // Control: bare repo with one innocuous file. If the gate blocks here,
      // its "blocked" verdict on the dirty tree proves nothing.
      for (const dir of [cleanDir, dirtyDir]) {
        fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
      }
      tc.plant(dirtyDir);
      stageAll(cleanDir);
      stageAll(dirtyDir);

      const clean = gateRun(cleanDir, tc.id);
      const dirty = gateRun(dirtyDir, tc.id);

      results.push({
        id: tc.id,
        name: tc.name,
        cleanVerdict: verdictOf(clean.output),
        dirtyVerdict: verdictOf(dirty.output),
        knownGap: Boolean(tc.knownGap),
        expected: tc.expect,
        // The gate is only trustworthy if it separates the two trees.
        ok: verdictOf(dirty.output) === tc.expect && verdictOf(clean.output) !== 'blocked',
      });
    } catch (error) {
      results.push({
        id: tc.id,
        name: tc.name,
        cleanVerdict: 'unknown',
        dirtyVerdict: 'unknown',
        knownGap: Boolean(tc.knownGap),
        expected: tc.expect,
        ok: false,
        error: String(error && error.message ? error.message : error),
      });
    } finally {
      rmrf(cleanDir);
      rmrf(dirtyDir);
    }
  }

  const effective = results.filter((r) => !r.knownGap);
  return {
    cases: results,
    summary: {
      total: results.length,
      ok: effective.filter((r) => r.ok).length,
      failed: effective.filter((r) => !r.ok).length,
      knownGaps: results.filter((r) => r.knownGap).length,
      // The audit passes only when every non-gap case separates clean from dirty.
      pass: effective.every((r) => r.ok),
    },
  };
}
