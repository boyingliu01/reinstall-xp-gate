import test from 'node:test';
import assert from 'node:assert/strict';

import { CASES, summarize } from '../scripts/lib/gatecheck.mjs';

// The audit is only useful if its own bookkeeping is right. These tests pin the
// three outcomes a case can have WITHOUT running a gate, because the expensive
// part (spawning git + xp-gate) is covered by `node scripts/audit.mjs --gates`.
// The bug this guards against was measured: Gate 2's CONTROL tree blocked (jscpd
// missing), the old summary counted that as a gate failure, and the report read
// as "the gates are broken" when the truth was "a tool is missing".

const ok = (id) => ({
  id, name: `g${id}`, cleanVerdict: 'passed', dirtyVerdict: 'blocked', knownGap: false, ok: true, measurementValid: true,
});
const failed = (id) => ({
  id, name: `g${id}`, cleanVerdict: 'passed', dirtyVerdict: 'passed', knownGap: false, ok: false, measurementValid: true,
});
const unmeasurable = (id) => ({
  id, name: `g${id}`, cleanVerdict: 'blocked', dirtyVerdict: 'blocked', knownGap: false, ok: false, measurementValid: false,
});
const gap = (id) => ({
  id, name: `g${id}`, cleanVerdict: 'passed', dirtyVerdict: 'unknown', knownGap: true, ok: false, measurementValid: true,
});

test('summarize passes when every measurable case separated clean from dirty', () => {
  const s = summarize([ok(8), ok(3)]);
  assert.equal(s.pass, true);
  assert.equal(s.ok, 2);
  assert.equal(s.failed, 0);
});

test('summarize fails when a gate passed a tree with a known defect in it', () => {
  const s = summarize([ok(8), failed(3)]);
  assert.equal(s.pass, false);
  assert.equal(s.failed, 1);
});

test('summarize reports a blocking control as invalid, not as a gate failure', () => {
  // This is the measured upstream state: jscpd absent, so the clean tree blocked
  // too. It must not be counted as "the gate is broken".
  const s = summarize([ok(8), unmeasurable(2)]);
  assert.equal(s.invalid, 1);
  assert.equal(s.failed, 0, 'an unmeasurable case is not a gate failure');
  assert.equal(s.pass, false, 'but the audit cannot claim a pass either');
});

test('summarize excludes known gaps from both counters', () => {
  const s = summarize([ok(8), gap(12)]);
  assert.equal(s.knownGaps, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.pass, true, 'a documented upstream gap must not turn the audit permanently red');
});

test('summarize passes only when every case was measured', () => {
  assert.equal(summarize([ok(1)]).pass, true);
  assert.equal(summarize([]).pass, true);
});

test('every declared case states an explicit expected verdict', () => {
  // A case without `expect` would compare against undefined and silently never
  // be satisfiable, so it must be impossible to add one.
  for (const c of CASES) {
    assert.ok(['blocked', 'detected'].includes(c.expect), `${c.id} has an unsupported expectation: ${c.expect}`);
    assert.equal(typeof c.plant, 'function', `${c.id} must plant a defect`);
    assert.ok(c.name.length > 0, `${c.id} needs a name`);
  }
});

test('Gate 2 is expected to block, because 0.38.75 added a threshold', () => {
  // Pinned because the expectation silently rotted once already: until 0.38.74
  // jscpd was invoked without --threshold and returns 0 no matter how much it
  // finds, so Gate 2 could only ever 'detect'. When the audit kept expecting
  // 'detected' after the gate started failing, a working gate was reported as
  // FAILED -- the audit cried wolf on its own improvement.
  const gate2 = CASES.find((c) => c.id === 2);
  assert.equal(gate2.expect, 'blocked');
});

test('the gate ids under test are unique', () => {
  const ids = CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
