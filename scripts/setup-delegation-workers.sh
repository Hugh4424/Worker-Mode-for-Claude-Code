#!/usr/bin/env bash
set -euo pipefail

# setup-delegation-workers.sh — Symlink the coordinator (foreman) + worker
# agents into an agents/ discovery directory so Claude Code's Agent tool can
# find them. One-shot onboarding; safe to re-run (idempotent).
#
# Source of truth: <plugin>/agents/*.md
# (coordinator.md + 6 workers; globbed, NOT hardcoded — adding an agent file
# later increases the link count automatically.)
#
# Default destination is GLOBAL (~/.claude/agents), so every project gets the
# delegation workers. Pass --dest to scope to a single project instead.
#
# Usage:
#   bash scripts/setup-delegation-workers.sh                 # global (~/.claude/agents)
#   bash scripts/setup-delegation-workers.sh --dest <path>   # custom target dir
#   bash scripts/setup-delegation-workers.sh --dest=<path>
#   bash scripts/setup-delegation-workers.sh --dest .claude/agents   # a project
#
# Source resolution order:
#   1. $CLAUDE_PLUGIN_ROOT/agents   (set when run as a Claude Code plugin)
#   2. <dir-of-this-script>/../agents (run directly from the plugin checkout)

# Resolve the plugin root. Prefer CLAUDE_PLUGIN_ROOT; otherwise derive from this
# script's own location (scripts/ -> plugin root).
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

AGENTS_SRC="$PLUGIN_ROOT/agents"
AGENTS_DST="$HOME/.claude/agents"   # default: global

usage() {
  echo "Usage: bash scripts/setup-delegation-workers.sh [--dest=<path>|--dest <path>]"
  echo "  (no args)        install globally to ~/.claude/agents"
  echo "  --dest <path>    install to a custom agents directory (e.g. a project's .claude/agents)"
}

# Parse args. Support both --dest=<path> and --dest <path>.
while [ $# -gt 0 ]; do
  case "$1" in
    --dest=*)
      AGENTS_DST="${1#*=}"
      ;;
    --dest)
      shift
      if [ $# -eq 0 ]; then
        echo "ERROR: --dest requires a path argument"
        usage
        exit 2
      fi
      AGENTS_DST="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg $1"
      usage
      exit 2
      ;;
  esac
  shift
done

if [ ! -d "$AGENTS_SRC" ]; then
  echo "ERROR: delegation agents directory not found at $AGENTS_SRC"
  echo "Set CLAUDE_PLUGIN_ROOT, or run this script from inside the plugin checkout."
  exit 1
fi

mkdir -p "$AGENTS_DST"

LINKED=0
RELINKED=0
SKIPPED=0
for agent_file in "$AGENTS_SRC"/*.md; do
  # Glob may not match if no .md files exist; guard against the literal pattern.
  [ -e "$agent_file" ] || continue
  agent_name=$(basename "$agent_file")
  # Skip non-agent placeholder files.
  if [ "$agent_name" = ".gitkeep" ]; then
    continue
  fi
  target="$AGENTS_DST/$agent_name"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$agent_file" ]; then
    # Already symlinked to the right place.
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ -L "$target" ]; then
    old_target="$(readlink "$target")"
    ln -sfn "$agent_file" "$target"
    echo "RELINK: $target ($old_target -> $agent_file)"
    RELINKED=$((RELINKED + 1))
    continue
  fi

  if [ -e "$target" ]; then
    echo "SKIP: $target already exists (not a symlink to us)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  ln -sf "$agent_file" "$target"
  echo "LINK: $agent_file -> $target"
  LINKED=$((LINKED + 1))
done

echo ""
echo "Done. $LINKED linked, $RELINKED relinked, $SKIPPED skipped."
echo ""
echo "Delegation agents are now available via the Agent tool."
echo "Discovery layer: $AGENTS_DST"
echo "Source of truth: $AGENTS_SRC"
echo "The coordinator is the default foreman (orchestrator) agent."
echo "Refresh Claude Code session or restart to pick up changes."
