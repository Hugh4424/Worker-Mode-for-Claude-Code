<div align="center">

# 🦺 Worker Mode for Claude Code

### Install once, delegate forever.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

**English** · [中文](README.zh.md)

</div>

---

## What problem does this solve?

If you use Claude Code for long development sessions, you've probably hit this:

> **"My Opus usage is 20× my Sonnet usage. Why is my main session eating so many tokens?"**

The cause: **Claude's main session keeps doing all the heavy lifting itself** — reading large files, running grep 100+ times, editing code — instead of dispatching sub-agents. Everything piles into your most expensive model.

Real numbers from three actual sessions before this plugin:

| What the main session did | Measured |
|---|---|
| Delegation rate | **1–2% only** |
| Actions it did itself | **833–1,128 times** |
| Context bloat per session | **250k–370k tokens** → constant auto-compaction |
| Parallel sub-agent dispatches | **0** |

Three previous fixes were tried. All failed:

- **Hard blocks** (intercept the tool) → got routed around via "read in chunks," then reverted
- **Soft reminders** (nudge plugins) → 43 reminders sent, zero behavior change
- **Fixed-line-count rules** → misfired on the very instruction files Claude *should* read itself

The root cause: soft prompts get diluted in long contexts, and hard blocks just cause "try → blocked → route around" — the waste already happened the moment the thought formed.

**This plugin takes the only road none of them tried: don't intercept at all. Change the default instinct.**

---

## What it does

Install it, and your main Claude Code session adopts a **foreman mindset**: heavy reads, parallel tasks, and implementation work get dispatched to a crew of specialist sub-agents. The main session only scopes the work, collects summaries, and judges results. Its context stays light.

```
        BEFORE                                  AFTER
┌─────────────────────────┐         ┌─────────────────────────┐
│  Main session            │         │  Main session (foreman)  │
│  ├─ Read 30k-line file   │         │  ├─ reads light state    │
│  ├─ grep × 127           │         │  └─ dispatches ↓         │
│  ├─ git show × 219       │         └──────────┬──────────────┘
│  ├─ Edit × 13            │            ┌────────┼────────┐
│  └─ context: 370k 💥     │         file-reader  impl   reviewer
│     (compaction loop)    │         (heavy reads happen in workers;
└─────────────────────────┘          only summaries return)
```

---

## See it in action

![Delegation metrics dashboard](assets/metrics-preview.png)

Run `check-metrics` after a session to see what actually got delegated:

```
$ node tools/check-metrics.mjs --log $WORKER_LOG_PATH

Delegation metrics (3 sessions)

[session 1]  ← with plugin, delegation working
  delegation rate:       5.5%
  context net growth:    -30,647 tok   ← negative = context actually shrank
  context peak:          +37,688 tok
  orchestrator tokens:   37,811
  worker tokens:         9,490         ← heavy reads happened in workers
  worker time ratio:     49.6%
  concurrent dispatches: 3.4%

[session 2]  ← without plugin (typical before)
  delegation rate:       0.8%
  context net growth:    +72,633 tok   ← ballooning
  orchestrator tokens:   968,933       ← almost everything in main session
  worker tokens:         9,792
  worker time ratio:     38.9%
  concurrent dispatches: 0%
```

The negative context growth in session 1 is real: effective delegation lets the context actually shrink via compaction. Full output saved in [`assets/demo-output.txt`](assets/demo-output.txt).

---

## The crew

6 specialist workers + 1 foreman. The main session reads each worker's `description` to decide who to dispatch — no hardcoded assignment table. Add a new worker, write its description, routing grows on its own.

| Worker | Dispatch when you need to… |
|---|---|
| 🔎 `researcher` | look up docs, API refs, multi-source fact-checking |
| 📖 `file-reader` | read large files or long logs — too heavy for the main context |
| 🛠️ `implementer` | write new code or modify files |
| 🔬 `reviewer` | independently review a deliverable before accepting it |
| ✅ `qa` | run tests, verify acceptance, collect evidence |
| 🩹 `fixer` | reproduce → root-cause → patch a finding or test failure |
| 🦺 `coordinator` | the foreman — full tools, dispatches the crew (this is what the main session becomes) |

---

## Quick start

**1. Clone into your Claude agents directory:**

```bash
git clone https://github.com/Hugh4424/Worker-Mode-for-Claude-Code ~/.claude/Worker-Mode-for-Claude-Code
```

**2. Set the one required env var:**

```bash
export WORKER_LOG_PATH=/abs/path/to/worker-log.jsonl
```

Add this to your `~/.zshrc` (or `~/.bashrc`) so it persists across terminal sessions. Missing it? The plugin tells you loudly instead of silently writing somewhere wrong. It never blocks your session.

**3. Wire the agents in (one-time):**

```bash
bash scripts/setup-delegation-workers.sh
```

**4. Use Claude Code normally.** The main session delegates on its own. Every sub-agent run is recorded automatically on `SubagentStop`. Nothing extra needed.

---

## Check if it's working

Two post-hoc CLIs — one-shot, never resident, zero overhead during tasks.

```bash
# What got delegated (reads the worker-log)
node tools/check-metrics.mjs --log $WORKER_LOG_PATH

# What the foreman carried itself that it should have dispatched
# transcript.jsonl = Claude Code session file, found at ~/.claude/projects/<project>/
node tools/check-context-health.mjs <transcript.jsonl>
```

`check-metrics` shows what went **out**. `check-context-health` shows what **stayed in** — reads the foreman did itself that it could have delegated. Together they tell the full story.

---

## Why "zero interception"?

Any "discover-it-won't-work-after-the-fact" block makes the model **try → get blocked → route around** — and the waste already happened the moment the thought formed.

So there is **no PreToolUse block, no tool allowlist, no runtime gate, ever.** Whether and when to delegate is 100% the foreman's own judgment. The plugin changes the *default instinct*, not the rules.

---

## How is this different from other delegation skills?

There are other Claude Code tools that encourage sub-agent use. The key difference:

| | Other delegation skills | Worker Mode |
|---|---|---|
| **Activation** | You invoke it each session | Installed once, always on |
| **Mechanism** | A skill you call by name | Identity protocol injected into CLAUDE.md |
| **Persistence** | Resets between sessions | Survives context compaction via `settings-compact.json` |
| **Observability** | None | `check-metrics` + `check-context-health` CLIs |
| **Worker crew** | Usually none | 6 specialist workers included |

The short version: **it's not a skill you activate — it's a default instinct you install.**

---

## State file

`templates/project-state.md` is a fillable template that workers use to receive project context without the foreman having to re-explain everything each time. Copy it into your project root, fill in the blanks — workers self-fetch it on demand.

---

## When to skip it

**Don't install if:**
- Your sessions are mostly single-file edits or one-shot questions
- Your project is under ~500 lines total
- You're not on a Claude Pro/Max plan where Opus cost actually matters

This earns its keep on **long, multi-step sessions** where context bloat and token cost are real. The plugin won't stop you either way — but if the above applies, it's overhead with no payoff.

---

## License

MIT.
