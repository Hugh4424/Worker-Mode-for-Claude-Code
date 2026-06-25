<div align="center">

# 🦺 Worker Mode for Claude Code

### 装一次，永久派活。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

[English](README.md) · **中文**

</div>

---

## 解决什么问题？

如果你用 Claude Code 做长时间开发，可能遇到过这个：

> **「最近 10 来天，opus 用量是 sonnet 的 20 倍……为什么我的主会话吃了这么多 token？」**

根因：**Claude 主会话总是自己扛所有重活**——读大文件、跑几百次 grep、自己改代码——而不是把活派给子代理。所有东西都堆进了最贵的模型。

三个真实会话装插件前的实测数据：

| 主会话干了什么 | 实测 |
|---|---|
| 委派率 | **只有 1–2%** |
| 自己亲手动作 | **833–1128 次** |
| 单会话上下文膨胀 | **25–37 万 token** → 频繁自动压缩 |
| 并行派发子代理 | **0 次** |

之前试过三套方案，全失败：

- **硬拦截**（拦住工具）→ 被「分段读」绕过，已 revert
- **软提醒**（提醒插件）→ 提醒 43 次，行为零改变
- **固定行数硬规则** → 误伤了主会话本该自己读的那些指令文件

根因：软提示在长上下文里被注意力稀释、被无视。这个插件最初走的是纯激励路线（只改默认念头、什么都不拦）——三次真实会话把这条路证伪了：协议常驻、nudge 提醒全被无视，委派率 ~0%。工头**看到了**提醒照样不改（自我修正盲区）。插件层能用的「软的」（注入文字/提醒/仪表盘/skill）已被穷尽并全部证伪。

**所以插件用工具剥离+后端路由强制来落地。** 主会话以 `coordinator` 身份运行（`settings.json` `agent` 字段 → coordinator 的 `tools` 白名单），物理没有 Write/Edit/MultiEdit——工头字面意义上没有写代码的手，只能把实现派出去。`enforce-backend` hook（PreToolUse，Task/Agent）物理拦截派到错误后端的 Task 调用——注意这拦的是你派给哪个后端，不是拦写操作本身。`detect-omc-failure` hook（PostToolUseFailure，Task/Agent）在 Task 调用失败时写入 failure marker，防止静默自动降级。

---

## 它做什么？

装上它，Claude 主会话会带上**工头念头**：读量重的、能并行的、需要实现的活，都派给一队各有专长的小工去干。主会话只拆任务、收摘要、判结果，自己的上下文保持轻量。

```
        装之前                                  装之后
┌─────────────────────────┐         ┌─────────────────────────┐
│  主会话                  │         │  主会话（工头）           │
│  ├─ 读 3 万行大文件      │         │  ├─ 只读轻量状态文件      │
│  ├─ grep × 127           │         │  └─ 派活 ↓               │
│  ├─ git show × 219       │         └──────────┬──────────────┘
│  ├─ Edit × 13            │            ┌────────┼────────┐
│  └─ 上下文: 37万 💥      │         读文件员  实现员  审查员
│     （反复触发压缩）     │         （重活都在小工那边发生
└─────────────────────────┘          只有摘要回到主会话）
```

---

## 跑出来看看

![委派指标看板](assets/metrics-preview.png)

会话结束后跑 `check-metrics`，看看实际派出去了多少：

```
$ node tools/check-metrics.mjs --log ~/.claude/worker-log.jsonl

Delegation metrics（18 个会话）

[最佳会话]  ← 装了插件，委派充分
  委派率:         27.6%
  小工 token:     1,069,757 tok（占总量 74%）← 重活都在小工那边
  主会话 token:   375,877 tok（26%）
  上下文净增长:   +3,316 tok  ← 几乎没有膨胀
  小工时间占比:   82%

[典型会话]  ← 未装插件
  委派率:         0.9%
  小工 token:     12,972 tok（占总量 1%）
  主会话 token:   982,699 tok（99%）← 全部压在主会话
  上下文净增长:   +87,972 tok ← 持续膨胀
  小工时间占比:   37%
```

完整输出见 [`assets/demo-output.txt`](assets/demo-output.txt)。

---

## 这支队伍

6 个小工 + 1 个工头。主会话读每个小工的 `description` 来决定派谁——不靠硬编码分工表。加一个新小工、写清它的 description，路由就自然生长。

| 小工 | 什么时候派它 |
|---|---|
| 🔎 `researcher` | 查外部文档、API 参考、多源事实核查 |
| 📖 `file-reader` | 读大文件 / 长日志，太重不该进主会话 |
| 🛠️ `implementer` | 写新代码或修改文件 |
| 🔬 `reviewer` | 产物被接受前做独立审查 |
| ✅ `qa` | 跑测试、做验收、收可证伪证据 |
| 🩹 `fixer` | 复现 → 找根因 → 修 finding 或失败 |
| 🦺 `coordinator` | 工头本体——带全工具，负责派活（主会话就是这个角色） |

---

## 快速上手

**1. 克隆到本地：**

```bash
git clone https://github.com/Hugh4424/Worker-Mode-for-Claude-Code ~/.claude/Worker-Mode-for-Claude-Code
```

**2. 配好唯一必填项：**

```bash
export WORKER_LOG_PATH=/abs/path/to/worker-log.jsonl
```

把这行加进 `~/.zshrc`（或 `~/.bashrc`），否则重开终端就失效了。没配？插件会明确告诉你，不会偷偷写到错误的地方。（这个配置检查**永不阻断会话**。）

**3. 把 agent 接进项目（一次性）：**

```bash
bash scripts/setup-delegation-workers.sh
```

**4. 正常用 Claude Code 就行。** 主会话会自己派活，每个小工结束时 `SubagentStop` 自动记一笔，不用做任何额外操作。

---

## 看看有没有效

两个事后 CLI——一次性、非常驻、执行任务期间零负担。

```bash
# 派出去的活（读 worker-log）
node tools/check-metrics.mjs --log $WORKER_LOG_PATH

# 工头自己扛了多少本该派出去的活（读主会话转录）
# 转录文件在 ~/.claude/projects/{项目}/ 目录下
node tools/check-context-health.mjs {主会话转录.jsonl}
```

`check-metrics` 看**派出去的**，`check-context-health` 看**留下来的**——工头自己扛的、本可委派的读量。两个合起来才是全貌。

---

## 落地机制：工具剥离 + 后端路由强制

这插件最初是纯激励：只改默认念头，什么都不拦。三次真实会话把这条路证明走死了——协议常驻、nudge 全被无视，委派率 ~0%。工头**看到**提醒照样不改（自我修正盲区）。随后试过 PreToolUse deny-hook 拦写/测类工具，但误伤 git 提交消息、stderr 重定向等写操作形态，误报率太高，已废弃。

**现行机制：工具剥离 + 后端路由强制。**

- **工具剥离（核心）：** 主会话以 `coordinator` 身份运行（`settings.json` `agent` 字段 → coordinator 的 `tools` 白名单），物理没有 Write/Edit/MultiEdit——工头字面意义上没有写代码的手，必须把实现派出去。
- **后端路由强制（`enforce-backend` hook，PreToolUse on Task/Agent）：** 物理拦截派到错误后端的 Task 调用。注意：这拦的是你把活派给**哪个后端**（OMC agent 还是 legacy agent），不是拦写操作本身。设 `WORKER_MODE_BACKEND=legacy` 可切回自研 worker 团队。
- **Fail-stop（`detect-omc-failure` hook，PostToolUseFailure on Task/Agent）：** Task 调用报错时写入 `omc-failure.marker`，`enforce-backend` 随后阻断【自动降级到 legacy 后端】——重新派 OMC agent 的正常重试仍然允许，不阻断。要清除 marker 并恢复正常，设 `WORKER_MODE_BACKEND=legacy` 或跑 `node tools/clear-failure-marker.mjs`，防止静默降级。

**fail-stop 边界——诚实标注覆盖范围：**
- **已覆盖（工具级失败）：** Task 调用本身报错 → PostToolUseFailure 触发 → 写入 marker → 后续自动降级到 legacy/派错后端的 Task 被阻断；正常重新派 OMC 不阻断。这是自动物理保证。
- **未覆盖（agent 软失败）：** OMC agent 正常返回但结论是失败/没做好。hook 不触发（工具调用**成功**了），没有可靠的自动信号。这类失败要靠工头验收时人工识别并处置。别误以为所有失败都会被自动物理阻断。

**后端开关：** `export WORKER_MODE_BACKEND=legacy` 切换到自研 worker 团队（`agents/` 目录）。SessionStart 每次启动都会告诉你当前是哪个后端。

---

## 和其他委派工具有什么区别？

市面上也有其他鼓励 Claude Code 使用子代理的工具，核心区别在这里：

| | 其他委派 Skill | Worker Mode |
|---|---|---|
| **激活方式** | 每次会话手动调用 | 装一次，永久生效 |
| **实现机制** | 按名调用的技能 | 注入 CLAUDE.md 的身份协议 |
| **持久性** | 会话结束后重置 | 通过 `settings-compact.json` 抗压缩漂移 |
| **可观测性** | 无 | `check-metrics` + `check-context-health` 双 CLI |
| **小工团队** | 通常没有 | 包含 6 个专长小工 |

一句话：**这不是你需要主动激活的技能，而是装上就改变默认念头的身份协议。**

---

## 状态文件

`templates/project-state.md` 是一个可填写的项目状态模板，小工靠它获取项目上下文——工头不用每次都重新解释。把它复制到项目根目录，填好占位符，小工按需自取。

---

## 什么时候不用它

**以下情况不用装：**
- 你的会话主要是单文件修改或一次性提问
- 项目代码总量不超过约 500 行
- 你没有 Claude Pro/Max 订阅，Opus 成本对你不是真问题

它在**长的、多步的开发会话**里才值回票价——那种上下文膨胀、模型成本是真问题的场景。如果上面那些条件符合你，工头协议本身是只有负担、没有收益——你仍可以把 coordinator.md 的引导当纯激励来用，不做结构性强制。

---

## 许可证

MIT。
