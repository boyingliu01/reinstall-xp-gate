import fs from 'node:fs';
import path from 'node:path';
import { HOME, which } from './proc.mjs';
import { isDir, isFile } from './util.mjs';

const KNOWN_LABELS = {
  '.agents': 'Generic agents',
  '.claude': 'Claude Code',
  '.cline': 'Cline',
  '.codebuddy': 'CodeBuddy',
  '.codex': 'Codex',
  '.config/opencode': 'OpenCode',
  '.dsh': 'DSH',
  '.dws': 'DWS',
  '.pi/agent': 'Pi',
  '.qoder': 'Qoder',
  '.qoder-cn': 'Qoder CN',
  '.trae': 'Trae',
  '.trae-cn': 'Trae CN',
  '.trae-aicc': 'Trae AICC',
  '.workbuddy': 'WorkBuddy',
  'doubaowork': 'Doubao Work',
};

/** xp-gate 的 installer 本身认识的平台；其余 agent 由本脚本直接复制。 */
export const OFFICIAL_ROOTS = new Set([
  '.qoder/skills',
  '.claude/skills',
  '.config/opencode/skills',
  '.dsh/skills',
]);

/** 桌面/IDE 安装目录：存在即说明 agent 还在用（配置目录卸载后常残留）。 */
const APP_PROBES = {
  Qoder: ['AppData/Local/Programs/Qoder', 'AppData/Local/Qoder'],
  'Qoder CN': ['AppData/Local/Qoder CN'],
  Trae: ['AppData/Local/Programs/Trae'],
  'Trae CN': ['AppData/Local/Programs/Trae CN', 'AppData/Local/Programs/TRAE SOLO CN'],
  WorkBuddy: ['AppData/Local/WorkBuddy', 'AppData/Local/@genieworkbuddy-desktop-updater'],
  CodeBuddy: ['AppData/Local/CodeBuddyExtension'],
  'Doubao Work': ['AppData/Local/DoubaoWork'],
};

/** CLI 类 agent：能从合并后的 PATH 解析到可执行文件才算还活着。 */
const CLI_PROBES = {
  'Claude Code': 'claude',
  Codex: 'codex',
  OpenCode: 'opencode',
  Cline: 'cline',
  CodeBuddy: 'codebuddy',
  DSH: 'dsh',
  DWS: 'dws',
  Pi: 'pi',
};

/** 多 agent 共用的技能仓库，不是某个 agent 的配置目录。 */
const SHARED_ROOTS = new Set(['.agents/skills']);
const cliCache = new Map();

const BACKUP_RE = /(^|[\\/])[^\\/]*(backup|bak|old|archive|snapshot|migration)[^\\/]*([\\/]|$)/i;
const SKIP_RE = /(^|[\\/])(node_modules|\.git|\.pnpm|skills-marketplace|connectors)([\\/]|$)/i;

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 空目录也算：新装的 agent 常常先建好 skills/ 但还没有内容，恰恰是最需要分发的地方。
 * 路径本身已由三条固定模式产生，不会误扫用户数据目录。
 */
function looksLikeSkillRoot(dir) {
  return isDir(dir);
}

export function labelFor(skillRoot) {
  const rel = path.relative(HOME, skillRoot).split(path.sep).join('/');
  const base = rel.replace(/\/skills$/, '');
  return KNOWN_LABELS[base.toLowerCase()] || base.replace(/^\./, '').replace(/[/-]+/g, ' ');
}

export function isOfficialSkillRoot(skillRoot) {
  const rel = path.relative(HOME, skillRoot).split(path.sep).join('/');
  return OFFICIAL_ROOTS.has(rel);
}

function agentHomeFor(skillRoot) {
  const parts = path.relative(HOME, skillRoot).split(path.sep);
  if (parts[0] === '.config' && parts.length > 2) return path.join(HOME, parts[0], parts[1]);
  return path.join(HOME, parts[0]);
}

/**
 * 三级判活的证据之一：桌面/IDE 安装目录存在即说明 agent 还在用。
 * @returns {string} 命中的绝对路径，未命中返回空串
 */
function appEvidence(agent) {
  for (const relApp of APP_PROBES[agent] || []) {
    const abs = path.join(HOME, relApp);
    if (isDir(abs)) return abs;
  }
  return '';
}

/**
 * 证据之二：CLI 能从合并后的 PATH 解析到。结果进缓存，因为 discoverSkillRoots
 * 会对同一批 agent 反复调用，每次都 spawn 一次 where.exe 很慢。
 * @returns {string} 可执行文件路径，未命中返回空串
 */
function cliEvidence(agent) {
  const cli = CLI_PROBES[agent];
  if (!cli) return '';
  if (!cliCache.has(cli)) cliCache.set(cli, which(cli));
  return cliCache.get(cli);
}

/**
 * 证据之三：agent 配置目录近 N 天有写入。DSH 这类二进制不在 PATH 上的情况
 * 只能靠它兜底。
 * @returns {number} 距今天数；目录不可读时返回 Infinity
 */
function idleDays(skillRoot) {
  let mtime = 0;
  try {
    mtime = fs.statSync(agentHomeFor(skillRoot)).mtimeMs;
  } catch {
    /* 目录不可读按残留处理 */
  }
  return mtime ? Math.floor((Date.now() - mtime) / 86400000) : Infinity;
}

/**
 * 目录存在 ≠ agent 还在用：卸载后配置目录与 skills/ 会长期残留。
 * 判活按「桌面安装目录 > CLI 可解析 > 配置目录近 N 天有写入」三级证据依次
 * 短路，三级都不成立才判为残留。
 */
export function probeLiveness(entry, liveDays = 30) {
  const rel = path.relative(HOME, entry.dir).split(path.sep).join('/');
  if (SHARED_ROOTS.has(rel)) return { live: true, reason: 'shared skill store' };

  const app = appEvidence(entry.agent);
  if (app) return { live: true, reason: `app: ${app}` };

  const cli = cliEvidence(entry.agent);
  if (cli) return { live: true, reason: `cli: ${cli}` };

  const days = idleDays(entry.dir);
  if (days <= liveDays) return { live: true, reason: `active ${days}d ago` };
  return { live: false, reason: `no app/cli, idle ${Number.isFinite(days) ? `${days}d` : 'unknown'}` };
}

/**
 * 扫描规则只依赖「<root>/<name>/SKILL.md」这个通用约定：
 *  - ~/<dir>/skills
 *  - ~/<dir>/agent/skills
 *  - ~/.config/<dir>/skills
 * 新 agent 不需要改代码；备份目录与 marketplace/connectors 自动排除。
 */
export function discoverSkillRoots({ liveDays = 30 } = {}) {
  const found = new Map();
  const add = (dir) => {
    const abs = path.resolve(dir);
    if (found.has(abs)) return;
    if (BACKUP_RE.test(abs) || SKIP_RE.test(abs)) return;
    if (!looksLikeSkillRoot(abs)) return;
    const entry = { agent: labelFor(abs), dir: abs, official: isOfficialSkillRoot(abs) };
    found.set(abs, { ...entry, ...probeLiveness(entry, liveDays) });
  };

  for (const entry of safeReaddir(HOME)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const base = path.join(HOME, entry.name);
    add(path.join(base, 'skills'));
    add(path.join(base, 'agent', 'skills'));
  }

  const configDir = path.join(HOME, '.config');
  for (const entry of safeReaddir(configDir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    add(path.join(configDir, entry.name, 'skills'));
  }

  return [...found.values()].sort((a, b) => a.agent.localeCompare(b.agent, 'en'));
}

/** Qoder 原生 Delphi agent（external-only 下应为 0）。 */
export function nativeDelphiAgents() {
  const out = [];
  for (const agentsDir of [
    path.join(HOME, '.qoder', 'agents'),
    path.join(HOME, '.qoder-cn', 'agents'),
  ]) {
    for (const entry of safeReaddir(agentsDir)) {
      if (entry.isFile() && /^delphi-.*\.md$/i.test(entry.name)) {
        out.push(path.join(agentsDir, entry.name));
      }
    }
  }
  return out;
}

/** 每个 agent 可能存在的本地 hooks 模板目录。 */
export function hookTemplateDirs(roots) {
  const dirs = new Set();
  for (const root of roots) {
    dirs.add(path.join(path.dirname(root.dir), 'git-hooks-template'));
  }
  dirs.add(path.join(HOME, '.qoder', 'git-hooks-template'));
  dirs.add(path.join(HOME, '.config', 'opencode', 'git-hooks-template'));
  return [...dirs].filter(isDir);
}
