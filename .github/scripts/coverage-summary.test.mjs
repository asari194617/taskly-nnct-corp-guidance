import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./coverage-summary.mjs", import.meta.url));

test("filters Go profiles and enforces the minimum", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage.out");
  const output = join(dir, "summary.json");
  writeFileSync(input, [
    "mode: set",
    "example/core.go:1.1,2.1 3 1",
    "example/core.go:3.1,4.1 1 0",
    "example/transport.go:1.1,9.1 20 0",
    "",
  ].join("\n"));

  const pass = spawnSync(process.execPath, [script, "go-profile", input, output, "75", "core\\.go$"], { encoding: "utf8" });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 75 });

  const fail = spawnSync(process.execPath, [script, "go-profile", input, output, "76", "core\\.go$"], { encoding: "utf8" });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /below the 76\.0% minimum/);
});

test("reads Istanbul line coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage-summary.json");
  const output = join(dir, "summary.json");
  writeFileSync(input, JSON.stringify({ total: { lines: { pct: 88.5 } } }));
  const result = spawnSync(process.execPath, [script, "istanbul", input, output, "75"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 88.5 });
});
