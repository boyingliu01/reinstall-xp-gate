# Changelog

All notable changes to this skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [Semantic Versioning](https://semver.org/).

## [1.3.2] - 2026-02-21

### Fixed

- **The audit reported a stronger gate as broken.** xp-gate 0.38.75 added
  `--threshold 15` to Gate 2's jscpd invocation; before that jscpd was called
  without a threshold, returned 0 no matter how much duplication it found, and
  the gate passed unconditionally — which is why the case could only ever expect
  `detected`. Once the gate started failing, the stale expectation reported it as
  FAILED. Verified on 0.38.75 with the planted fixture: `Found 1 clones`, then
  `ERROR: jscpd found too many duplicates (50.0%) over threshold (15.0%)`. The
  control tree still passes, so the case separates rather than failing always.

### Changed

- This closes the Gate 2 gap recorded in 1.3.0, where the audit called Gate 2
  permanently UNMEASURABLE on Windows with jscpd >= 5. It now measures, and
  measures correctly: audit 13/13 PASS with 3/3 cases separating.

## [1.3.1] - 2026-02-21

The theme: **the installer's own maintenance state had no bound.**

### Fixed

- **`install.mjs` grew its backup directory without limit.** Every run backs up
  each agent copy it is about to overwrite and nothing ever removed one.
  Measured before the policy existed: 50 backups / 11 MB dating back to v1.1.0,
  growing by one set per install. `pruneBackups` now keeps the newest 3 stamped
  backups **per agent**. The cap is per label rather than per directory because
  one run backs up all nine agents with the same timestamp, so a global cap of 3
  would delete six of the backups that run had just written — the retain count
  would be spent on simultaneity instead of history, and rolling back one agent
  would be impossible while its siblings survived.
- **`toolReport()` crashed with "lookup is not a function".** `rows.map(classify)`
  passes `(value, index, array)`, so the index landed in the `lookup` parameter.
  `verify.mjs` died outright while every unit test stayed green, because they all
  passed `lookup` explicitly. The map call is now an explicit arrow.

### Added

- `tests/cleanup.test.mjs`: 7 cases covering pruning (per-agent cap, name-stamp
  ordering over mtime, unrecognised directories spared, no-op guards) and the
  map-arity regression. An earlier version of the arity test called
  `toolReport()` and hung the suite for 60 s shelling out to npm/pip for all
  eight tools; it now drives `classify` through `map` with a fake lookup.
- 3 mutation entries for the pruning rules, so the retention policy cannot
  regress silently. 19/19 mutations killed.

## [1.3.0] - 2026-02-19

The theme: **make the quality claims measurable.** Three separate checks in this
repo reported "clean" while measuring nothing, and each was found only by
re-deriving the number by hand.

### Added

- **`scripts/hp-gate.mjs` — complexity for the files xp-gate cannot see.**
  xp-gate's `LIZARD_EXTENSIONS` and `SEMGREP_EXTENSIONS` (`gates/common.ts`)
  both omit `mjs`/`cjs`, so a pure-ESM project passes Gate 3 with the message
  "⏭️ SKIPPED – Complexity (no source files to check)" and no function measured
  (xp-gate#732). Measured control: the same CCN-22 file is checked as `src/a.js`
  and skipped as `src/a.mjs`. `hp-gate` runs lizard over `.mjs`/`.cjs` at the
  same CCN 5 threshold Gate 3 uses, plus `node --check` per file (Gate 1 also
  skips `.mjs`). Wired into CI and `npm run hp-gate`.

- **`scripts/lib/ccn.mjs` — the CSV contract, testable.** `parseLizardCsv`,
  `splitCsvLine`, `ccnViolations`, with `tests/ccn.test.mjs` pinning all three
  numeric columns. Field order verified against lizard 1.26.1
  `lizard_ext/csvoutput.py`: `nloc, cyclomatic_complexity, token_count, …`.

- **`tests/gatecheck-audit.test.mjs`** — pins the audit's own bookkeeping: a
  blocked control is `unmeasurable`, not a gate failure, and a known upstream
  gap neither counts as a pass nor turns the audit permanently red.

### Fixed

- **`hp-gate` passed a tree containing a CCN-22 function, twice.** First because
  lizard was run without `--csv` (empty stdout); then because the parser read
  column 0 (NLOC) instead of column 1 (CCN), yielding zero rows. Both surfaced
  as "every function within CCN 5". There is now a hard `scanBroken` failure
  when a non-empty source set parses to zero rows, plus a mutation for each of
  the three ways to misread the columns.

- **`audit.mjs` reported a blocking control as a gate failure.** Gate 2's clean
  tree prints `Gate 2 FAILED: spawnSync npx ENOENT` even with jscpd 5.4.3 on
  PATH, because `lib/gate-runner.js` probes `<root>/node_modules/jscpd/bin/jscpd`
  and jscpd 5.x moved its bin to `run-jscpd.js`; the three fallbacks fail on
  Windows for three different reasons (`jscpd.cmd` EINVAL, `jscpd` ENOENT,
  `npx` ENOENT) — all through `execFileSync` without a shell. Reported as
  `UNMEASURABLE` now; the root cause is documented in `lib/gatecheck.mjs`.

- **`cmpVersion` mutation was equivalent to the original** and could never be
  killed, so it tested nothing while looking like coverage. Replaced with two
  mutations that do change behaviour (first-component-only, string compare).

- **Four `residue.mjs` mutation anchors went stale** during refactoring and were
  silently reported as `SKIPPED`. Re-anchored, and the anchors now target the
  named helpers (`classifyCopy`, `isIdenticalCopy`) so a future split is more
  likely to fail loudly than to pass quietly.

- **Every production function in this repo was above CCN 5.** 14 functions
  exceeded the threshold the repo's own gates would enforce (had they looked);
  the worst was `runCase` at 27. All 414 functions are now within CCN 5,
  including the tests. The refactors split behaviour, they did not delete it —
  the suite grew from 97 to 114 cases and mutation coverage from 8 to 16
  mutations while the violation count went to zero.

- **Version bump to 1.3.0** and `VERSION` now matches `package.json`.

## [1.2.0] - 2026-11-17

### Added

- **`scripts/audit.mjs` — ask "are the gates still effective" without
  reinstalling.** `reinstall.mjs` used to be the only entry point, so the only
  way to check whether the gates still block was to tear down and rebuild the
  installation. Those are different questions. Two layers, reported separately:
  on-disk parity, and whether the gates actually reject a planted defect.

- **`scripts/lib/gatecheck.mjs` — gray-box gate verification.** Builds a
  throwaway git repo, plants a defect the gate is responsible for catching, and
  requires the gate to say so. Every case runs twice: the same gate on the same
  tree without the defect. Recall alone is not a verdict — a gate that blocks
  everything would otherwise score as perfect.

  Measured on 0.38.9:

  | Gate | clean | planted | verdict |
  |---|---|---|---|
  | 8 — secret scan | passed | blocked | ok |
  | 3 — complexity | skipped | blocked | ok |
  | 2 — duplicates | passed | detected | ok |

  `detected` is a separate verdict from `blocked` because the gates disagree
  about severity: Gate 8 exits 1 on a secret, while Gate 2 reports
  `Found N clones` and exits 0 with or without clones.

- **`scripts/mutation.mjs` — `npm run mutation`.** Eight injected defects that
  must all be caught, each tied to a property this skill exists to guarantee
  (wrong directory deleted, user's edit overwritten, outdated tool reported
  current). Turns the one-off mutation pass from 1.1.1 into a repeatable gate.
  Currently 8/8 killed.

- **CI** (`.github/workflows/test.yml`): tests on Node 18/20/22, the mutation
  gate on every push, and the gray-box gate audit weekly — the last one because
  it depends on the *installed* xp-gate release, which changes without this
  repository changing.

### Fixed

- `verdictOf` read `./failed-tests.js` as `blocked`: `FAILED` was matched as a
  substring, so a filename containing "failed" turned a clean gate run into a
  failure. Now matched as a standalone token. A false alarm is how an audit
  stops being read at all.
- `verdictOf` returned `unknown` for a clean Gate 2 run, because Gate 2 prints
  no is okay-marker at all. "Cannot read the output" and "the gate is fine" must
  not look the same.
- The mutation runner spawned the test suite through a shell, so
  `C:\Program Files\nodejs\node.exe` was split at the space and every mutation
  reported as SURVIVED because the suite never ran. Added a distinct `ERROR`
  outcome for "the runner failed", so a broken invocation is no longer
  indistinguishable from a missing test.
- The mutation runner could not read CI's test output. Node picks its reporter
  by whether stdout is a TTY, so a terminal prints `ℹ fail 0` and a piped run
  prints TAP `# fail 0`; the runner matched only the first, so every CI run
  reported "the runner failed" while the counts were right there under a
  different name. The parse now lives in `lib/testreport.mjs` with tests for both
  formats, instead of being a regex buried in the runner.
- `node --test "tests/*.test.mjs"` (quoted) only works on Windows: Node's test
  runner expands the glob there but not on Linux, where it fails with
  `Could not find '.../tests/*.test.mjs'`. Verified only on Windows before
  pushing, which is exactly the gap. The glob is now unquoted so the shell
  expands it, and `mutation.mjs` enumerates the files itself instead of relying
  on anyone to expand anything.

### Upstream

- Filed [xp-gate#840](https://github.com/boyingliu01/xp-gate/issues/840): on a
  machine without OpenCode, `doctor` reports `✗ TUI registration: Not
  registered` and exits 1, because the check never asks whether the platform
  exists. Found by the new audit — it was the only FAIL on an otherwise clean
  machine.

## [1.1.1] - 2026-11-17

### Fixed

- `tests/residue.test.mjs`: "pruneDeadRoots removes only copies identical to the
  published package" asserted nothing about the hash comparison it is named
  after. It deployed the untouched copy as `alpha` and the edited one as `beta`,
  but `contentHashes()` only iterates names present in the package, so `beta`
  was skipped before any hash was computed — the assertion held either way.

  Found by mutation testing: removing the hash check from `pruneDeadRoots`
  (`isDir(dest) && hashFn(dest) === expected` → `isDir(dest)`), which makes it
  delete user-edited skill copies, left the suite 84/84 green. The test now
  places the same skill name in two dead roots, one untouched and one edited.
  The same mutation now fails one test.

### Changed

- Extracted `tests/fixtures.mjs` with `tmpDir`, `fakePkg`, `deploySkill` and
  `editSkill`, previously copy-pasted into four test files. They track the
  package layout, temp-dir cleanup and drift simulation, all of which must
  change together. jscpd clone pairs: 3 → 0.

## [1.1.0] - 2026-11-17

### Added

- 84 tests across 8 files using the built-in `node:test` runner (zero
  dependencies, no `npm install`). Priority follows blast radius: the four
  destructive helpers in `lib/residue.mjs` are covered first.
- `lib/residue.mjs`, extracted from `reinstall.mjs` (364 → 292 lines) so that
  backup-then-delete, marker detection and dead-root pruning became testable.
- `package.json` with `test`, `install-skill`, `preflight`, `reinstall` and
  `verify` scripts; `node >= 18`.

### Changed

- Cyclomatic complexity brought below Gate 3's block threshold of 10:

  | function | before | after | how |
  |---|---:|---:|---|
  | `probeLiveness` | 13 | 7 | split into `appEvidence` / `cliEvidence` / `idleDays` |
  | `collectBaseline` | 11 | ~3 | split into `xpGateInfo` / `configInfo` / `delphiInfo` / `doctorInfo` |
  | `upgradeTool` | 10 | ~2 | if-chain replaced by an `UPGRADERS` dispatch table |

  Function rate 0.56 → 0.60.

### Fixed

- `SKILL.md` gained a note on DSH erasing credential-shaped environment
  variables (`KEY`/`PASSWORD`/`SECRET`/`TOKEN`) before spawning subprocesses,
  which makes `delphi-external-review` report a missing API key on a machine
  where it is set. It is a security design, not a misconfiguration.

## [1.0.0] - 2026-11-16

### Added

- Initial release: snapshot config → purge with residue cleanup → install the
  latest npm release → upgrade gate tools → verify each agent's skills, plugins
  and hooks.
