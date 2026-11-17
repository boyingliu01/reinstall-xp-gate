import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './proc.mjs';
import { copyTree, isDir, isFile, sameTree, stamp } from './util.mjs';

export function defaultSource(selfDir) {
  const canonical = path.join(HOME, '.local', 'share', 'xp-gate', 'skills', 'xp-gate-reinstall');
  if (isDir(canonical) && isFile(path.join(canonical, 'SKILL.md'))) return canonical;
  return selfDir;
}

function backupDirFor(agent) {
  const label = String(agent).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'agent';
  return path.join(HOME, '.local', 'share', 'xp-gate', 'skills', '.backups', `${label}-${stamp()}`);
}

/**
 * 把本 skill 复制到每个 agent 的 skills 根。副本彼此独立、可单独运行。
 * 只覆盖内容不同的副本，并在覆盖前备份。
 */
export function syncSelf({ source, roots, dryRun = false }) {
  const results = [];
  for (const root of roots) {
    const dest = path.join(root.dir, 'xp-gate-reinstall');
    if (path.resolve(dest) === path.resolve(source)) {
      results.push({ agent: root.agent, dir: root.dir, dest, state: 'source' });
      continue;
    }
    let state = 'new';
    if (isDir(dest)) state = sameTree(source, dest) ? 'ok' : 'update';
    if (state !== 'ok' && !dryRun) {
      if (state === 'update') copyTree(dest, backupDirFor(root.agent));
      copyTree(source, dest);
    }
    results.push({ agent: root.agent, dir: root.dir, dest, state });
  }
  return results;
}
