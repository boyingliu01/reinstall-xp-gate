# reinstall-xp-gate 质量全视图

实测时间：2026-11-23 18:05　HEAD：`b77469a`（v2.0.0 + SAST 修复）
工作区：干净　CI：node 22/24/26 + complexity + mutation 全绿

---

## 一、门禁总览（19 个）

| # | 门禁 | 结果 | 实测依据 | 备注 |
|---|---|---|---|---|
| 0 | 版本一致性 | ✅ PASS | VERSION=package.json=2.0.0 | pre-commit 路径实测 |
| 1 | 代码质量 | ✅ PASS | adapter lint 通过 | pre-commit 路径 |
| 2 | 重复代码 | ✅ **0 clones** | jscpd 29→41 文件 | CLI 实测可跑 |
| 3 | 圈复杂度 | ⚠️ **空转** | `SKIPPED - no source files` | **上游缺陷**，见 §四 |
| 4 | 整洁代码+SOLID | ✅ **0 ERROR** | 49 INFO / 21 WARNING | 明细见 §三 |
| 5 | 测试+覆盖率 | ✅ **92.59%** | floor 80% | pre-commit 路径 |
| 6 | 架构+Boy Scout | ⏭️ SKIP | `.architecture-skip` | 已声明豁免，见 §四 |
| 7 | IaC 安全 | ✅ PASS | 无 IaC 文件 | — |
| 8 | 密钥扫描 | ✅ PASS | gitleaks：no leaks | 427KB 扫完 |
| 9 | 构建完整性 | ⏭️ SKIP | 无构建产物 | 纯脚本项目，合理 |
| 10 | SAST | ✅ **0 findings** | semgrep --config=auto | 修掉 1 条，见 §五 |
| 11 | Sprint Flow | ⏭️ SKIP | 无 `.sprint-state/` | 未用 sprint 流程 |
| 12 | 文件卫生 | ✅ PASS | 真实 hook 实测 | 需 `LC_ALL=C`，见 §四 |
| 12b | 镜像一致性 | ⏭️ SKIP | 无 staged 对 | — |
| 12c | 探针纪律 | ⏭️ SKIP | 无 staged 对 | — |
| 13 | 编译器严格度 | ⏭️ SKIP | 无 tsconfig/eslint | 无声明检查器 |
| M | 变异测试 | ✅ **19/19** | 全部被捕获 | `npm run mutation` |
| MW | Code Walkthrough | ✅ PASS | pre-push 实测 | — |
| S | prepush-sprint | ⏭️ SKIP | 无 sprint | — |

**判定：0 FAIL。** 5 个硬核门禁（2/4/8/10/M）全部满足。

---

## 二、核心指标

| 指标 | 实测 | 阈值 | 余量 |
|---|---|---|---|
| 测试 | **236 / 236 通过** | 全通过 | — |
| 行覆盖 | **92.59%** | 80% | +12.59 |
| 函数复杂度 | **782 个全 ≤ CCN 5** | 5 | 0 超标 |
| 变异测试 | **19 / 19 捕获** | 全捕获 | 0 遗漏 |
| 重复代码 | **0 clones**（3940 行 / 24954 token） | — | — |
| SAST | **0 findings** | 0 | — |
| 密钥 | **0 leaks** | 0 | — |
| 语法错误 | **0**（41 文件） | 0 | — |
| CRLF 文件 | **0** | — | autocrlf=input |
| 跟踪的运行时产物 | **0** | — | `.xp-gate/` 已忽略 |

---

## 三、技术债全貌（21 WARNING / 49 INFO）

### 3.1 模块导出过多（4 条 · 真实债）

| 模块 | 导出数 | 上限 |
|---|---|---|
| `lib/proc.mjs` | **20** | 10 |
| `lib/tools.mjs` | 18 | 10 |
| `lib/util.mjs` | 13 | 10 |
| `lib/agents.mjs` | 11 | 10 |

`proc.mjs` 20 个导出是本次重构（`withPlatform`/`parseWhichOutput`/两个超时常量）带来的，
虽有正当理由，但确实说明**该模块职责在变宽**。这是本项目最值得关注的架构债。

### 3.2 缺错误处理（17 条 · **判定为误报**）

`run`/`probe`/`copyTree`/`writeJson` 等全部被点名。**逐条核实过调用方**：

- `run()` 是 `spawnSync` 薄封装，**所有调用方都用 `r.status !== 0` 判断**
  （`proc.mjs:49/169/207/242/246`、`tools.mjs:37/260`、`gatecheck.mjs:125`）；
- 加 try/catch 反而会把"命令失败"伪装成"命令成功"。

Gate 4 只做模式匹配，看不懂这个契约。**不建议改**。

### 3.3 魔数（49 条 · 混合）

- **已命名 10 处**（`PROBE_TIMEOUT_MS` / `XP_GATE_SLOW_OP_TIMEOUT_MS` /
  `PACKAGE_INSTALL_TIMEOUT_MS` / `VERIFY_TIMEOUT_MS`），从 58 降到 49；
- 剩余大多是 `timeout:` 旁的毫秒值，字段名已表达语义；
- **刻意没合并** 4 处 `30000`：语义各异（node --check / npm root / npm view / pip show），
  合并会制造假 DRY。

---

## 四、门禁无法覆盖的部分（诚实声明）

**Gate 3 对本项目完全空转。** 上游 `LIZARD_EXTENSIONS` 正则不含 `mjs`/`cjs`，
实测 `xp-gate check 3` → `SKIPPED - no source files to check`。本项目纯 ESM，
所以**在 Gate 3 眼里整棵树不存在**。

→ 由 `npm run hp-gate` 独立兜底（lizard 直扫描 41 文件，同 CCN 5 阈值）：**782 函数全合规**。

**Gate 6 的跳过是已声明的**，不是悄悄放过。`.architecture-skip` 写明理由：
本项目是可移植 skill，`scripts/lib/` 是平铺辅助模块，无分层可约束。

**Gate 12 需 `LC_ALL=C`。** 上游 `gate-12-blob-scan.awk` 混用字节数与字符数
（`length($0)` 在 UTF-8 下返回字符数），**任何含中文的文件都会被误报缺 EOF 换行**。
已隔离复现、已记录待提 issue。当前用 `LC_ALL=C git commit` 规避。

---

## 五、本次发版做的事

**发版**：`v2.0.0` 已打 tag + GitHub Release。
破坏性变更：skill 与仓库改名 `xp-gate-reinstall` → `reinstall-xp-gate`。

**清理**：
- 删除 Gate 12 复现用的 4 个临时仓库；
- 删除 184 个 `/tmp/gate7-*` 门禁运行残留；
- 删除临时脚本与备份；确认无已合并分支残留。

**检查中发现并修掉 1 个自己引入的问题**：
SAST 报 `residue.mjs:174` 用变量构造 `RegExp`。无注入风险（名字是内部常量），
但改为按字段精确比较，更快且避免每轮都需压制告警。行为由新测试锁定
（`name: reinstall-xp-gate-fork` 不会被误删）。

---

## 六、外部质量

| 项 | 状态 |
|---|---|
| Open issues | **1**（#4，有意保留） |
| Closed | #1 #2 #3 #5 |
| CI | 全绿 |
| Release | v2.0.0 已发布 |

**#4 为何仍开**：本机不复现（OpenCode 靠 CLI 证据判活，判定正确），但 `idleDays()`
读目录 mtime 的缺陷机制**未改**，实测仅 5 天——CLI 一消失就会误判。
按"不复现就关闭"处理等于掩盖问题，已在 issue 内附实测证据与收口建议。
