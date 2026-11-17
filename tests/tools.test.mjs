import test from 'node:test';
import assert from 'node:assert/strict';

import { semverOf, cmpVersion, TOOLS } from '../scripts/lib/tools.mjs';

// semverOf + cmpVersion decide "is this tool outdated". A wrong answer either
// silently skips an upgrade (gate tool stays old) or claims a bogus upgrade is
// available on every run and trains the operator to ignore the report.

test('semverOf extracts a version from the shapes real tools print', () => {
  assert.equal(semverOf('1.2.3'), '1.2.3');
  assert.equal(semverOf('v2.0.0'), '2.0.0');
  assert.equal(semverOf('jscpd 3.5.10'), '3.5.10');
  assert.equal(semverOf('lizard (1.17.10)'), '1.17.10');
  assert.equal(semverOf('gitleaks version 8.18.2'), '8.18.2');
  // Fourth component is kept: several gate tools ship 4-part versions.
  assert.equal(semverOf('1.2.3.4'), '1.2.3.4');
});

test('semverOf returns empty string when no version is present', () => {
  assert.equal(semverOf(''), '');
  assert.equal(semverOf(null), '');
  assert.equal(semverOf('not found'), '');
});

test('cmpVersion compares numerically, not lexically', () => {
  // "10" must beat "9". A string compare would rank 9 higher and the upgrade
  // would never fire for double-digit minors.
  assert.equal(cmpVersion('1.10.0', '1.9.0'), 1);
  assert.equal(cmpVersion('1.9.0', '1.10.0'), -1);
  assert.equal(cmpVersion('10.0.0', '9.9.9'), 1);
});

test('cmpVersion treats missing components as zero', () => {
  assert.equal(cmpVersion('1.2', '1.2.0'), 0);
  assert.equal(cmpVersion('1.2.0', '1.2'), 0);
  assert.equal(cmpVersion('1.2.1', '1.2'), 1);
});

test('cmpVersion ranks a bare major as OLDER, not equal', () => {
  // semverOf requires at least two components, by design: it must not mistake a
  // stray integer in tool output for a version. So "1" parses to '' and compares
  // as [0], ranking below 1.0.0. Pinning this because it looks like a bug but is
  // the intended trade-off -- a looser regex would pick up build numbers and
  // produce false "outdated" reports.
  assert.equal(semverOf('1'), '');
  assert.equal(cmpVersion('1', '1.0.0'), -1);
});

test('cmpVersion returns 0 only for equal versions', () => {
  assert.equal(cmpVersion('3.5.10', '3.5.10'), 0);
  assert.equal(cmpVersion('v3.5.10', '3.5.10'), 0);
});

test('cmpVersion handles unparseable input without throwing', () => {
  assert.doesNotThrow(() => cmpVersion('garbage', '1.0.0'));
  assert.equal(cmpVersion('garbage', '1.0.0'), -1);
});

test('TOOLS declares every tool the verify step expects, with a usable spec', () => {
  const names = TOOLS.map((t) => t.name);
  for (const required of ['jscpd', 'lizard', 'checkov', 'hadolint', 'gitleaks', 'semgrep', 'npx', 'jq']) {
    assert.ok(names.includes(required), `missing tool spec: ${required}`);
  }
  // Every entry needs a dispatcher, otherwise upgradeTool returns 0 and the
  // report claims success while the tool is never upgraded.
  const dispatchable = ['npm', 'pip', 'binary'];
  for (const tool of TOOLS) {
    assert.ok(['npm', 'pip', 'binary', 'node'].includes(tool.kind), `bad kind for ${tool.name}`);
    if (tool.kind === 'npm' || tool.kind === 'pip') assert.ok(tool.pkg, `${tool.name} needs pkg`);
    if (tool.kind === 'binary') assert.ok(tool.repo, `${tool.name} needs repo`);
    if (tool.kind !== 'node') assert.ok(dispatchable.includes(tool.kind), `undispatchable: ${tool.name}`);
  }
});
