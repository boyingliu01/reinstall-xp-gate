import test from 'node:test';
import assert from 'node:assert/strict';

import { labelFor, isOfficialSkillRoot, probeLiveness } from '../scripts/lib/agents.mjs';
import { HOME } from '../scripts/lib/proc.mjs';

// NOTE: discoverSkillRoots() is deliberately NOT unit-tested here because it
// scans the real HOME -- asserting on its output would encode this machine's
// agent layout into the suite and fail on any other box.

const under = (...parts) => `${HOME}/${parts.join('/')}`;

test('labelFor maps known config dirs to their product names', () => {
  assert.equal(labelFor(under('.dsh', 'skills')), 'DSH');
  assert.equal(labelFor(under('.qoder', 'skills')), 'Qoder');
  assert.equal(labelFor(under('.qoder-cn', 'skills')), 'Qoder CN');
  assert.equal(labelFor(under('.config', 'opencode', 'skills')), 'OpenCode');
  assert.equal(labelFor(under('.workbuddy', 'skills')), 'WorkBuddy');
});

test('labelFor derives a readable name for unknown agents', () => {
  // New agents must not need a code change to be labelled sanely.
  assert.equal(labelFor(under('.some-new-agent', 'skills')), 'some new agent');
});

test('isOfficialSkillRoot only accepts the four roots xp-gate itself installs to', () => {
  assert.equal(isOfficialSkillRoot(under('.dsh', 'skills')), true);
  assert.equal(isOfficialSkillRoot(under('.qoder', 'skills')), true);
  assert.equal(isOfficialSkillRoot(under('.trae-cn', 'skills')), false);
  assert.equal(isOfficialSkillRoot(under('.agents', 'skills')), false);
});

test('probeLiveness treats the shared skill store as always live', () => {
  // ~/.agents/skills is a shared repo, not one agent's config; it must never be
  // demoted to "residue" or every symlinked agent loses its skills.
  const r = probeLiveness({ agent: 'Generic agents', dir: under('.agents', 'skills') });
  assert.equal(r.live, true);
  assert.equal(r.reason, 'shared skill store');
});

test('probeLiveness reports not-live with a reason for a nonexistent agent dir', () => {
  const r = probeLiveness({ agent: 'No Such Agent', dir: under('.no-such-agent-xyz', 'skills') });
  assert.equal(r.live, false);
  assert.match(r.reason, /no app\/cli|idle/);
});

test('probeLiveness always returns both fields, whatever the verdict', () => {
  // Callers destructure live/reason unconditionally; a missing key would print
  // "undefined" into the report table.
  for (const entry of [
    { agent: 'Generic agents', dir: under('.agents', 'skills') },
    { agent: 'No Such Agent', dir: under('.nope-xyz', 'skills') },
  ]) {
    const r = probeLiveness(entry);
    assert.equal(typeof r.live, 'boolean');
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  }
});

test('probeLiveness honours the liveDays window argument', () => {
  // A dir that is neither app- nor CLI-backed falls through to the mtime rule.
  const entry = { agent: 'No Such Agent', dir: under('.nope-xyz', 'skills') };
  assert.equal(probeLiveness(entry, 0).live, false);
  // Missing dir -> Infinity days, past any finite window.
  assert.equal(probeLiveness(entry, 100000).live, false);
});
