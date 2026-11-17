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

export function cmpVersion(a, b) {
  const pa = semverOf(a).split('.').map(Number);
  const pb = semverOf(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function npmLatest(pkg) {
  const r = runNpm(['view', pkg, 'version'], { timeout: 30000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

/**
 * 已装版本走本地元数据（毫秒级）。`pip list --outdated` 会逐个包访问 PyPI，
 * 实测在本机超过 120s，不能放在验收路径上。
 */
function pipShow(pkg) {
  const py = which('python') || which('py');
  if (!py) return null;
  const r = run(py, ['-m', 'pip', 'show', pkg], { timeout: 30000 });
  if (r.status !== 0) return null;
  const m = String(r.stdout || '').match(/^Version:\s*(\S+)/m);
  return m ? m[1] : '';
}

/**
 * checkov 的 PyPI JSON 体积达数十 MB，8s 内拉不完；`pip index versions` 只回
 * 一个短响应，先走它，失败再退回 PyPI JSON。
 */
function pipLatest(pkg) {
  const py = which('python') || which('py');
  if (py) {
    const r = run(py, ['-m', 'pip', 'index', 'versions', pkg], { timeout: 45000 });
    if (r.status === 0) {
      const m = String(r.stdout || '').match(/^[^\s()]+\s+\(([^)]+)\)/m);
      const v = m ? semverOf(m[1]) : '';
      if (v) return v;
    }
  }
  return pypiLatest(pkg);
}

async function pypiLatest(pkg) {
  try {
    const res = await fetch(`https://pypi.org/pypi/${pkg}/json`, {
      headers: { 'user-agent': 'xp-gate-reinstall' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const payload = await res.json();
    return semverOf(payload.info?.version || '');
  } catch {
    return '';
  }
}

async function githubLatest(repo) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'user-agent': 'xp-gate-reinstall' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return '';
    const payload = await res.json();
    return semverOf(payload.tag_name || '');
  } catch {
    return '';
  }
}

function detect(spec) {
  const row = { ...spec, path: '', present: false, version: '', latest: '', status: 'ok' };
  if (spec.kind === 'pip') {
    const shown = pipShow(spec.pkg);
    const probe = toolVersion(spec.name);
    if (shown) {
      row.present = true;
      row.version = semverOf(shown);
      row.path = probe.path || `python -m pip show ${spec.pkg}`;
    } else if (probe.path) {
      row.present = true;
      row.version = semverOf(probe.version) || probe.version;
      row.path = probe.path;
    }
  } else {
    const probe = toolVersion(spec.name);
    row.present = Boolean(probe.path);
    row.path = probe.path;
    row.version = spec.kind === 'binary' ? probe.version : semverOf(probe.version) || probe.version;
  }
  return row;
}

/** 8 个门禁 CLI 的存在性 + 版本 + 可达最新。 */
export async function toolReport() {
  const rows = TOOLS.map(detect);
  await Promise.all(rows.map(async (row) => {
    if (!row.present) {
      row.status = 'missing';
      return;
    }
    if (row.kind === 'npm') {
      row.latest = semverOf(npmLatest(row.pkg));
    } else if (row.kind === 'pip') {
      row.latest = await pipLatest(row.pkg);
    } else if (row.kind === 'binary') {
      row.latest = await githubLatest(row.repo);
    }

    if (row.latest) {
      row.status = cmpVersion(row.version, row.latest) < 0 ? 'outdated' : 'ok';
    } else if (row.kind === 'node') {
      row.status = 'ok';
    } else {
      row.status = 'unverified';
    }
  }));
  return rows;
}

/** pip 系的解释器名有多个别名，按优先级取第一个能解析到。 */
function pythonBin() {
  return which('python') || which('python3') || which('py');
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
