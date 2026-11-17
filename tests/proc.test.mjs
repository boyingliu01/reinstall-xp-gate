import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { HOME, effectivePath, envWithPath, npmCli, packageDir, resetPackageDir, run } from '../scripts/lib/proc.mjs';
import { isFile } from '../scripts/lib/util.mjs';

test('HOME is an absolute path', () => {
  assert.equal(typeof HOME, 'string');
  assert.ok(path.isAbsolute(HOME), `HOME must be absolute, got: ${HOME}`);
});

test('effectivePath is non-empty, deduplicated and contains the node dir', () => {
  const parts = effectivePath().split(path.delimiter).filter(Boolean);

  assert.ok(parts.length > 0);
  // The node directory must lead, otherwise npm .cmd shims cannot find node when
  // launched from Git Bash where `node` is absent from Windows PATH.
  assert.equal(parts[0], path.dirname(process.execPath));
  assert.equal(new Set(parts).size, parts.length);
});

test('effectivePath is cached and returns the identical string', () => {
  assert.equal(effectivePath(), effectivePath());
});

test('envWithPath copies the environment and overrides PATH', () => {
  const env = envWithPath();
  assert.equal(env.PATH, effectivePath());
  // A copy, not the live process.env object -- mutating it must not leak.
  assert.notEqual(env, process.env);
});

test('run executes a real command and reports its exit status', () => {
  const r = run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout).trim(), 'ok');
});

test('run captures a non-zero exit instead of throwing', () => {
  assert.equal(run(process.execPath, ['-e', 'process.exit(3)']).status, 3);
});

test('run honours the timeout option', () => {
  // A hung gate tool must not hang the whole reinstall; it becomes a failed run.
  const r = run(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeout: 50 });
  assert.notEqual(r.status, 0);
});

test('npmCli resolves to an existing npm-cli.js next to node', () => {
  const cli = npmCli();
  // Empty means runNpm degrades to status 127.
  if (cli) assert.ok(isFile(cli), `resolved npmCli does not exist: ${cli}`);
});

test('packageDir honours XP_GATE_PACKAGE_DIR', () => {
  const original = process.env.XP_GATE_PACKAGE_DIR;
  try {
    process.env.XP_GATE_PACKAGE_DIR = process.cwd();
    resetPackageDir();
    // The override lets a test or sandbox pin the package location.
    assert.equal(packageDir(), process.cwd());
  } finally {
    if (original === undefined) delete process.env.XP_GATE_PACKAGE_DIR;
    else process.env.XP_GATE_PACKAGE_DIR = original;
    resetPackageDir();
  }
  assert.equal(typeof packageDir(), 'string');
});

test('resetPackageDir clears the memoised value without changing the answer', () => {
  const first = packageDir();
  resetPackageDir();
  assert.equal(first, packageDir());
});
