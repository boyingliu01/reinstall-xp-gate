import fs from 'node:fs';
import path from 'node:path';
import { hashTree, isDir, isFile, listFiles, rmrf } from './util.mjs';

/** 标记扫描上限：避免一个巨大的第三方目录拖住卸载流程。 */
export const MARKER_SCAN_LIMIT = 300;

const XP_GATE_MARKER = /xp-gate/i;

/**
 * 备份再删除：xp-gate 的 purge 会整目录删用户配置，所有破坏性动作必须先留证据。
 * 单文件走 copyFile，目录走整树复制。
 *
 * 抽成独立模块的原因是可测性：调用方是顶层立即执行的脚本，逻辑写错没有任何
 * 东西能拦住，而这里每个分支都在删用户文件。
 */
export function backupThenRemove(abs, runDir, label, isFileEntry = false) {
  const dest = path.join(runDir, 'residue', label);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isFileEntry) fs.copyFileSync(abs, dest);
  else fs.cpSync(abs, dest, { recursive: true, force: true });
  rmrf(abs);
}

/** 目录内任意文件含 xp-gate 标记才算我们的产物，避免误删同名的用户目录。 */
export function hasXpGateMarker(dir) {
  return listFiles(dir).slice(0, MARKER_SCAN_LIMIT).some((rel) => fileHasMarker(path.join(dir, rel)));
}

function fileHasMarker(abs) {
  try {
    return XP_GATE_MARKER.test(fs.readFileSync(abs, 'utf8'));
  } catch {
    /* 二进制/无权限文件跳过 */
    return false;
  }
}

/**
 * 对比旧发布包哈希，把 agent 目录里的 skill 副本分成「逐字节一致（可删）」
 * 与「用户改过（保留并备份）」两类。hashFn 可注入，便于测试。
 */
export function scanSkillResidue(roots, oldHashes, hashFn = hashTree) {
  const classified = roots.flatMap((root) => safeReaddir(root.dir)
    .map((entry) => classifyCopy(root, entry, oldHashes, hashFn))
    .filter(Boolean));
  return {
    identical: classified.filter((h) => h.same).map((h) => h.row),
    modified: classified.filter((h) => !h.same).map((h) => h.row),
  };
}

/**
 * One directory in an agent skills root, classified against the old package.
 *
 * Returns null for anything that is not a directory we shipped: a name absent
 * from `oldHashes` is a user's own skill and must never be classified, let alone
 * deleted. This check happens BEFORE hashing so an unrelated tree is never read.
 */
function classifyCopy(root, entry, oldHashes, hashFn) {
  if (!entry.isDirectory() || !oldHashes.has(entry.name)) return null;
  const dir = path.join(root.dir, entry.name);
  return {
    same: hashFn(dir) === oldHashes.get(entry.name),
    row: { agent: root.agent, dir, name: entry.name },
  };
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 发布包内每个 skill 目录的内容哈希，供 pruneDeadRoots 逐字节比对。 */
export function contentHashes(pkg) {
  const map = new Map();
  for (const name of skillNames(path.join(pkg, 'skills'))) {
    map.set(name, hashTree(path.join(pkg, 'skills', name)));
  }
  return map;
}

/** Subdirectories of `<pkg>/skills` that actually contain a SKILL.md. */
function skillNames(dir) {
  return safeReaddir(dir)
    .filter((entry) => entry.isDirectory() && isFile(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name);
}

/**
 * install-skill 只看目录是否存在，会把 skill 写进已卸载 agent 的残留目录。
 * 这里只删与发布包逐字节一致的副本；用户改过的副本保持原样。
 */
export function pruneDeadRoots(pkg, deadRoots, hashFn = hashTree, remove = rmrf) {
  const content = contentHashes(pkg);
  return deadRoots.reduce((sum, root) => sum + pruneRoot(root, content, hashFn, remove), 0);
}

/** Delete the byte-identical copies in one agent root; leave edited ones. */
function pruneRoot(root, content, hashFn, remove) {
  const matched = [...content].filter(([name, expected]) => isIdenticalCopy(path.join(root.dir, name), expected, hashFn));
  matched.forEach(([name]) => remove(path.join(root.dir, name)));
  return matched.length + (removeStraySelfCopy(root.dir, remove) ? 1 : 0);
}

/** Only an exact match on BOTH existence and content is ours to delete. */
function isIdenticalCopy(dest, expected, hashFn) {
  return isDir(dest) && hashFn(dest) === expected;
}

/**
 * The skill's own copy is NOT part of the published package, so it is absent
 * from `contentHashes` and would survive the loop above. `install.mjs` writes it
 * into every agent root it can see, including ones already judged dead.
 */
function removeStraySelfCopy(rootDir, remove) {
  const selfCopy = path.join(rootDir, 'xp-gate-reinstall');
  if (!isFile(path.join(selfCopy, 'SKILL.md'))) return false;
  remove(selfCopy);
  return true;
}
