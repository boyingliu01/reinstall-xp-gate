import { runNpm, toolVersion, which, run } from './proc.mjs';

export const TOOLS = [
  { name: 'jscpd', kind: 'npm', pkg: 'jscpd' },
  { name: 'lizard', kind: 'pip', pkg: 'lizard' },
  { name: 'checkov', kind: 'pip', pkg: 'checkov' },
  { name: 'hadolint', kind: 'binary', repo: 'hadolint/hadolint' },
  { name: 'gitleaks', kind: 'binary', repo: 'gitleaks/gitleaks' },
  { name: 'semgrep', kind: 'pip', pkg: 'semgrep' },
  { name: 'npx', kind: 'node' },
  { name: 'jq', kind: 'binary', repo: 'jqlang/jq' },
];

export function semverOf(value) {
  const m = String(value || '').match(/(\d+(?:\.\d+){1,3})/);
  return m ? m[1] : '';
}

/** Component-wise compare; missing components are zero. */
export function cmpVersion(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  const width = Math.max(pa.length, pb.length);
  for (let i = 0; i < width; i += 1) {
    const delta = (pa[i] || 0) - (pb[i] || 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function parts(value) {
  return semverOf(value).split('.').map(Number);
}

export function npmLatest(pkg, runNpmImpl = runNpm) {
  const r = runNpmImpl(['view', pkg, 'version'], { timeout: 30000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

export function pythonBin(whichImpl = which) {
  return whichImpl('python') || whichImpl('python3') || whichImpl('py');
}

/**
 * Every external effect the probe layer can reach, resolved once.
 *
 * Spreading `deps.x || realX` through each function made every signature carry
 * its own fallback chain, which pushed six of them past the CCN 5 ceiling
 * (measured: pipLatest 9, pipProbe 9, latestFor 8, pipShowVersion 7, detect 7,
 * upgraders 6). Filling the gaps in one place keeps each probe a straight-line
 * read of `deps` and restores the complexity budget.
 *
 * The table is data rather than a chain of `||` so adding a seam costs a row,
 * not a branch: written as a chain this function alone measured CCN 15.
 *
 * Production passes nothing, so every field is the real implementation and
 * behaviour is unchanged; tests pass only the fields they want to fake.
 */
const DEFAULT_DEPS = {
  toolVersion,
  pipProbe,
  pipShowVersion,
  pythonBin,
  run,
  runNpm,
  npmLatest,
  pipLatest,
  githubLatest,
  pypiLatest,
  fetchImpl: fetch,
  lookup: latestFor,
  log: (msg) => console.log(msg),
};

function resolveDeps(deps = {}) {
  const resolved = { ...DEFAULT_DEPS };
  for (const [key, value] of Object.entries(deps)) {
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

/**
 * 已装版本走本地元数据（毫秒级）。`pip list --outdated` 会逐个包访问 PyPI，
 * 实测在本机超过 120s，不能放在验收路径上。
 */
export function pipShowVersion(pkg, findPython = pythonBin, spawn = run) {
  const py = findPython();
  if (!py) return '';
  return versionField(spawn(py, ['-m', 'pip', 'show', pkg], { timeout: 30000 }));
}

/** The `Version:` value of a `pip show` result, or '' when it did not answer. */
function versionField(result) {
  if (result.status !== 0) return '';
  const m = String(result.stdout || '').match(/^Version:\s*(\S+)/m);
  return m ? m[1] : '';
}

/** The `pkg (1.2.3)` value of a `pip index versions` result, or null. */
function indexVersionField(result) {
  if (result.status !== 0) return null;
  const m = String(result.stdout || '').match(/^[^\s()]+\s+\(([^)]+)\)/m);
  return m ? semverOf(m[1]) : null;
}

/**
 * checkov 的 PyPI JSON 体积达数十 MB，8s 内拉不完；`pip index versions` 只回
 * 一个短响应，先走它，失败再退回 PyPI JSON。
 */
export async function pipLatest(pkg, deps = {}) {
  const d = resolveDeps(deps);
  const py = d.pythonBin();
  if (!py) return d.pypiLatest(pkg);
  const found = indexVersionField(d.run(py, ['-m', 'pip', 'index', 'versions', pkg], { timeout: 45000 }));
  return found ?? d.pypiLatest(pkg);
}

export async function fetchJsonVersion(url, timeoutMs, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': 'xp-gate-reinstall' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function pypiLatest(pkg, fetchImpl = fetch) {
  const payload = await fetchJsonVersion(`https://pypi.org/pypi/${pkg}/json`, 8000, fetchImpl);
  return payload ? semverOf(payload.info?.version || '') : '';
}

export async function githubLatest(repo, fetchImpl = fetch) {
  const payload = await fetchJsonVersion(`https://api.github.com/repos/${repo}/releases/latest`, 6000, fetchImpl);
  return payload ? semverOf(payload.tag_name || '') : '';
}

/**
 * Fill the version/path of a pip-managed tool from whichever source answers.
 *
 * `deps` carries the same lookups `detect` received. Without threading them
 * through, injecting `toolVersion` at the top still let this function call the
 * real one -- each test then paid a live `which python` round trip, which is
 * how a supposedly isolated unit test took 5-7 s.
 */
export function pipProbe(spec, row, deps = {}) {
  const d = resolveDeps(deps);
  const shown = d.pipShowVersion(spec.pkg, d.pythonBin);
  const probe = d.toolVersion(spec.name);
  if (!shown && !probe.path) return;
  row.present = true;
  row.version = pipVersion(shown, probe.version);
  row.path = pipPath(shown, probe.path, spec.pkg);
}

/**
 * pip's own metadata wins over the version banner when both answered: the banner
 * is a tool-specific string, the metadata is the installed distribution version.
 * A binary's version is kept raw because it may be unparseable by design.
 */
function pipVersion(shown, probed) {
  if (shown) return semverOf(shown);
  return semverOf(probed) || probed;
}

/** A venv install is not on PATH, so the path has to say how to reach it. */
function pipPath(shown, probedPath, pkg) {
  if (!shown) return probedPath;
  return probedPath || `python -m pip show ${pkg}`;
}

/**
 * Probe one tool spec into a report row.
 *
 * `deps` exists so the probe can be exercised without real tools on PATH:
 * `toolVersion` shells out via `proc.mjs`, whose bindings are fixed at module
 * load and cannot be swapped by a test. Injecting the lookups keeps the
 * production default identical while making every branch reachable.
 */
export function detect(spec, deps = {}) {
  const d = resolveDeps(deps);
  const row = { ...spec, path: '', present: false, version: '', latest: '', status: 'ok' };
  if (spec.kind === 'pip') {
    d.pipProbe(spec, row, deps);
    return row;
  }
  const probe = d.toolVersion(spec.name);
  row.present = Boolean(probe.path);
  row.path = probe.path;
  row.version = spec.kind === 'binary' ? probe.version : semverOf(probe.version) || probe.version;
  return row;
}

/**
 * Best known release for a tool, or '' when the lookup is unavailable.
 *
 * Every branch reaches the network or spawns a package manager, so the three
 * sources are injectable. Without that seam none of them is testable, which is
 * how this function reached 25% function coverage while carrying the decision
 * that turns a tool row into 'outdated'.
 */
export async function latestFor(row, deps = {}) {
  const d = resolveDeps(deps);
  const source = { npm: d.npmLatest, pip: d.pipLatest, binary: d.githubLatest }[row.kind];
  if (!source) return '';
  const raw = row.kind === 'npm' ? source(row.pkg) : await source(row.kind === 'pip' ? row.pkg : row.repo);
  return semverOf(raw);
}

/**
 * Classify one row. `node` (npx) has no independent version to compare, so it
 * is 'ok' whenever it resolves -- calling it 'unverified' every run would add a
 * permanent WARN that trains the operator to ignore the column.
 */
export async function classify(row, lookup = latestFor) {
  if (!row.present) {
    row.status = 'missing';
    return row;
  }
  row.latest = await lookup(row);
  row.status = statusOf(row);
  return row;
}

/**
 * The verdict for one probed row.
 *
 * Split out and exported because it is the whole decision and it has three
 * outcomes that are easy to collapse: a tool that is absent ('missing'), one
 * whose latest version could not be fetched ('unverified'), and one that is
 * genuinely behind ('outdated'). Reporting the middle case as 'ok' would say a
 * tool is current when nothing was compared -- the same silent pass this
 * project exists to avoid. `node` is the documented exception: it has no
 * independent version to compare against, so a permanent 'unverified' would be
 * noise rather than information.
 */
export function statusOf(row) {
  if (row.latest) return cmpVersion(row.version, row.latest) < 0 ? 'outdated' : 'ok';
  return row.kind === 'node' ? 'ok' : 'unverified';
}

/** 8 个门禁 CLI 的存在性 + 版本 + 可达最新。 */
export async function toolReport(deps = {}) {
  const d = resolveDeps(deps);
  const rows = TOOLS.map((spec) => detect(spec, d));
  // Not `rows.map(classify)`: map passes (value, index, array), so the index
  // lands in the `lookup` parameter and every call dies with "lookup is not a
  // function". The default only applies when the argument is undefined.
  await Promise.all(rows.map((row) => classify(row, d.lookup)));
  return rows;
}

/** `install -g <pkg>@latest` through npm; the exit code is the verdict. */
function upgradeNpm(row, d) {
  const r = d.runNpm(['install', '-g', `${row.pkg}@latest`], { stdio: 'inherit', timeout: 600000 });
  return r.status ?? 1;
}

/** `pip install -U <pkg>`; without an interpreter there is nothing to run. */
function upgradePip(row, d) {
  const py = d.pythonBin();
  if (!py) return 1;
  const r = d.run(py, ['-m', 'pip', 'install', '-U', row.pkg], { stdio: 'inherit', timeout: 600000 });
  return r.status ?? 1;
}

/**
 * 二进制工具没有统一的包管理器入口，只提示，不擅自下载覆盖用户的 PATH。
 */
function upgradeBinary(row, d) {
  d.log(`  ${row.name}: 二进制工具，请从 ${row.repo || '官方 release'} 手动升级到 ${row.latest || '最新版'}`);
  return 0;
}

/**
 * 各 kind 的升级方式。表驱动而不是 if-链：原来是三分支嵌套，
 * 加一种 kind 就要再嵌一层，而现在只需要加一行。
 *
 * 每条分支都通过 `deps` 注入以便测试：它们真的会执行全局安装，
 * 在测试里跑一次就会改动开发机的工具链。
 */
const UPGRADERS = { npm: upgradeNpm, pip: upgradePip, binary: upgradeBinary };

export function upgradeTool(row, deps = {}) {
  const upgrade = UPGRADERS[row.kind];
  return upgrade ? upgrade(row, resolveDeps(deps)) : 0;
}
