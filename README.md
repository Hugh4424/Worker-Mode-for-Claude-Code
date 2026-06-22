<div align="center">

# 🦺 Worker-Mode-for-Claude-Code

### Turn your Claude Code main session into a **foreman**, not a laborer.

**Pure incentive · zero interception · fully portable**

It doesn't block you. It doesn't gate you. It changes the *one thought* you have when work starts:
**"Should I do this myself, or hand it off?"**

**English** · [中文](README.zh.md)

</div>

---

## The problem this was born from

A real investigation kicked it off:

> **"For the last 10-ish days, my Opus usage has been 20× my Sonnet usage… help me find out why."**

The cause: the **orchestrator** (your main Claude Code session) keeps reading files and editing code *itself* instead of dispatching sub-agents — pouring all the heavy work into the most expensive model.

Then the hard numbers from three real sessions:

| What the orchestrator did | Measured |
|---|---|
| Delegation rate | **only 1–2%** |
| Times it did the work *itself* | **833–1128** |
| Context bloat per session | **250k–370k tokens** → frequent auto-compaction |
| Parallel fan-outs | **0** |

> *"I literally said in my system prompt to dispatch sub-agents. But when actually running tasks, the main session just keeps reading files and editing code — it always forgets to use sub-agents."*

**Three prior approaches all failed:**

- 🚧 **Hard gates** (block the tool) → got bypassed by a "read-in-chunks" backdoor, then reverted.
- 🔕 **Soft reminders** (nudge plugin) → 43 reminders, *zero* behavior change.
- 📏 **Pure protocol with fixed line-count rules** → mis-fired on the very instruction files the orchestrator *should* read itself.

Root cause, in two parts: **soft prompts get diluted by attention in long contexts**, and **hard blocks cause "try → blocked → route around" — double the wasted time and tokens.**

So this plugin takes the one road none of them took: **don't intercept at all. Change the default instinct.**

---

## What it does

Install it, and your main session adopts a **foreman mindset**: the heavy, dirty, read-intensive, parallelizable work gets dispatched to a crew of specialist workers — the orchestrator only scopes the task, collects summaries, and judges results. Its own context stays light and clear.

```
        BEFORE                                  AFTER
┌─────────────────────────┐         ┌─────────────────────────┐
│  ORCHESTRATOR            │         │  ORCHESTRATOR (foreman)  │
│  ├─ Read 30k-line file   │         │  ├─ reads light state    │
│  ├─ grep × 127           │         │  └─ dispatches ↓         │
│  ├─ git show × 219       │         └──────────┬──────────────┘
│  ├─ Edit × 13            │            ┌────────┼────────┐
│  └─ context: 370k 💥     │         file-reader  impl   reviewer
│     (compaction loop)    │         (heavy reads happen in
└─────────────────────────┘          workers; only summaries
   does everything itself              return — context stays light)
```

<sub>The "before" numbers above are from one real session: 127 source greps + 219 `git show/diff` + 13 self-edits, a 25.6 : 1 self-to-delegate ratio.</sub>

### The crew (6 portable workers + 1 foreman)

Each worker carries a `description` of *"dispatch me when…"* — the orchestrator routes by reading those descriptions, **never a hardcoded assignment table**. Add a new worker, write its description, and routing grows on its own.

| Worker | Dispatch when you need to… |
|---|---|
| 🔎 `researcher` | gather external docs, API references, multi-source fact-checking |
| 📖 `file-reader` | read large files / long logs too heavy for the main context |
| 🛠️ `implementer` | write new code (TDD-disciplined, YAGNI-aware) |
| 🔬 `reviewer` | independently review a deliverable before it's accepted |
| ✅ `qa` | run tests, verify acceptance, collect falsifiable evidence |
| 🩹 `fixer` | reproduce → root-cause → patch a finding or failure |
| 🦺 `coordinator` | the foreman itself — full tools, dispatches the crew |

---

## 60-second quick start

**1. Install** — drop `Worker-Mode-for-Claude-Code/` into your project's plugin location.

**2. Configure the one required setting** (like setting an API key):

```bash
export WORKER_LOG_PATH=/abs/path/to/worker-log.jsonl
```

> This is the single external contract. No `WORKER_LOG_PATH`, no recording — and the plugin tells you loudly instead of silently writing to the wrong place. (It still **never blocks your session**.)

**3. Wire the agents in** (one-time, idempotent):

```bash
bash .specify/scripts/bash/setup-delegation-workers.sh
```

**4. Just use Claude Code normally.** The main session delegates on its own; every worker's run is recorded automatically on `SubagentStop`. You do nothing extra.

---

## See whether it's actually working

Two complementary post-hoc CLIs — **one-shot, never resident, zero overhead during tasks.**

```bash
# What got delegated (reads the worker-log)
node tools/check-metrics.mjs --log $WORKER_LOG_PATH
node tools/check-metrics.mjs --log $WORKER_LOG_PATH --json

# What the foreman carried itself that it should have handed off (reads its transcript)
node tools/check-context-health.mjs <orchestrator-transcript.jsonl>
```

`check-metrics` looks at **what went out**. `check-context-health` looks at **what stayed in — the reads the foreman did itself that it could have delegated.** Together they tell the full story.

**The metrics it reports** (all *advisory observation only* — never gates, never thresholds to game):

- **Delegation rate** — dispatches ÷ total orchestrator actions.
- **Context** — split into two honest numbers, never a single misleading delta:
  - **net growth** (last − first; JSON key `context_net_growth`) — **can be negative**, and that's a *good* signal: cache compression shrank the context, meaning delegation worked.
  - **peak** (max − first; JSON key `context_peak`) — the heaviest expansion pressure during the session, always ≥ 0.
- **Orchestrator vs worker tokens** — the ideal shape is heavy reads pressed onto workers, foreman stays light.

> Why advisory-only? Metrics-as-gates breed score-gaming and bad behavior. The single source of trust is *re-run + signature*, not a number you can inflate.

---

## Why "pure incentive, zero interception"?

This is the **soul** of the design (decision D1), and it's deliberate:

> *"I want the orchestrator to genuinely **want** to delegate. I don't want to enforce it with any after-the-fact hard blocking."*

Any "discover-it-won't-work-after-the-fact" block makes the model **try → get blocked → route around** — and the waste already happened the moment the thought formed. So there is **no PreToolUse block, no tool allowlist, no runtime gate, ever.** Whether and when to delegate is 100% the orchestrator's own judgment.

**Red lines — work the foreman must always do itself, never delegate:**

1. Reading execution playbooks (stage definitions, contracts, hard rules, the file under review) — *lossy summaries dispatched to a worker are the #1 source of step-drift.*
2. Reading progress / state files — the basis for its scheduling judgment.
3. Judgments that need the current conversation context.
4. Distilling lessons from the current session.

> ⚙️ **Two hooks, both non-intercepting:** `SessionStart` surfaces a *non-blocking* reminder if `WORKER_LOG_PATH` is missing; `SubagentStop` records one log entry *after* each worker finishes. Neither ever changes or blocks behavior — recording is a pure observer (FR-LOG-006).

---

## Fully portable

Zero dependency on any host platform. No task-dir concept, no platform-specific state, no external gates. Pure Node ESM (no npm deps), standard Claude Code hooks + agents + one env var. Drop the folder into any project, set `WORKER_LOG_PATH`, wire the agents — done.

---

## When to skip it

Honesty builds trust, so: this plugin earns its keep on **long, multi-step development sessions** where context bloat and model-cost waste are real. For a quick one-off question, a single small edit, or a throwaway script, the foreman ceremony isn't worth it — just work directly. The plugin won't stop you either way; that's the whole point.

---

## Components

| Component | Path | Role |
|---|---|---|
| Foreman protocol | `CLAUDE.md` | injects the foreman identity + delegation judgment principles |
| Foreman agent | `agents/coordinator.md` | the authoritative foreman identity (full tools) |
| Worker crew | `agents/` (6) | research / read / implement / review / QA / fix |
| Compaction anchor | `settings-compact.json` | restates the foreman anchor verbatim on auto-compaction |
| Recorder | `hooks/record-worker.mjs` | SubagentStop hook, appends one delegation record |
| Config reminder | `hooks/check-config.mjs` | SessionStart non-blocking reminder |
| State template | `templates/project-state.md` | a light state file workers self-serve context from |
| Metrics CLI | `tools/check-metrics.mjs` | post-hoc delegation metrics from the worker-log |
| Context-health CLI | `tools/check-context-health.mjs` | post-hoc: what the foreman carried that it should have delegated |

---

## License

MIT.
