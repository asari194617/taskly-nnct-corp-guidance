import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const biome = fileURLToPath(
  new URL("../apps/web/node_modules/@biomejs/biome/bin/biome", import.meta.url),
);
const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !["lint", "format", "format:check"].includes(mode)) {
  throw new Error("Usage: quality.mjs <lint|format|format:check>");
}

const commands = {
  lint: [
    [process.execPath, [biome, "lint", "--error-on-warnings", "."]],
    ["python3", ["-m", "ruff", "check", "."]],
    ["bash", ["scripts/lint-go.sh"]],
  ],
  format: [
    [process.execPath, [biome, "format", "--write", "."]],
    ["python3", ["-m", "ruff", "format", "."]],
    ["bash", ["scripts/format-go.sh", "--write"]],
  ],
  "format:check": [
    [process.execPath, [biome, "format", "."]],
    ["python3", ["-m", "ruff", "format", "--check", "."]],
    ["bash", ["scripts/format-go.sh", "--check"]],
  ],
};

for (const [command, args] of commands[mode]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
