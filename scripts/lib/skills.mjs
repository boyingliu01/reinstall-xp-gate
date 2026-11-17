import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './proc.mjs';
import { copyTree, isDir, isFile, sameTree } from './util.mjs';

export function bundledSkills(pkgDir) {
  if (!pkgDir) return [];
  const dir = path.join(pkgDir, 'skills');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isFile(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/**
 * 每个 agent 根 × 每个发布包 skill 的状态：ok / drift / missing。
 * 只读，不改盘；state 的基准是当前安装的发布包。
 */
export function planSkillCopies(pkgDir, roots) {
  const names = bundledSkills(pkgDir);
  const rows = [];
  for (const root of roots) {
    for (const name of names) {
      const src = path.join(pkgDir, 'skills', name);
      const dest = path.join(root.dir, name);
      let state = 'missing';
      if (isDir(dest)) state = sameTree(src, dest) ? 'ok' : 'drift';
      rows.push({ agent: root.agent, root: root.dir, name, src, dest, state });
    }
  }
  return { names, rows };
}

export function summarizeRows(rows) {
  const byAgent = new Map();
  for (const row of rows) {
    const entry = byAgent.get(row.agent) || { total: 0, ok: 0, drift: 0, missing: 0 };
    entry.total += 1;
    entry[row.state] += 1;
    byAgent.set(row.agent, entry);
  }
  return byAgent;
}

function safeLabel(name) {
  return String(name).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'agent';
}

/**
 * 补齐缺失、覆盖漂移。漂移副本先备份，用户改动不会被静默丢掉。
 * @returns {Array} 实际处理的 row（含 applied / backup）
 */
export function applySkillCopies(rows, { backupRoot, dryRun = false } = {}) {
  const touched = [];
  for (const row of rows) {
    if (row.state === 'ok') continue;
    if (dryRun) {
      touched.push(row);
      continue;
    }
    if (row.state === 'drift' && isDir(row.dest) && backupRoot) {
      row.backup = path.join(backupRoot, safeLabel(row.agent), row.name);
      copyTree(row.dest, row.backup);
    }
    copyTree(row.src, row.dest);
    row.applied = true;
    touched.push(row);
  }
  return touched;
}

export function skillsBackupRoot() {
  return path.join(HOME, '.local', 'share', 'xp-gate', 'skills', '.backups');
}
