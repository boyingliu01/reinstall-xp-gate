# TODO — 迁移 WSL 前遗留事项

生成时间：2026-11-22
生成依据：本机实测（Windows 11 + Node 26.13.1 + xp-gate 0.38.82），非凭记忆。
工作区状态：`main` 与 `origin/main` 同步于 `0d5d4c1`，无未提交改动。

读完这份文档就能在 WSL 里接着干活。每条都标了「是否已验证」——**没验证的不要当成结论**。

---

## 当前基线（迁移前最后一测）

| 指标 | 值 | 门槛 |
|---|---|---|
| 测试数 | 196 / 196 通过 | — |
| 项目行覆盖 | 90.66% | 80% |
| 最差文件 | `coverage.mjs` 67.86% | 80% |
| 函数复杂度 | 707 个全部 ≤ CCN 5 | 5 |
| 变异测试 | 19 / 19 全捕获 | 全捕获 |
| 重复代码 | 0 clones | — |
| CI | Node 22 / 24 / 26 三线全绿 | — |

各文件覆盖率（实测）：

```
agents.mjs     81.51%   gatecheck.mjs  70.34%   residue.mjs    97.58%
baseline.mjs   80.20%   proc.mjs       75.23%   skills.mjs     97.56%
ccn.mjs       100.00%   report.mjs    100.00%   testreport.mjs 100.00%
tools.mjs     100.00%   util.mjs       98.99%   verdict.mjs    100.00%
```

---

## TODO-1 修 `proc.mjs` 的 Windows shim 版本探测（**已验证，迁移后可关闭**）

### 现象

`--upgrade-tools` 把 jscpd 报成 `outdated`，且版本列为空。升级后仍报，等于一条永久噪声告警。

### 根因（已实测到具体行，非推测）

链条四步，每步都验证过：

1. `where jscpd` 返回两行，**首行是无扩展名的 sh 脚本**：
   ```
   C:\Users\think\AppData\Roaming\npm\jscpd        ← 无扩展名，sh 脚本
   C:\Users\think\AppData\Roaming\npm\jscpd.cmd
   ```
2. `proc.mjs:184 firstExisting()` 判定首行是文件，直接返回它。
3. `proc.mjs:104 isWindowsShim()` 只认 `/\.(cmd|bat)$/i`，**不认无扩展名的 sh 脚本**，于是 `probe()` 走 `run()` 而非 comspec 分支。
4. `spawnSync` 执行无扩展名脚本返回 `ENOENT` → `versionLine()` 拿不到输出 → `version` 为空。

实测对照（Node 直接 spawn，`shell:false`）：

```
status= null   error= ENOENT   stdout= undefined
```

而同一路径在 bash 里执行正常打印 `jscpd 5.4.3`——**装了但 Node 调不到**。

### 为什么这条值得修

- `npmLatest('jscpd')` 返回值正常（`5.4.3`），`semverOf` 也正常，**问题只在"已装版本"这一侧**，范围清晰、好修。
- 未覆盖行 `proc.mjs:202-218` 正是 `versionLine` / `toolVersion`——修它顺带能把 `proc.mjs` 的 75.23% 拉上去。

### 注意：这与 README 记载的不是同一处

`README.md:78-85` 已经详细记录了 **xp-gate 上游 `lib/gate-runner.js`** 的同类问题（Gate 2 报 `spawnSync npx ENOENT`，被归类为 `UNMEASURABLE`）。**那是上游的**，已接受为技术债。

本条是**本项目 `proc.mjs` 自己的** `versionLine`/`isWindowsShim`，两份文档里都没记。别把两者混为一谈。

### WSL 下的预期

Linux 没有 `.cmd` shim，`which` 返回真实可执行文件，**这条大概率自然消失**。迁移后第一件事就是跑：

```bash
node -e 'import("./scripts/lib/tools.mjs").then(async m=>{
  const rows = await m.toolReport({lookup: async()=>""});
  console.log(rows.filter(r=>r.name==="jscpd"));
})'
```

`version` 非空即说明已自然修复 → 关闭本条。若仍为空，才是需要写的代码。

---

## TODO-2 补 `gatecheck.mjs` 覆盖率（70.34%，项目最差的可测文件）

未覆盖行：`96-98 100-107 110-112 120-126 142-143 151-158 169-175 201-210 219-227 230-242 252-264 288-290`，函数覆盖仅 40%。

`gatecheck.mjs` 是决定「门禁到底有没有拦住」的模块，**它的正确性直接决定这个项目有没有价值**，却比 `tools.mjs`（现 100%）低得多。上一轮 `tools.mjs` 用的注入手法可以直接复用。

注意 `coverage.mjs` 67.86% 是**统计脚本自身**，覆盖率低属正常，不建议为它写测试。

---

## TODO-3 补 `proc.mjs` 的跨平台分支（75.23%，分支 66.67%）

未覆盖行：`92-102 104-106 127-128 157-163 166-174 184-188 194 197 202-212 215-218`。

全是 Windows 分支（`isWindowsShim`、comspec 拼装、`where` 解析、`versionLine`）。在 Windows 上测不完是因为 `process.platform` 是硬绑定，注入不了。

**WSL 迁移后这条会变得更难测**（Linux 上这些分支根本走不到），所以如果要保住这块覆盖，需要在迁移前考虑：是把平台判断抽成参数，还是接受 Linux 侧覆盖率下降。**这是个取舍，不是纯技术问题。**

---

## TODO-4 核实 Gate 12 的 EOF 换行误报（**未验证，只有观察记录**）

### 观察到什么

两次提交（`763d02f`、`0d5d4c1`）时，pre-commit 的 Gate 12 都报：

```
⚠️ Missing EOF newline in:
   - tests/tools-leaf.test.mjs
   - scripts/lib/tools.mjs
```

### 我核实的部分

逐字节比对，**工作区与 commit blob 的末字节都是 `0x0a`**：

```
工作区末字节: 0x0a
commit末字节: 0x0a
```

即文件本身没有问题，告警内容与实际不符。

### 我没核实的那部分

我**没有**定位 Gate 12 的检查器读的是哪个快照（暂存区 vs 工作区 vs HEAD），也没有复现出最小的误报条件——复现需要把工作区搞脏，当时没做。

所以这条现在的准确表述是：**"两次观察到告警与文件实际内容不符"**，不是一个已定性的缺陷。要去 xp-gate 提 issue，得先补上最小复现。

### 为什么可能值得追

Gate 12 是 WARN 不阻塞，但它连续误报两轮同一个问题。如果检查器确实在读旧快照，那是 xp-gate 的缺陷，值得记一条 issue。

---

## TODO-5 决定 `jscpd` / Gate 2 在上游修复前怎么办（**产品决策，非代码**）

`README.md:78-85` 已确认：jscpd ≥ 5 + Windows 下，Gate 2 **永远**是 `UNMEASURABLE`，重复代码信号缺失。

迁移 WSL 后大概率自然恢复（Linux 无 `.cmd` 问题）。但需要确认：

- WSL 下 Gate 2 是否真的能跑通？
- 如果跑通了，本项目 `0 clones` 的结论能否在 CI 上持续验证（CI 是 Linux，应该可以）？

**这条不用写代码，迁移后跑一次 `xp-gate check . --all` 看 Gate 2 输出即可。**

---

## TODO-6 确认 WSL 环境下 Node 版本策略仍然成立

上一轮已决定「只用一个 Node 26，不上版本管理器」，CI 矩阵是 `['22','24','26']`。

迁移后需要确认：

- WSL 里装的是 **Node 26 LTS**（不是发版号更高的奇数版）
- `npm test` 在 Linux 上 196/196 通过（有跨平台路径假设吗？`tests/` 里可能藏着 Windows 假设）
- pre-commit hook 在 WSL 里能正常跑（Git Bash → Linux 换行符的差异，`\r\n` vs `\n`）

**风险点**：`parseLizardCsv handles CRLF output` 这类测试说明代码里处理过换行差异，但反向（Linux 上遇到的都是 `\n`）是否测过，不确定。

---

## TODO-7 迁移后重跑全部门禁，与本文档基线对比

```bash
npm test
node scripts/coverage.mjs
node scripts/hp-gate.mjs
node scripts/mutation.mjs
npx --no-install jscpd --min-lines 5 --min-tokens 50 tests/*.mjs scripts/lib/*.mjs
xp-gate check . --all
```

对照「当前基线」那张表。**任何一项数字下降，先怀疑环境差异，不要直接当回归。**（本机 CPU 长期 90-100%，覆盖率和耗时都不稳；覆盖率本身是确定性的，降了就是真降了。）

---

## 环境重建速查

```bash
# 依赖：零第三方依赖，不需要 npm install
node --version    # 期望 v26.x

# 门禁工具（--upgrade-tools 会自动装一部分）
jscpd  lizard  checkov  hadolint  gitleaks  semgrep  npx  jq

# xp-gate 本体
npm i -g xp-gate        # 本机版本 0.38.82

# 全量检查
xp-gate check . --all
```

已知的项目约定：

- **`coverage/` 必须跟踪**，不要加进 `.gitignore`。`.gitignore` 里写了原因：Gate 5 从 **commit** 读 `coverage/coverage-summary.json`（`git cat-file -e :coverage/coverage-summary.json`），忽略它会让地板线无法测量、每个 commit 都被 `not found` 拦住。跑完 `npm run coverage` 后要连同代码一起提交。
- 项目零依赖，**不要引入测试框架**（`node:test` 够用）。
- Git 换行：Windows 侧是 `core.autocrlf` 相关，迁到 WSL 后建议 `git config core.autocrlf input`。

---

## 已完成（迁移后不必重做）

- [x] 克隆并配好本仓库开发环境
- [x] 本机与 CI 升级到 Node 26 LTS
- [x] 给 xp-gate 提缺陷 issue，去重后重新打开 #732、#858（已加评论并 reopen）
- [x] 全项目技术债盘点（Gate 4 隐藏 78 条违规：58 INFO 魔数 + 14 WARNING 缺错误处理 + 3 多导出 + 3 未用导入，0 ERROR）
- [x] `tools.mjs` 覆盖率 52.26% → 100%，函数覆盖 25% → 96.43%
- [x] 项目总覆盖 86.82% → 90.66%
- [x] 测试 133 → 196，变异 19/19，复杂度 707 函数全合规，重复代码 0
- [x] 两个 commit 推送 `origin/main`（`763d02f`、`0d5d4c1`），CI 三线全绿

### 用户已明确不做的事

- **不向 xp-gate 提 PR**：用户自己在 XPGATE 仓库里修。只提 issue / 加评论 / 重开 issue。
- Gate 4 的 58 条魔数 INFO 违规：**判定为噪声，不修**。要修的是那 14 条缺错误处理的。
