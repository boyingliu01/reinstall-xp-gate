# Changelog

All notable changes to this skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [Semantic Versioning](https://semver.org/).

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
