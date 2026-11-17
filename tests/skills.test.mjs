import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundledSkills, planSkillCopies, summarizeRows, applySkillCopies } from '../scripts/lib/skills.mjs';
import { rmrf } from '../scripts/lib/util.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgr-skills-'));
  t.after(() => rmrf(dir));
  return dir;
}

/** Build a fake xp-gate package dir with <name>/SKILL.md bundles. */
function fakePkg(t, names) {
  const pkg = tmpDir(t);
  for (const name of names) {
    fs.mkdirSync(path.join(pkg, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'skills', name, 'SKILL.md'), '# ' + name + '\n');
  }
  return pkg;
}

test('bundledSkills lists only directories that actually contain SKILL.md', (t) => {
  const pkg = fakePkg(t, ['alpha', 'beta']);
  // A directory without SKILL.md is not a skill; counting it would make every
  // agent look "missing" that entry forever.
  fs.mkdirSync(path.join(pkg, 'skills', 'notaskill'), { recursive: true });

  assert.deepEqual(bundledSkills(pkg), ['alpha', 'beta']);
});

test('bundledSkills returns [] for a missing package dir instead of throwing', () => {
  assert.deepEqual(bundledSkills(''), []);
  assert.deepEqual(bundledSkills('/no/such/pkg'), []);
  assert.deepEqual(bundledSkills(null), []);
});

test('planSkillCopies classifies each agent root as ok / drift / missing', (t) => {
  const pkg = fakePkg(t, ['alpha']);
  const okRoot = tmpDir(t);
  const driftRoot = tmpDir(t);
  const emptyRoot = tmpDir(t);

  fs.cpSync(path.join(pkg, 'skills', 'alpha'), path.join(okRoot, 'alpha'), { recursive: true });
  fs.cpSync(path.join(pkg, 'skills', 'alpha'), path.join(driftRoot, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(driftRoot, 'alpha', 'SKILL.md'), '# edited by user\n');

  const { names, rows } = planSkillCopies(pkg, [
    { agent: 'OK', dir: okRoot },
    { agent: 'Drift', dir: driftRoot },
    { agent: 'Empty', dir: emptyRoot },
  ]);

  assert.deepEqual(names, ['alpha']);
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent, r.state]));
  assert.equal(byAgent.OK, 'ok');
  assert.equal(byAgent.Drift, 'drift');
  assert.equal(byAgent.Empty, 'missing');
});

test('planSkillCopies is read-only', (t) => {
  const pkg = fakePkg(t, ['alpha']);
  const root = tmpDir(t);

  planSkillCopies(pkg, [{ agent: 'A', dir: root }]);

  // Planning must not create the destination; that is apply's job.
  assert.equal(fs.existsSync(path.join(root, 'alpha')), false);
});

test('summarizeRows tallies per-agent totals by state', () => {
  const summary = summarizeRows([
    { agent: 'A', state: 'ok' },
    { agent: 'A', state: 'drift' },
    { agent: 'B', state: 'missing' },
  ]);

  assert.deepEqual(summary.get('A'), { total: 2, ok: 1, drift: 1, missing: 0 });
  assert.deepEqual(summary.get('B'), { total: 1, ok: 0, drift: 0, missing: 1 });
});

test('summarizeRows returns an empty map for no rows', () => {
  assert.equal(summarizeRows([]).size, 0);
});

test('applySkillCopies with dryRun touches rows but writes nothing', (t) => {
  const pkg = fakePkg(t, ['alpha']);
  const root = tmpDir(t);
  const { rows } = planSkillCopies(pkg, [{ agent: 'A', dir: root }]);

  const touched = applySkillCopies(rows, { dryRun: true });

  assert.equal(touched.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'alpha')), false);
});

test('applySkillCopies backs up a drifted copy before overwriting it', (t) => {
  const pkg = fakePkg(t, ['alpha']);
  const root = tmpDir(t);
  const backupRoot = tmpDir(t);

  fs.cpSync(path.join(pkg, 'skills', 'alpha'), path.join(root, 'alpha'), { recursive: true });
  const userEdit = '# local changes I do not want to lose\n';
  fs.writeFileSync(path.join(root, 'alpha', 'SKILL.md'), userEdit);

  const { rows } = planSkillCopies(pkg, [{ agent: 'My Agent', dir: root }]);
  const touched = applySkillCopies(rows, { backupRoot });

  // The edit must survive in the backup even though the live copy is
  // overwritten -- this is the difference between "update" and "data loss".
  const backupDir = path.join(backupRoot, 'My-Agent', 'alpha');
  assert.equal(fs.readFileSync(path.join(backupDir, 'SKILL.md'), 'utf8'), userEdit);
  assert.match(fs.readFileSync(path.join(root, 'alpha', 'SKILL.md'), 'utf8'), /# alpha/);
  assert.equal(touched[0].applied, true);
});

test('applySkillCopies sanitises agent names used as backup path segments', (t) => {
  const pkg = fakePkg(t, ['alpha']);
  const root = tmpDir(t);
  const backupRoot = tmpDir(t);

  fs.cpSync(path.join(pkg, 'skills', 'alpha'), path.join(root, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'SKILL.md'), 'edited');

  // A slash or dot-dot in an agent label must not escape the backup root.
  const { rows } = planSkillCopies(pkg, [{ agent: '../../evil name!', dir: root }]);
  applySkillCopies(rows, { backupRoot });

  const entries = fs.readdirSync(backupRoot);
  assert.equal(entries.length, 1);
  assert.ok(!entries[0].includes('/'));
  assert.ok(!entries[0].includes('..'));
  assert.match(entries[0], /^[a-z0-9-]+$/i);
});

test('applySkillCopies leaves "ok" rows alone', (t) => {
  const pkg = fakePkg(t, ['alpha']);
  const root = tmpDir(t);
  fs.cpSync(path.join(pkg, 'skills', 'alpha'), path.join(root, 'alpha'), { recursive: true });

  const { rows } = planSkillCopies(pkg, [{ agent: 'A', dir: root }]);
  const touched = applySkillCopies(rows, { backupRoot: tmpDir(t) });

  assert.deepEqual(touched, []);
});
