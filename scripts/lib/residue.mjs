import fs from 'node:fs';
import path from 'node:path';
import { hashTree, isDir, isFile, listFiles, rmrf } from './util.mjs';

/** 标记扫描上限：避免一个巨大的第三方目录拖住卸载流程。 */
export const MARKER_SCAN_LIMIT = 300;

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
  if (isFileEntry) {
    fs.copyFileSync(abs, dest);
  } else {
    fs.cpSync(abs, dest, { recursive: true, force: true });
  }
  rmrf(abs);
}

/** 目录内任意文件含 xp-gate 标记才算我们的产物，避免误删同名的用户目录。 */
export function hasXpGateMarker(dir) {
  for (const rel of listFiles(dir).slice(0, MARKER_SCAN_LIMIT)) {
    try {
      if (/xp-gate/i.test(fs.readFileSync(path.join(dir, rel), 'utf8'))) return true;
    } catch {
      /* 二进制/无权限文件跳过 */
    }
  }
  return false;
}

/**
 * 对比旧发布包哈希，把 agent 目录里的 skill 副本分成「逐字节一致（可删）」
 * 与「用户改过（保留并备份）」两类。hashFn 可注入，便于测试。
 */
export function scanSkillResidue(roots, oldHashes, hashFn = hashTree) {
  const identical = [];
  const modified = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dest = path.join(root.dir, entry.name);
      const oldHash = oldHashes.get(entry.name);
      if (!oldHash) continue;
      const bucket = hashFn(dest) === oldHash ? identical : modified;
      bucket.push({ agent: root.agent, dir: dest, name: entry.name });
    }
  }
  return { identical, modified };
}

/** 发布包内每个 skill 目录的内容哈希，供 pruneDeadRoots 逐字节比对。 */
export function contentHashes(pkg) {
  const dir = path.join(pkg, 'skills');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(dir, entry.name);
    if (!isFile(path.join(abs, 'SKILL.md'))) continue;
    map.set(entry.name, hashTree(abs));
  }
  return map;
}

/**
 * install-skill 只看目录是否存在，会把 skill 写进已卸载 agent 的残留目录。
 * 这里只删与发布包逐字节一致的副本；用户改过的副本保持原样。
 */
export function pruneDeadRoots(pkg, deadRoots, hashFn = hashTree, remove = rmrf) {
  const content = contentHashes(pkg);
  let removed = 0;
  for (const root of deadRoots) {
    for (const [name, expected] of content) {
      const dest = path.join(root.dir, name);
      if (isDir(dest) && hashFn(dest) === expected) {
        remove(dest);
        removed += 1;
      }
    }
    const selfCopy = path.join(root.dir, 'xp-gate-reinstall');
    if (isFile(path.join(selfCopy, 'SKILL.md'))) {
      remove(selfCopy);
      removed += 1;
    }
  }
  return removed;
}
