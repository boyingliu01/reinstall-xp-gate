import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', '.svn']);

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listFiles(root, base = root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) listFiles(abs, base, out);
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
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
  const pad = (n) => String(n).padStart(2, '0');
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-');
}

export function stripNul(value) {
  return String(value ?? '').replace(/\0/g, '');
}
