import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isDir, isFile, stripNul } from './util.mjs';

export const HOME = os.homedir();

let cachedPath = null;
let cachedPkgDir;

function readRegPath(key) {
  const reg = 'C:\\Windows\\System32\\reg.exe';
  if (!isFile(reg)) return '';
  const r = spawnSync(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return '';
  const text = stripNul(r.stdout);
  const line = text.split(/\r?\n/).find((l) => /Path\s+REG_/.test(l));
  if (!line) return '';
  const m = line.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
  return m ? m[1].trim() : '';
}

/**
 * Windows GUI 进程和 Git Bash 的 PATH 经常是陈旧的；工具已安装但看不见。
 * 合并注册表 Machine/User PATH，探测工具时用这份。
 */
export function effectivePath() {
  if (cachedPath) return cachedPath;
  // 从 Git Bash 启动时 node 往往不在 Windows PATH 上；npm 生成的 .cmd shim
  // 内部用 `node` 兜底，缺了它就会报 "'node' is not recognized"。
  const parts = [
    path.dirname(process.execPath),
    ...(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);
  if (process.platform === 'win32') {
    const machine = readRegPath(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    );
    const user = readRegPath('HKCU\\Environment');
    for (const chunk of [machine, user]) {
      for (const seg of String(chunk || '').split(';')) {
        const v = seg.trim();
        if (v) parts.push(v.replace(/%([^%]+)%/g, (_, name) => process.env[name] || ''));
      }
    }
  }
  cachedPath = [...new Set(parts)].join(path.delimiter);
  return cachedPath;
}

export function envWithPath() {
  return { ...process.env, PATH: effectivePath() };
}

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120000,
    stdio: opts.stdio,
    encoding: opts.stdio ? undefined : 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: envWithPath(),
  });
}

/**
 * Windows 上直接 spawn .cmd/.bat 会 EINVAL；经 Git Bash 的 shell 执行 .cmd 又因
 * 反斜杠转义失败（现象：工具明明在，probe 拿不到任何输出）。固定走 cmd.exe。
 */
export function probe(cmdPath, args, opts = {}) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmdPath)) {
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const line = `"${cmdPath}" ${args.map((a) => `"${a}"`).join(' ')}`;
    return spawnSync(comspec, ['/d', '/s', '/c', `"${line}"`], {
      windowsVerbatimArguments: true,
      timeout: opts.timeout ?? 15000,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: envWithPath(),
    });
  }
  return run(cmdPath, args, opts);
}

export function npmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find(isFile) || '';
}

export function runNpm(args, opts = {}) {
  const cli = npmCli();
  if (!cli) {
    return { status: 127, stdout: '', stderr: 'npm-cli.js not found next to node' };
  }
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 180000,
    stdio: opts.stdio,
    encoding: opts.stdio ? undefined : 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: envWithPath(),
  });
}

export function resetPackageDir() {
  cachedPkgDir = undefined;
}

export function packageDir() {
  if (cachedPkgDir !== undefined) return cachedPkgDir;
  const env = process.env.XP_GATE_PACKAGE_DIR;
  if (env && isDir(env)) {
    cachedPkgDir = env;
    return cachedPkgDir;
  }
  const r = runNpm(['root', '-g'], { timeout: 30000 });
  if (r.status === 0) {
    const candidate = path.join(String(r.stdout).trim(), '@boyingliu01', 'xp-gate');
    if (isDir(candidate)) {
      cachedPkgDir = candidate;
      return cachedPkgDir;
    }
  }
  const fallback = path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@boyingliu01', 'xp-gate');
  cachedPkgDir = isDir(fallback) ? fallback : '';
  return cachedPkgDir;
}

export function xp(args, opts = {}) {
  const pkg = packageDir();
  if (pkg) {
    return run(process.execPath, [path.join(pkg, 'bin', 'xp-gate.js'), ...args], opts);
  }
  const bin = process.platform === 'win32' ? 'xp-gate.cmd' : 'xp-gate';
  return run(bin, args, { ...opts, shell: process.platform === 'win32' });
}

export function xpJson(args, opts = {}) {
  const r = xp(args, { timeout: opts.timeout ?? 240000 });
  let json = null;
  try {
    json = JSON.parse(String(r.stdout || ''));
  } catch {
    json = null;
  }
  return { ...r, json };
}

export function gitConfig(key) {
  const r = run('git', ['config', '--global', key], { timeout: 15000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/** where 会返回 npm 的无扩展名 shim（实际可执行的是同名 .cmd/.exe）。 */
function firstExisting(base) {
  if (process.platform !== 'win32') return isFile(base) ? base : '';
  if (/\.(exe|cmd|bat|com)$/i.test(base)) return isFile(base) ? base : '';
  for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
    if (isFile(base + ext)) return base + ext;
  }
  return isFile(base) ? base : '';
}

export function which(tool) {
  if (process.platform === 'win32') {
    const r = run('C:\\Windows\\System32\\where.exe', [tool], { timeout: 10000 });
    if (r.status !== 0) return '';
    for (const line of String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const hit = firstExisting(line);
      if (hit) return hit;
    }
    return '';
  }
  const r = run('which', [tool], { timeout: 10000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

export function toolVersion(tool) {
  const resolved = which(tool);
  if (!resolved) return { path: '', version: '' };
  for (const flag of ['--version', '-v', '-V', 'version']) {
    const r = probe(resolved, [flag]);
    const first = stripNul(`${r.stdout || ''}${r.stderr || ''}`)
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first) return { path: resolved, version: first };
  }
  return { path: resolved, version: '' };
}
