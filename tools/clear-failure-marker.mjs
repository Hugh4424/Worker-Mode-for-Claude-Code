#!/usr/bin/env node
// clear-failure-marker.mjs — removes .worker-mode/state/omc-failure.marker.
// Usage: node tools/clear-failure-marker.mjs
import { unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// 1. If CLAUDE_PROJECT_DIR is set, use it directly.
// 2. Else, walk upward from process.cwd() looking for a dir that contains .worker-mode/.
// 3. If found, use that dir as project root.
// 4. If not found (reached filesystem root), print error and exit 1.

function findProjectRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".worker-mode"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

const projectRoot = process.env.CLAUDE_PROJECT_DIR
  || findProjectRoot(process.cwd());

if (!projectRoot) {
  console.error("找不到项目根目录（向上查找 .worker-mode 失败）。请设置 CLAUDE_PROJECT_DIR 或在项目目录内运行。");
  process.exit(1);
}

const markerPath = join(projectRoot, ".worker-mode", "state", "omc-failure.marker");

try {
  unlinkSync(markerPath);
  console.log("已删除 omc-failure.marker");
} catch (err) {
  if (err.code === "ENOENT") {
    console.log("无需清除：omc-failure.marker 不存在");
  } else {
    throw err;
  }
}
