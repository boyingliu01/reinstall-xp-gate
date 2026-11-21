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

function npmLatest(pkg) {
  const r = runNpm(['view', pkg, 'version'], { timeout: 30000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

function pythonBin() {
  return which('python') || which('python3') || which('py');
}

/**
 * 已装版本走本地元数据（毫秒级）。`pip list --outdated` 会逐个包访问 PyPI，
 * 实测在本机超过 120s，不能放在验收路径上。
 */
function pipShowVersion(pkg) {
  const py = pythonBin();
  if (!py) return '';
  const r = run(py, ['-m', 'pip', 'show', pkg], { timeout: 30000 });
  if (r.status !== 0) return '';
  const m = String(r.stdout || '').match(/^Version:\s*(\S+)/m);
  return m ? m[1] : '';
}

/**
 * checkov 的 PyPI JSON 体积达数十 MB，8s 内拉不完；`pip index versions` 只回
 * 一个短响应，先走它，失败再退回 PyPI JSON。
 */
async function pipLatest(pkg) {
  const py = pythonBin();
  if (py) {
    const r = run(py, ['-m', 'pip', 'index', 'versions', pkg], { timeout: 45000 });
    const m = r.status === 0 ? String(r.stdout || '').match(/^[^\s()]+\s+\(([^)]+)\)/m) : null;
    if (m) return semverOf(m[1]);
  }
  return pypiLatest(pkg);
}

async function fetchJsonVersion(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'xp-gate-reinstall' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function pypiLatest(pkg) {
  const payload = await fetchJsonVersion(`https://pypi.org/pypi/${pkg}/json`, 8000);
  return payload ? semverOf(payload.info?.version || '') : '';
}

async function githubLatest(repo) {
  const payload = await fetchJsonVersion(`https://api.github.com/repos/${repo}/releases/latest`, 6000);
  return payload ? semverOf(payload.tag_name || '') : '';
}

/** Fill the version/path of a pip-managed tool from whichever source answers. */
function pipProbe(spec, row) {
  const shown = pipShowVersion(spec.pkg);
  const probe = toolVersion(spec.name);
  if (shown) {
    row.present = true;
    row.version = semverOf(shown);
    row.path = probe.path || `python -m pip show ${spec.pkg}`;
    return;
  }
  if (!probe.path) return;
  row.present = true;
  row.version = semverOf(probe.version) || probe.version;
  row.path = probe.path;
}

function detect(spec) {
  const row = { ...spec, path: '', present: false, version: '', latest: '', status: 'ok' };
  if (spec.kind === 'pip') {
    pipProbe(spec, row);
    return row;
  }
  const probe = toolVersion(spec.name);
  row.present = Boolean(probe.path);
  row.path = probe.path;
  row.version = spec.kind === 'binary' ? probe.version : semverOf(probe.version) || probe.version;
  return row;
}

/** Best known release for a tool, or '' when the lookup is unavailable. */
async function latestFor(row) {
  if (row.kind === 'npm') return semverOf(npmLatest(row.pkg));
  if (row.kind === 'pip') return pipLatest(row.pkg);
  if (row.kind === 'binary') return githubLatest(row.repo);
  return '';
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
export async function toolReport() {
  const rows = TOOLS.map(detect);
  // Not `rows.map(classify)`: map passes (value, index, array), so the index
  // lands in the `lookup` parameter and every call dies with "lookup is not a
  // function". The default only applies when the argument is undefined.
  await Promise.all(rows.map((row) => classify(row)));
  return rows;
}

/**
 * 各 kind 的升级方式。拆成表驱动而不是 if-链：原来是三分支嵌套，
 * 加一种 kind 就要再嵌一层，而现在只需要加一行。
 * @returns {number} 退出码
 */
const UPGRADERS = {
  npm(row) {
    const r = runNpm(['install', '-g', `${row.pkg}@latest`], { stdio: 'inherit', timeout: 600000 });
    return r.status ?? 1;
  },
  pip(row) {
    const py = pythonBin();
    if (!py) return 1;
    const r = run(py, ['-m', 'pip', 'install', '-U', row.pkg], { stdio: 'inherit', timeout: 600000 });
    return r.status ?? 1;
  },
  binary(row) {
    // 二进制工具没有统一的包管理器入口，只提示，不擅自下载覆盖用户的 PATH。
    console.log(`  ${row.name}: 二进制工具，请从 ${row.repo || '官方 release'} 手动升级到 ${row.latest || '最新版'}`);
    return 0;
  },
};

export function upgradeTool(row) {
  const upgrade = UPGRADERS[row.kind];
  return upgrade ? upgrade(row) : 0;
}
