import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isDir, isFile, stripNul } from './util.mjs';

export const HOME = os.homedir();

/**
 * Budgets for the three kinds of child process this module starts.
 *
 * Named by INTENT, deliberately not by duration. A count of the literals used to
 * show 30s four times, but those four were unrelated decisions -- a node syntax
 * check and `npm root -g` happen to need the same number today while having
 * nothing to do with each other. Grouping them under one `TIMEOUT_30S` would
 * couple two changes that should stay independent, which is the failure mode
 * this file's `spawnOpts` comment already warns about.
 *
 * What IS shared is everything inside one tier: every lookup that must answer
 * fast gets the same budget, and every xp-gate mutation gets the same budget.
 */
/** which / where / registry queries: a slow one means the tool is unusable. */
export const PROBE_TIMEOUT_MS = 10000;

/**
 * xp-gate mutations that rewrite the global install: uninstall --purge,
 * `npm uninstall -g`, `update-hooks`, `doctor`. They shell out to the same CLI
 * and are all slow for the same reason, so they share one budget.
 */
export const XP_GATE_SLOW_OP_TIMEOUT_MS = 300000;

/** Registry keys holding PATH, in append order. */
const PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];
const WIN_REG = 'C:\\Windows\\System32\\reg.exe';
const WIN_WHERE = 'C:\\Windows\\System32\\where.exe';
const XP_GATE_SCOPE = '@boyingliu01';
const XP_GATE_PKG = 'xp-gate';

let cachedPath = null;
let cachedPkgDir;

/**
 * Run `fn` as if the process were running on `platform`.
 *
 * WHY THIS EXISTS: `process.platform` is frozen at startup, so every Windows
 * branch below (registry PATH, the `where` parser, comspec routing, PATHEXT
 * lookup) was unreachable from Linux and untestable from Windows. The dev box
 * moved to WSL, which would have quietly deleted the only coverage those
 * branches ever had -- the exact way platform code rots.
 *
 * Shadowing the property for the duration of the call keeps the branch decision
 * an argument without changing any call site, and the original descriptor is
 * restored in `finally` so a throwing callback cannot leak a fake platform into
 * the rest of the process.
 */
export function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** The raw `Path` value of one registry environment key, or ''. */
function readRegPath(key) {
  if (!isFile(WIN_REG)) return '';
  const r = spawnSync(WIN_REG, ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (r.status !== 0) return '';
  return parseRegPathLine(r.stdout);
}

/** `    Path    REG_EXPAND_SZ    C:\a;C:\b` -> `C:\a;C:\b` */
function parseRegPathLine(stdout) {
  const line = stripNul(stdout || '').split(/\r?\n/).find((l) => /Path\s+REG_/.test(l));
  const m = line && line.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
  return m ? m[1].trim() : '';
}

/** Split a `;`-separated registry value and expand its `%VAR%` references. */
function expandRegistryPath(chunk) {
  return String(chunk || '')
    .split(';')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => seg.replace(/%([^%]+)%/g, (_, name) => process.env[name] || ''));
}

/**
 * Windows GUI 进程和 Git Bash 的 PATH 经常是陈旧的；工具已安装但看不见。
 * 合并注册表 Machine/User PATH，探测工具时用这份。
 *
 * 从 Git Bash 启动时 node 往往不在 Windows PATH 上；npm 生成的 .cmd shim
 * 内部用 `node` 兜底，缺了它就会报 "'node' is not recognized"。所以 node 所在
 * 目录必须排在第一位。
 */
export function effectivePath() {
  if (cachedPath) return cachedPath;
  const parts = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)];
  if (process.platform === 'win32') {
    for (const key of PATH_KEYS) parts.push(...expandRegistryPath(readRegPath(key)));
  }
  cachedPath = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  return cachedPath;
}

export function envWithPath() {
  return { ...process.env, PATH: effectivePath() };
}

/**
 * Shared spawn options. `run` and `runNpm` used to inline the same nine-field
 * object, so adding a field (or fixing maxBuffer) had to be done twice and one
 * copy was always the copy that got forgotten.
 */
function spawnOpts(opts, defaultTimeout) {
  return {
    cwd: opts.cwd,
    timeout: opts.timeout ?? defaultTimeout,
    stdio: opts.stdio,
    encoding: opts.stdio ? undefined : 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: opts.env ?? envWithPath(),
  };
}

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, spawnOpts(opts, 120000));
}

/**
 * Windows 上直接 spawn .cmd/.bat 会 EINVAL；经 Git Bash 的 shell 执行 .cmd 又因
 * 反斜杠转义失败（现象：工具明明在，probe 拿不到任何输出）。固定走 cmd.exe。
 */
export function probe(cmdPath, args, opts = {}) {
  if (!isWindowsShim(cmdPath)) return run(cmdPath, args, opts);
  const env = opts.env ?? envWithPath();
  const line = `"${cmdPath}" ${args.map((a) => `"${a}"`).join(' ')}`;
  return spawnSync(comspecOf(env), ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true,
    timeout: opts.timeout ?? 15000,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
}

/** The interpreter that runs .cmd shims, honouring an explicit ComSpec. */
function comspecOf(env) {
  return env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
}

export function isWindowsShim(cmdPath) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmdPath);
}

/**
 * `npm-cli.js` next to node, or ''.
 *
 * Both layouts occur: a Node installed from the MSI keeps npm at
 * `<node>/node_modules/npm`, while distro/tarball builds use
 * `<node>/../lib/node_modules/npm`.
 */
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
  return spawnSync(process.execPath, [cli, ...args], spawnOpts(opts, 180000));
}

export function resetPackageDir() {
  cachedPkgDir = undefined;
}

/** Every place a global `@boyingliu01/xp-gate` install can live, in precedence order. */
function packageCandidates() {
  const roots = [];
  const globalRoot = runNpm(['root', '-g'], { timeout: 30000 });
  if (globalRoot.status === 0) roots.push(String(globalRoot.stdout).trim());
  roots.push(path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules'));
  return roots.filter(Boolean).map((base) => path.join(base, XP_GATE_SCOPE, XP_GATE_PKG));
}

export function packageDir() {
  if (cachedPkgDir !== undefined) return cachedPkgDir;
  const override = process.env.XP_GATE_PACKAGE_DIR;
  if (override && isDir(override)) {
    cachedPkgDir = override;
    return cachedPkgDir;
  }
  cachedPkgDir = packageCandidates().find(isDir) || '';
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
const WIN_EXTS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Resolve a bare path the way Windows would: try it, then each PATHEXT entry.
 *
 * Exported so the PATHEXT logic is testable from Linux via `withPlatform`; on
 * non-Windows a missing bare path is simply absent, which is the honest answer.
 */
export function firstExisting(base) {
  if (isFile(base)) return base;
  if (process.platform !== 'win32') return '';
  return WIN_EXTS.map((ext) => base + ext).find(isFile) || '';
}

/**
 * Pick the first runnable path out of `where <tool>` output.
 *
 * `where` prints every match on its own CRLF-terminated line, and on Windows the
 * first one is often npm's extensionless shell shim, which spawnSync cannot
 * execute (ENOENT). So each line is resolved through `firstExisting` and the
 * first that resolves wins. `exists` is injectable so the fall-through is
 * testable from Linux.
 */
export function parseWhichOutput(stdout, exists = firstExisting) {
  const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.map(exists).find(Boolean) || '';
}

export function which(tool) {
  if (process.platform === 'win32') {
    const r = run(WIN_WHERE, [tool], { timeout: PROBE_TIMEOUT_MS });
    if (r.status !== 0) return '';
    return parseWhichOutput(r.stdout);
  }
  const r = run('which', [tool], { timeout: PROBE_TIMEOUT_MS });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/** First non-empty line a tool prints for a version flag. */
function versionLine(resolved) {
  for (const flag of ['--version', '-v', '-V', 'version']) {
    const r = probe(resolved, [flag]);
    const first = stripNul(`${r.stdout || ''}${r.stderr || ''}`)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first) return first;
  }
  return '';
}

export function toolVersion(tool) {
  const resolved = which(tool);
  if (!resolved) return { path: '', version: '' };
  return { path: resolved, version: versionLine(resolved) };
}
