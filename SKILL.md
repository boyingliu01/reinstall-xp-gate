---
name: xp-gate-reinstall
version: 1.0.0
description: >
  跨 agent 全新重装 xp-gate：快照用户配置 → 用 xp-gate 命令卸载并清理历史残留 →
  安装 npm 最新版 → 依赖工具升级到可达最新 → 逐 agent 校验 skill、插件、钩子真实生效。
  当用户说「重装 xp-gate」「升级 xp-gate」「全新安装」「清理 xp-gate 旧版残留」
  「确保门禁真实有效」，或换了 agent/机器要重新部署 xp-gate 时使用。
---

# XP-Gate Reinstall

本 skill 是 xp-gate 自身的**生命周期维护**，不随 xp-gate 发布包分发，因为它要在
`uninstall --purge` 之后仍然存在。事实源（canonical）：

```
~/.local/share/xp-gate/skills/xp-gate-reinstall/
```

其他 agent 的 skills 目录里是**独立副本**，由 `scripts/install.mjs` 同步；每个副本
自带脚本，可单独运行。

## 三条硬规则

1. **只用 xp-gate 自己的命令完成卸载/安装/分发**。不 `git clone`，不手改安装目录里的文件，
   不凭记忆写死子命令——每阶段先跑 `xp-gate --help` / `xp-gate doctor --json` 发现当前版本，
   结构变了按当前版本执行并在报告里写明差异。
2. **先快照，再卸载**。`--purge` 会整目录删除 `~/.config/xp-gate/`，连普通卸载标记为
   「用户数据」的 `.delphi-config.json` 一起删。没有外部快照就没有回滚，而且会重新打开
   native Delphi 通道。
3. **失败即停**。不带着失败继续下一步；禁止为了让检查变绿去改证据或改配置。

## 为什么不能只跑两条命令

以下行为按当前 0.37.2 的实现核对过，每次执行仍要复核（上游可能已修）：

| 陷阱 | 实际行为 | 补偿动作 |
|---|---|---|
| `xp-gate install` 退出码 | 即使 doctor 报问题也返回 0 | 用 `scripts/verify.mjs` 验收，不看退出码 |
| `--purge` 与用户配置 | `rmSync(~/.config/xp-gate)`，`.delphi-config.json` 一起消失 | preflight 外部快照，安装前恢复 |
| `uninstall` 与 skill | 0.37.2 里 `planSkillRemovals` 只有定义、无调用点，所有 agent 的 skill 副本都留下 | 对比旧发布包逐字节清理；改动过的副本保留并备份 |
| `uninstall` 与 Qoder 模板 | 只硬编码清理 opencode 的 `git-hooks-template` | 清理其他 agent 的同名目录（先验证含 xp-gate 标记） |
| `uninstall` 与 npm 包 | 只反向执行 init，不删全局包 | 显式 `npm uninstall -g` |
| `bootstrap` / `install-tools` | 只补缺失，不升级 | 单独查最新版并升级 |
| `update-skill --all` | 只更新「已部署过」的 skill，补不了缺失项 | 缺失/漂移项逐个 `install-skill <name> --force` |
| 非官方 agent | CLI 只认 qoder/claude/opencode/dsh | Trae/WorkBuddy/CodeBuddy/Codex/Cline/DWS/Pi 等直接按目录复制 |
| PATH 陈旧 | 工具已安装但当前进程 PATH 看不到，doctor 报 Not found | 脚本从注册表合并 PATH 后再探测；必要时 `xp-gate doctor --refresh-env` |

## 运行方式

在任意 agent 里（命令里的 `<skill>` 指本 skill 目录）：

```bash
node "<skill>/scripts/install.mjs" --dry-run   # 看会同步到哪些 agent
node "<skill>/scripts/install.mjs"             # 同步到所有已识别的 agent skills 根
node "<skill>/scripts/preflight.mjs"           # 只读基线：快照配置 + 记录版本/doctor/agent 清单
node "<skill>/scripts/reinstall.mjs"           # 默认 dry-run，打印完整计划
node "<skill>/scripts/reinstall.mjs" --apply   # 真正执行
node "<skill>/scripts/verify.mjs"              # 验收，FAIL 时退出码 1
```

常用参数：

| 脚本 | 参数 | 作用 |
|---|---|---|
| install | `--dry-run` | 只打印每个 agent 的 live/new/update/ok/source，不改盘 |
| install | `--include-all` | 连判定为残留的配置目录也分发（默认跳过） |
| preflight | `--dry-run` | 不写 run 目录，只打印基线 |
| reinstall | `--apply` | 默认 dry-run；加它才执行卸载/安装 |
| reinstall | `--upgrade-tools` | 同时把 npm/pip 系门禁工具升到最新（二进制工具只提示） |
| reinstall | `--clean-project-hooks` | 删除当前仓库 `.git/hooks` 里含 xp-gate 标记的钩子（默认保留） |
| reinstall | `--no-verify` | 跳过最后的 verify（不推荐） |
| verify | `--quick` | 跳过网络探测（npm latest / PyPI / GitHub）与工具版本比对 |
| verify | `--json` | 输出机器可读结果 |

退出码：`reinstall` 只有在中止或 verify FAIL 时非 0；`verify` 有任一 FAIL 即返回 1。

Windows 下若 `node` 不在 PATH，用 `"/c/Program Files/nodejs/node.exe"` 加 Windows 形式
绝对路径调用（Git Bash 的 `/d/...` 会被 MSYS 转换）。

产物目录：`~/.local/share/xp-gate/reinstall-runs/<时间戳>/`
（`.delphi-config.json` 快照、`baseline.json`、`residue/` 里卸载前备份的 skill/模板/钩子）。
该目录在 xp-gate 管理面之外，purge 不会删。

## 六个阶段与验收

| 阶段 | 动作 | 通过标准 |
|---|---|---|
| 0 快照 | 版本三件套、`doctor --json`、hooksPath、`.delphi-config.json` 外部快照 | 快照文件存在且非空 |
| 1 卸载 | `uninstall --global --purge`；补清 skill 副本 / `git-hooks-template` / 项目钩子；`npm uninstall -g` | 配置目录、`.uninstall-backup`、旧 skill 副本均不存在 |
| 2 安装 | 恢复 `.delphi-config.json` → `npm i -g @latest` → `install --global` → `update-hooks --global` | 安装版本 = registry latest；`mode=global` |
| 3 工具 | 解析真实 PATH，比对 jscpd/lizard/checkov/hadolint/gitleaks/semgrep/npx/jq | 全部存在；npm/pip 系可达最新；二进制无法判定时标 UNVERIFIED |
| 4 skill | 发布包 `skills/*` 为唯一事实源，逐个 agent 比对 | 每个 agent 根下集合 = 发布包集合，内容哈希一致 |
| 5 插件 | Qoder 钩子、OpenCode 包、DSH profile 包、Claude 插件（如启用） | 版本 = CLI 版本；Qoder 原生 `delphi-*.md` 数量为 0 |
| 6 行为 | `doctor`、`doctor delphi`、临时 repo 真实提交、`delphi-review` 冒烟 | 无 FAIL；SKIP 有解释；pre-commit 真被触发 |

`verify.mjs` 覆盖 0–5 与 6 的静态部分；**真实提交**和 **delphi 冒烟**必须人工做一次，
因为它们会产生副作用（提交、外部模型调用），脚本不代劳。

## 多 agent 矩阵

**只扫描「目录存在」会把已卸载的 agent 算进来**——配置目录和 `skills/` 在卸载后
通常原样保留（实测本机 15 个目录里 4 个是 79–271 天没动过的残留）。因此每个根都做
活性判定，三级证据依次为：

1. **桌面/IDE 安装目录存在**（Qoder CN、Trae CN、WorkBuddy、CodeBuddy、Doubao Work 等）；
2. **CLI 能从合并后的 PATH 解析到**（`opencode`、`dws`、`claude`、`codex`、`pi`、`dsh` 等）；
3. **agent 配置目录近 30 天有写入**（DSH 这类二进制不在 PATH 上的情况靠它兜底）。

`.agents/skills` 是多个 agent 共用的技能仓库（`skill-lock.json` 由技能安装器维护），
单独标记为 shared，不算 agent。判定为残留的根默认不分发；`verify` 只把它们列为 WARN，
不计入 skills 一致性。`--include-all` 可强制分发。

已知 agent 与集成方式：

| Agent | skills 根 | xp-gate 集成 |
|---|---|---|
| Qoder / Qoder CN | `~/.qoder/skills`、`~/.qoder-cn/skills` | 全局 hooks + skills；external-only 下不部署 agents |
| OpenCode | `~/.config/opencode/skills` | skills + `@boyingliu01/opencode-plugin` |
| DSH | `~/.dsh/skills` | skills + profile 里的 `@boyingliu01/dsh-plugin-xp-gate` |
| DWS | `~/.dws/skills` | skills |
| Trae CN | `~/.trae-cn/skills` | skills（CLI 不认，脚本直接分发） |
| WorkBuddy | `~/.workbuddy/skills` | skills（同上） |
| CodeBuddy / Doubao Work / Pi | 各自 `skills` 根 | skills（同上） |
| 共享仓库 | `~/.agents/skills` | shared，多 agent 的符号链接指向这里 |

新 agent 只要遵守 `<root>/<name>/SKILL.md` 约定，把根目录放进扫描范围即可，脚本无需改。

**本 skill 不删除残留的 agent 目录**：这些目录里有用户数据（`.dsh/sessions`、
`.dws/token.json`、`.codex/*.sqlite`、Cline 的 `secrets.json`）和共享技能符号链接，
批量删除属于另一个工具的职责。`reinstall` 只做两件事：不分发、以及清掉
`install-skill` 因「目录存在」而误写入残留目录的副本（逐字节比对后才删）。

## 维护

- 改内容只改 canonical 一处，再跑 `install.mjs` 同步；不要在某个 agent 副本里单独改。
- 上游修掉某个陷阱后，删掉 SKILL.md 表格与脚本里对应的补偿分支，并在提交信息里注明。
- 本 skill 不属于 xp-gate 发布包；`xp-gate uninstall` 和 `update-skill --all` 都不会碰它。
