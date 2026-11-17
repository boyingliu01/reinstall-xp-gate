# xp-gate-reinstall

一个 **agent skill**：在任意 agent（DSH / Claude Code / OpenCode / Qoder / Trae / WorkBuddy / CodeBuddy / Codex / DWS / Pi …）
上全新重装 **xp-gate**，并验证门禁**真实生效**，而不是只看命令退出码。

## 为什么需要它

`xp-gate install` 即使 doctor 报问题也返回 0；`uninstall --purge` 会连用户配置
（`.delphi-config.json`）一起删除；旧版 `uninstall` 留下的 skill 副本、Qoder 钩子模板、
npm 全局包都不会被清掉。**只跑两条命令会得到一个「看起来装好、实际门禁失效」的环境。**

本 skill 把这些坑固化成 6 个阶段 + 逐 agent 验收。

## 六阶段

| 阶段 | 动作 | 通过标准 |
|---|---|---|
| 0 快照 | 版本三件套、`doctor --json`、hooksPath、`.delphi-config.json` 外部快照 | 快照存在且非空 |
| 1 卸载 | `uninstall --global --purge`；补清 skill 副本 / 钩子模板 / 项目钩子；`npm uninstall -g` | 残留目录均不存在 |
| 2 安装 | 恢复配置 → `npm i -g @latest` → `install --global` → `update-hooks --global` | 安装版本 = registry latest |
| 3 工具 | 解析真实 PATH，比对 jscpd/lizard/checkov/hadolint/gitleaks/semgrep 等 | 全部存在；npm/pip 系可达最新 |
| 4 skill | 发布包 `skills/*` 为唯一事实源，逐 agent 比对 | 集合与内容哈希一致 |
| 5 插件 | Qoder 钩子、OpenCode 包、DSH profile 包、Claude 插件 | 版本 = CLI 版本 |
| 6 行为 | `doctor`、临时 repo 真实提交、`delphi-review` 冒烟 | 无 FAIL；pre-commit 真被触发 |

## 用法

```bash
node scripts/install.mjs --dry-run     # 看会同步到哪些 agent
node scripts/install.mjs               # 同步到所有已识别的 agent skills 根
node scripts/preflight.mjs             # 只读基线：快照配置 + 记录版本/doctor/agent 清单
node scripts/reinstall.mjs             # 默认 dry-run，打印完整计划
node scripts/reinstall.mjs --apply     # 真正执行
node scripts/verify.mjs                # 验收，FAIL 时退出码 1
```

常用参数：

| 脚本 | 参数 | 作用 |
|---|---|---|
| install | `--dry-run` | 只打印每个 agent 的 live/new/update/ok/source，不改盘 |
| install | `--include-all` | 连判定为残留的配置目录也分发（默认跳过） |
| preflight | `--dry-run` | 不写 run 目录，只打印基线 |
| reinstall | `--apply` | 默认 dry-run；加它才执行卸载/安装 |
| reinstall | `--upgrade-tools` | 同时把 npm/pip 系门禁工具升到最新 |
| reinstall | `--clean-project-hooks` | 删除当前仓库 `.git/hooks` 里含 xp-gate 标记的钩子 |
| reinstall | `--no-verify` | 跳过最后的 verify（不推荐） |
| verify | `--quick` | 跳过网络探测与工具版本比对 |
| verify | `--json` | 输出机器可读结果 |

产物目录：`~/.local/share/xp-gate/reinstall-runs/<时间戳>/`（配置快照、`baseline.json`、卸载前备份的 `residue/`）。
该目录在 xp-gate 管理面之外，purge 不会删。

## 安装到 agent

SKILL.md 使用的约定是 `<root>/<name>/SKILL.md`。把本仓库放到对应根下即可：

| Agent | skills 根 |
|---|---|
| DSH | `~/.dsh/skills` |
| Claude Code | `~/.claude/skills` |
| OpenCode | `~/.config/opencode/skills` |
| Qoder / Qoder CN | `~/.qoder/skills` / `~/.qoder-cn/skills` |
| Trae CN | `~/.trae-cn/skills` |
| WorkBuddy | `~/.workbuddy/skills` |
| 共享仓库 | `~/.agents/skills` |

事实源（canonical）：`~/.local/share/xp-gate/skills/xp-gate-reinstall/`。改内容只改那处，再跑 `install.mjs` 同步。

## 注意

本 skill **不删除**残留的 agent 目录——里面含用户数据（会话、token、数据库）和共享技能符号链接。
它只做三件事：不分发到残留根、清掉误写入的 skill 副本（逐字节比对后才删）、清理含 xp-gate 标记的钩子。

## License

MIT
