import fs from 'node:fs';
import path from 'node:path';
import { HOME, packageDir, runNpm, gitConfig, xpJson } from './proc.mjs';
import { discoverSkillRoots, nativeDelphiAgents } from './agents.mjs';
import { bundledSkills } from './skills.mjs';
import { isFile, readJson, stamp, writeJson } from './util.mjs';

export function runsRoot() {
  return path.join(HOME, '.local', 'share', 'xp-gate', 'reinstall-runs');
}

export function makeRunDir() {
  const dir = path.join(runsRoot(), stamp());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 只复制用户配置，不复制 xp-gate 生成的安装状态。 */
export function snapshotConfig(runDir) {
  const cfgDir = path.join(HOME, '.config', 'xp-gate');
  const copied = [];
  for (const name of ['.delphi-config.json', 'xp-gate.json']) {
    const src = path.join(cfgDir, name);
    if (isFile(src)) {
      fs.copyFileSync(src, path.join(runDir, name));
      copied.push(name);
    }
  }
  return copied;
}

export function collectBaseline() {
  const pkg = packageDir();
  const appConfig = readJson(path.join(HOME, '.config', 'xp-gate', 'xp-gate.json'));
  const delphi = readJson(path.join(HOME, '.config', 'xp-gate', '.delphi-config.json'));
  const doctor = xpJson(['doctor', '--json']);
  const roots = discoverSkillRoots();

  return {
    createdAt: new Date().toISOString(),
    platform: process.platform,
    home: HOME,
    node: process.version,
    nodePath: process.execPath,
    npm: String(runNpm(['-v'], { timeout: 20000 }).stdout || '').trim(),
    xpGate: {
      packageDir: pkg,
      version: pkg ? readJson(path.join(pkg, 'package.json'))?.version || '' : '',
    },
    config: {
      mode: appConfig?.mode || '',
      templateDir: appConfig?.templateDir || '',
      hooksPath: gitConfig('core.hooksPath'),
    },
    delphi: {
      channels: delphi?.channels ?? null,
      pinned_models: delphi?.pinned_models ?? null,
      active_profile: delphi?.active_profile ?? null,
    },
    doctor: doctor.json
      ? { ok: doctor.json.ok, issues: doctor.json.issues, checks: doctor.json.checks }
      : { error: String(doctor.stderr || '').slice(0, 500) },
    agents: roots,
    bundledSkills: bundledSkills(pkg),
    nativeAgents: nativeDelphiAgents(),
  };
}

export function writeBaseline(runDir, baseline) {
  writeJson(path.join(runDir, 'baseline.json'), baseline);
}
