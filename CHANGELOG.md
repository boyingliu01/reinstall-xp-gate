# Changelog

All notable changes to this skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [Semantic Versioning](https://semver.org/).

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
