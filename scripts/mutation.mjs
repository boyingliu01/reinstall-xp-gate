#!/usr/bin/env node
/**
 * Mutation runner: inject a known defect into production code, run the suite,
 * and require it to fail. Restores the original file afterwards, always.
 *
 * WHY THIS EXISTS
 * ---------------
 * A green suite proves the tests agree with the code, not that the tests would
 * notice if the code were wrong. The distinction is not academic here: the
 * first version of `pruneDeadRoots removes only copies identical to the
 * published package` passed whether or not the hash comparison existed, because
 * its edited copy was named something the loop never visited. 84/84 green,
 * silent data-loss bug unguarded.
 *
 * Every mutation below corresponds to a real safety property of this skill:
 * deleting the wrong directory, overwriting a user's edit, or reporting an
 * outdated tool as current. If a mutation survives, the property is untested.
 *
 * Usage:
 *   node scripts/mutation.mjs            # run all, report survivors
 *   node scripts/mutation.mjs --verbose  # show the failing test names
 *
 * Exit 1 if any mutation survives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');

/**
 * Each mutation: file, an exact substring to replace, its replacement, and the
 * behaviour that breaking it should cost.
 */
const MUTATIONS = [
  {
    name: 'hashTree ignores filenames',
    file: 'scripts/lib/util.mjs',
    from: "    h.update(rel);\n    h.update('\\0');",
    to: "    h.update('\\0');",
    breaks: 'a renamed file hashes the same as the original, so drift is invisible',
  },
  {
    name: 'hasXpGateMarker always true',
    file: 'scripts/lib/residue.mjs',
    from: "      if (/xp-gate/i.test(fs.readFileSync(path.join(dir, rel), 'utf8'))) return true;",
    to: '      return true;',
    breaks: 'any directory looks like ours, so unrelated user dirs get deleted',
  },
  {
    name: 'backupThenRemove skips the backup',
    file: 'scripts/lib/residue.mjs',
    from: '    fs.cpSync(abs, dest, { recursive: true, force: true });',
    to: '    fs.mkdirSync(dest, { recursive: true });',
    breaks: 'the original is deleted with no copy kept -- unrecoverable data loss',
  },
  {
    name: 'scanSkillResidue treats every copy as identical',
    file: 'scripts/lib/residue.mjs',
    from: '      const bucket = hashFn(dest) === oldHash ? identical : modified;',
    to: '      const bucket = identical;',
    breaks: "user-edited skills are queued for deletion",
  },
  {
    name: 'pruneDeadRoots drops the hash comparison',
    file: 'scripts/lib/residue.mjs',
    from: '      if (isDir(dest) && hashFn(dest) === expected) {',
    to: '      if (isDir(dest)) {',
    breaks: 'every copy is deleted, including ones the user edited',
  },
  {
    name: 'sameTree compares existence instead of content',
    file: 'scripts/lib/util.mjs',
    from: '  return hashTree(a) === hashTree(b);',
    to: '  return true;',
    breaks: 'drifted skill copies report as up to date',
  },
  {
    name: 'copyTree leaves stale files behind',
    file: 'scripts/lib/util.mjs',
    from: '  rmrf(dest);',
    to: '  ;',
    breaks: 'files removed from the package survive in every agent copy forever',
  },
  {
    name: 'cmpVersion compares lexically',
    file: 'scripts/lib/tools.mjs',
    from: '    if (x > y) return 1;\n    if (x < y) return -1;',
    to: '    if (String(x) > String(y)) return 1;\n    if (String(x) < String(y)) return -1;',
    breaks: '1.10 ranks below 1.9, so the upgrade never fires',
  },
];

function runSuite() {
  // No `shell: true` here. Under a shell, `process.execPath` is
  // "C:\Program Files\nodejs\node.exe" and the space splits the command --
  // every mutation then "survives" because the suite never actually ran. The
  // glob is expanded by Node's own test runner, not by a shell, so passing it
  // through unquoted is correct and works the same on Windows and POSIX.
  const r = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failMatch = out.match(/\u2139 fail (\d+)/);
  // -1 signals "could not read a count". Treating that as 0 would report a
  // crashed runner as a surviving mutation; treating it as >0 would report
  // every mutation as killed. Neither is true, so it is a distinct outcome.
  return { failed: failMatch ? Number(failMatch[1]) : -1, out, status: r.status };
}

const results = [];

for (const m of MUTATIONS) {
  const abs = path.join(root, m.file);
  const original = fs.readFileSync(abs, 'utf8');

  if (!original.includes(m.from)) {
    results.push({ ...m, outcome: 'SKIPPED', detail: 'anchor not found -- mutation is stale' });
    continue;
  }

  try {
    fs.writeFileSync(abs, original.replace(m.from, m.to), 'utf8');
    const { failed, out, status } = runSuite();
    if (failed < 0) {
      // The suite could not even report a count: the runner is broken, not the
      // mutation. Reporting SURVIVED here would send the next person hunting
      // for a missing test instead of a broken invocation.
      results.push({ ...m, outcome: 'ERROR', detail: `no test count in output (exit ${status})` });
      continue;
    }
    const killed = failed > 0;
    const names = killed && verbose
      ? [...out.matchAll(/^\u2716 (.+?) \(\d/gm)].map((x) => x[1]).slice(0, 3)
      : [];
    results.push({ ...m, outcome: killed ? 'KILLED' : 'SURVIVED', failed, names });
  } finally {
    // Unconditional: a surviving mutation left in place would poison every
    // later run and any commit made in between.
    fs.writeFileSync(abs, original, 'utf8');
  }
}

const killed = results.filter((r) => r.outcome === 'KILLED').length;
const survived = results.filter((r) => r.outcome === 'SURVIVED');
const skipped = results.filter((r) => r.outcome === 'SKIPPED');
const errored = results.filter((r) => r.outcome === 'ERROR');

console.log('\nMutation report\n');
for (const r of results) {
  const mark = { KILLED: 'kill', SURVIVED: 'MISS', SKIPPED: 'skip', ERROR: 'ERR ' }[r.outcome];
  console.log(`  [${mark}] ${r.name}`);
  if (r.outcome === 'SURVIVED') console.log(`         breaks: ${r.breaks}`);
  if (r.outcome === 'SKIPPED') console.log(`         ${r.detail}: ${r.file}`);
  if (r.outcome === 'ERROR') console.log(`         runner problem, not a test gap: ${r.detail}`);
  if (verbose && r.names && r.names.length) console.log(`         caught by: ${r.names.join('; ')}`);
}

console.log(`\n  ${killed}/${MUTATIONS.length} mutations killed`);
if (skipped.length) console.log(`  ${skipped.length} skipped (stale anchor -- update the mutation)`);
if (errored.length) {
  console.log(`\n  ${errored.length} mutation(s) could not be evaluated: the runner failed, not the tests.`);
  process.exit(1);
}
if (survived.length) {
  console.log(`\n  ${survived.length} mutation(s) SURVIVED: the suite does not cover these properties.`);
  process.exit(1);
}
console.log('  every mutated defect was caught\n');
process.exit(0);
