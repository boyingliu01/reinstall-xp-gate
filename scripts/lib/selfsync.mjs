import path from 'node:path';
import { HOME } from './proc.mjs';
import { copyTree, isDir, isFile, pruneBackups, sameTree, stamp } from './util.mjs';

const SKILL_NAME = 'reinstall-xp-gate';

/** The canonical copy installed by `install.mjs`, or this script's own tree. */
export function defaultSource(selfDir) {
  const canonical = path.join(HOME, '.local', 'share', 'xp-gate', 'skills', SKILL_NAME);
  if (isDir(canonical) && isFile(path.join(canonical, 'SKILL.md'))) return canonical;
  return selfDir;
}

export function backupDirFor(agent) {
  const label = String(agent).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'agent';
  return path.join(HOME, '.local', 'share', 'xp-gate', 'skills', '.backups', `${label}-${stamp()}`);
}

/** What would have to happen to bring one agent root up to date. */
function stateFor(source, dest) {
  if (!isDir(dest)) return 'new';
  return sameTree(source, dest) ? 'ok' : 'update';
}

function syncOne(source, root, dryRun) {
  const dest = path.join(root.dir, SKILL_NAME);
  if (path.resolve(dest) === path.resolve(source)) {
    return { agent: root.agent, dir: root.dir, dest, state: 'source' };
  }
  const state = stateFor(source, dest);
  if (state !== 'ok' && !dryRun) {
    if (state === 'update') {
      const backup = backupDirFor(root.agent);
      copyTree(dest, backup);
      // Bound the set this very line just grew: without this the directory keeps
      // one copy of the skill per install, forever.
      pruneBackups(path.dirname(backup));
    }
    copyTree(source, dest);
  }
  return { agent: root.agent, dir: root.dir, dest, state };
}

/**
 * 把本 skill 复制到每个 agent 的 skills 根。副本彼此独立、可单独运行。
 * 只覆盖内容不同的副本，并在覆盖前备份。
 */
export function syncSelf({ source, roots, dryRun = false }) {
  return roots.map((root) => syncOne(source, root, dryRun));
}
