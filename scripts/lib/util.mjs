import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', '.svn']);

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function isFile(p) {
  return Boolean(statOrNull(p)?.isFile());
}

export function isDir(p) {
  return Boolean(statOrNull(p)?.isDirectory());
}

/** `readdir` that treats an unreadable directory as empty instead of throwing. */
function dirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function subdirsOf(dir) {
  return dirents(dir)
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => path.join(dir, e.name));
}

function filesIn(dir, base) {
  return dirents(dir)
    .filter((e) => e.isFile() && !SKIP_DIRS.has(e.name))
    .map((e) => path.relative(base, path.join(dir, e.name)).split(path.sep).join('/'));
}

/** Depth-first over every readable directory below `root`. */
function walkDirs(root) {
  const stack = [root];
  const seen = [];
  while (stack.length) {
    const dir = stack.pop();
    seen.push(dir);
    stack.push(...subdirsOf(dir));
  }
  return seen;
}

/**
 * Recursive relative-path listing, POSIX-separated and sorted.
 *
 * Iterative rather than recursive on purpose: the recursive version counted
 * itself as one more cyclomatic branch per level and had to be reasoned about
 * for stack depth on the deep trees this tool walks (`~/.local/share`).
 */
export function listFiles(root, base = root, out = []) {
  for (const dir of walkDirs(root)) out.push(...filesIn(dir, base));
  return out.sort();
}

export function hashTree(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of listFiles(dir)) {
    h.update(rel);
    h.update('\0');
    try {
      h.update(fs.readFileSync(path.join(dir, rel)));
    } catch {
      return '';
    }
    h.update('\0');
  }
  return h.digest('hex');
}

export function sameTree(a, b) {
  if (!isDir(a) || !isDir(b)) return false;
  const fa = listFiles(a);
  const fb = listFiles(b);
  if (fa.length !== fb.length) return false;
  if (fa.some((f, i) => f !== fb[i])) return false;
  return hashTree(a) === hashTree(b);
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function copyTree(src, dest) {
  rmrf(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}

export function stamp(date = new Date()) {
  const part = (n) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}`;
  const hms = `${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
  return `${ymd}-${hms}`;
}

export function stripNul(value) {
  return String(value ?? '').replace(/\0/g, '');
}

/**
 * How many backups to keep per label. Three is enough to undo the last few
 * installs and small enough that the directory cannot grow without bound.
 */
export const BACKUP_KEEP = 3;

/**
 * Delete all but the newest `keep` stamp-suffixed entries under `root`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every `install.mjs` run backs up the copy it is about to overwrite, and
 * nothing ever removed those backups. Measured on this machine before the
 * policy existed: 50 backups / 11 MB, dating back to v1.1.0, growing by one
 * set per install. Unbounded maintenance state is a slow leak the installer
 * itself creates, so the installer has to bound it.
 *
 * Only entries that parse as `<label>-YYYYMMDD-HHMMSS` are candidates: an
 * unrelated directory an operator put there is never touched, and a directory
 * this function does not recognise cannot be deleted by accident. Sorting is
 * by the timestamp IN THE NAME rather than mtime, because a restored or copied
 * directory carries an mtime that says nothing about which backup is newer.
 *
 * The cap is PER LABEL, not for the directory as a whole. One `install.mjs`
 * run backs up all nine agent copies with the same timestamp, so a single
 * global cap of 3 would delete six of the backups that run had just written --
 * the retain count would be consumed by simultaneity rather than by history,
 * and rolling back one agent would be impossible while its siblings survived.
 *
 * @returns {string[]} the directory names that were removed
 */
export function pruneBackups(root, keep = BACKUP_KEEP) {
  if (!isDir(root) || keep < 1) return [];
  const doomed = [...groupByLabel(root).values()].flatMap((names) => names.slice(keep));
  for (const name of doomed) rmrf(path.join(root, name));
  return doomed;
}

/**
 * Group stamped backup directories by agent label, each list newest first.
 *
 * Unrecognised directories are absent from the result rather than collected
 * into an "unknown" bucket: this function decides what gets deleted, so a name
 * it does not understand has to mean "leave it alone".
 * @returns {Map<string, string[]>}
 */
function groupByLabel(root) {
  const groups = new Map();
  for (const name of stampedNames(root)) {
    const label = name.slice(0, -STAMP_LEN);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(name);
  }
  for (const [label, names] of groups) groups.set(label, names.sort((a, b) => STAMP_TAIL(b).localeCompare(STAMP_TAIL(a))));
  return groups;
}

/** Names of the immediate subdirectories that carry a backup stamp. */
function stampedNames(root) {
  return dirents(root)
    .filter((d) => d.isDirectory() && STAMPED.test(d.name))
    .map((d) => d.name);
}

/** `<label>-YYYYMMDD-HHMMSS`; the label may itself contain dashes. */
const STAMPED = /-\d{8}-\d{6}$/;

/** Length of `-YYYYMMDD-HHMMSS`, i.e. the stamp plus its leading dash. */
const STAMP_LEN = 15;

/** The sortable timestamp at the end of a stamped directory name. */
function STAMP_TAIL(name) {
  return String(name).slice(-STAMP_LEN);
}
