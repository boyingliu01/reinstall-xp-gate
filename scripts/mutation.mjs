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

import { parseFailCount } from './lib/testreport.mjs';

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
    from: '    return XP_GATE_MARKER.test(fs.readFileSync(abs, \'utf8\'));',
    to: '    return true;',
    breaks: 'any directory looks like ours, so unrelated user dirs get deleted',
  },
  {
    name: 'backupThenRemove skips the backup',
    file: 'scripts/lib/residue.mjs',
    from: '  else fs.cpSync(abs, dest, { recursive: true, force: true });',
    to: '  else fs.mkdirSync(dest, { recursive: true });',
    breaks: 'the original is deleted with no copy kept -- unrecoverable data loss',
  },
  {
    name: 'scanSkillResidue treats every copy as identical',
    file: 'scripts/lib/residue.mjs',
    from: '    same: hashFn(dir) === oldHashes.get(entry.name),',
    to: '    same: true,',
    breaks: "user-edited skills are queued for deletion",
  },
  {
    name: 'classifyCopy hashes skills the user wrote',
    file: 'scripts/lib/residue.mjs',
    from: '  if (!entry.isDirectory() || !oldHashes.has(entry.name)) return null;',
    to: '  if (!entry.isDirectory()) return null;\n  if (!oldHashes.has(entry.name)) return { same: false, row: {} };',
    breaks: 'a user skill absent from the old package is reported as residue of ours',
  },
  {
    name: 'pruneDeadRoots drops the hash comparison',
    file: 'scripts/lib/residue.mjs',
    from: '  return isDir(dest) && hashFn(dest) === expected;',
    to: '  return isDir(dest);',
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
    name: 'cmpVersion compares the first component only',
    file: 'scripts/lib/tools.mjs',
    from: '    const delta = (pa[i] || 0) - (pb[i] || 0);\n    if (delta !== 0) return Math.sign(delta);',
    to: '    const delta = (pa[i] || 0) - (pb[i] || 0);\n    if (i > 0) return 0;\n    if (delta !== 0) return Math.sign(delta);',
    breaks: '1.0.1 vs 1.0.0 compares equal, so a patch upgrade never fires',
  },
  {
    name: 'cmpVersion compares versions as strings',
    file: 'scripts/lib/tools.mjs',
    from: '    const delta = (pa[i] || 0) - (pb[i] || 0);',
    to: '    const delta = pa[i] === pb[i] ? 0 : String(pa[i]).localeCompare(String(pb[i]));',
    breaks: '"1.10" ranks below "1.9", so the upgrade never fires for double-digit minors',
  },
  {
    name: 'parseLizardCsv reads NLOC as the complexity',
    file: 'scripts/lib/ccn.mjs',
    from: '    ccn: Number(cells[1]),',
    to: '    ccn: Number(cells[0]),',
    breaks: 'a 13-line flat helper outranks a genuinely branchy function',
  },
  {
    name: 'parseLizardCsv reads the token count as the complexity',
    file: 'scripts/lib/ccn.mjs',
    from: '    ccn: Number(cells[1]),',
    to: '    ccn: Number(cells[2]),',
    breaks: 'xp-gate#732 repeated: arithmetic-heavy code looks complex, branchy code passes',
  },
  {
    name: 'parseLizardCsv drops rows on a comma-bearing signature',
    file: 'scripts/lib/ccn.mjs',
    from: '  const cells = splitCsvLine(line);',
    to: "  const cells = line.split(',');",
    breaks: 'violations get detached from their file, or the row is dropped entirely',
  },
  {
    name: 'ccnViolations lets the threshold case through as a violation',
    file: 'scripts/lib/ccn.mjs',
    from: '  return rows.filter((r) => r.ccn > threshold);',
    to: '  return rows.filter((r) => r.ccn >= threshold);',
    breaks: 'every function sitting exactly on the limit is reported as debt',
  },
  {
    name: 'verdictOf reads a clean Gate 2 run as broken',
    file: 'scripts/lib/verdict.mjs',
    from: "  if (/Found 0 clones/i.test(text)) return 'passed';",
    to: '',
    breaks: 'the audit reports a failure on a clean tree and is ignored from then on',
  },
  {
    name: 'summarize ignores the invalid-control state',
    file: 'scripts/lib/gatecheck.mjs',
    from: '    pass: invalid.length === 0 && judged.every((r) => r.ok),',
    to: '    pass: judged.every((r) => r.ok),',
    breaks: 'an audit that measured nothing still reports a pass',
  },
  {
    name: 'pruneBackups caps the whole directory instead of each agent',
    file: 'scripts/lib/util.mjs',
    from: '  const doomed = [...groupByLabel(root).values()].flatMap((names) => names.slice(keep));',
    to: '  const doomed = stampedNames(root).slice(keep);',
    breaks: 'one install run backs up all 9 agents at once, so 6 are deleted instantly and cannot be rolled back',
  },
  {
    name: 'pruneBackups keeps the oldest stamps',
    file: 'scripts/lib/util.mjs',
    from: 'names.sort((a, b) => STAMP_TAIL(b).localeCompare(STAMP_TAIL(a)))',
    to: 'names.sort((a, b) => STAMP_TAIL(a).localeCompare(STAMP_TAIL(b)))',
    breaks: 'the most recent install is discarded and the stale copies survive',
  },
  {
    name: 'stampedNames accepts any directory',
    file: 'scripts/lib/util.mjs',
    from: "    .filter((d) => d.isDirectory() && STAMPED.test(d.name))",
    to: "    .filter((d) => d.isDirectory())",
    breaks: "an operator's own directory under the backup root is deleted without warning",
  },
];

function runSuite() {
  // No `shell: true`: under a shell `process.execPath` is
  // "C:\Program Files\nodejs\node.exe" and the space splits the command, so
  // every mutation would report SURVIVED because the suite never ran.
  //
  // The files are enumerated here rather than passed as 'tests/*.test.mjs'.
  // Node's test runner expands a glob on Windows but NOT on Linux -- CI caught
  // this as "Could not find '.../tests/*.test.mjs'". Listing the files removes
  // the dependency on who does the expanding.
  const files = fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join('tests', f));
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // -1 signals "could not read a count" (see lib/testreport.mjs). Treating that
  // as 0 would report a crashed runner as a surviving mutation; treating it as
  // >0 would report every mutation as killed. Neither is true, so the caller
  // records a distinct ERROR outcome.
  return { failed: parseFailCount(out), out, status: r.status };
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
