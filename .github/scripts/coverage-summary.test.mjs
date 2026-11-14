import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    "example/core.go.backup:1.1,9.1 100 0",
    "",
  ].join("\n"));

  const pass = spawnSync(process.execPath, [script, "go-profile", input, output, "75", "--include-path", "example/core.go"], { encoding: "utf8" });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 75 });

  const fail = spawnSync(process.execPath, [script, "go-profile", input, output, "76", "--include-path", "example/core.go"], { encoding: "utf8" });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /below the 76\.0% minimum/);
});

test("selects importer directories without changing the statement denominator", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage.out");
  const output = join(dir, "summary.json");
  const scope = "github.com/asari194617/taskly-nnct-corp-guidance/cmd/import-guidance/";
  writeFileSync(input, [
    "mode: atomic",
    `${scope}main.go:1.1,2.1 7 8`,
    `${scope}main.go:3.1,4.1 1 0`,
    `${scope}parse.go:1.1,2.1 2 1`,
    `${scope.slice(0, -1)}-other/main.go:1.1,2.1 100 0`,
    "github.com/asari194617/taskly-nnct-corp-guidance/internal/server/server.go:1.1,2.1 50 0",
  ].join("\n"));
  const run = (minimum, ...filter) => spawnSync(process.execPath, [script, "go-profile", input, output, String(minimum), ...filter], { encoding: "utf8", timeout: 2000 });
  const selected = run(90, "--include-path", scope);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 90 });
  const below = run(91, "--include-path", scope);
  assert.equal(below.status, 1);
  assert.match(below.stderr, /below the 91\.0% minimum/);
  const all = run(0);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).percent, 9 / 160 * 100);
});

test("treats regular-expression punctuation as literal file paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage.out");
  const output = join(dir, "summary.json");
  const literal = "example/core[ab]+(x)$|other.go";
  writeFileSync(input, ["mode: set", `${literal}:1.1,2.1 3 1`, "example/coreaaax.go:1.1,2.1 100 0"].join("\n"));
  const pass = spawnSync(process.execPath, [script, "go-profile", input, output, "100", "--include-path", literal], { encoding: "utf8", timeout: 2000 });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 100 });
});

test("fails closed for invalid selectors and selectors with no statements", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage.out");
  writeFileSync(input, "mode: set\nexample/core.go:1.1,2.1 3 1\n");
  const cases = [
    ["core\\.go$"],
    ["--include-regex", ".*"],
    ["--include-path"],
    ["--include-path", ""],
    ["--include-path", " example/core.go"],
    ["--include-path", "example/../core.go"],
    ["--include-path", "example//core.go"],
    ["--include-path", "example\\core.go"],
    ["--include-path", "example/\ncore.go"],
    ["--include-path", "a".repeat(4097)],
    ["--include-path", "example/core.go", "ignored"],
    ["--include-path", "example/missing.go"],
    ["--include-path", "example/missing/"],
    ["--include-path", "(a+)+$"],
  ];
  for (const [index, filter] of cases.entries()) {
    const output = join(dir, `summary-${index}.json`);
    const result = spawnSync(process.execPath, [script, "go-profile", input, output, "0", ...filter], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 1, `${JSON.stringify(filter)}: ${result.stderr}`);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /Invalid literal Go coverage include path|no matching statements/);
    assert.equal(existsSync(output), false);
  }
});

test("fails closed for empty or malformed matching coverage profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  for (const [index, body] of [
    "mode: set\nexample/core.go:1.1,2.1 0 1\n",
    "mode: set\nexample/core.go:1.1,2.1 3 1\nmalformed line\n",
  ].entries()) {
    const input = join(dir, `coverage-${index}.out`);
    const output = join(dir, `summary-${index}.json`);
    writeFileSync(input, body);
    const result = spawnSync(process.execPath, [script, "go-profile", input, output, "0", "--include-path", "example/core.go"], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no matching statements|Invalid Go coverage profile line/);
    assert.equal(existsSync(output), false);
  }
});

test("rejects a path selector for non-profile formats and invalid thresholds", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage-summary.json");
  writeFileSync(input, JSON.stringify({ total: { lines: { pct: 88.5 } } }));
  for (const [index, args] of [["80", "--include-path", "example/core.go"], ["NaN"], ["101"], ["-1"]].entries()) {
    const output = join(dir, `summary-${index}.json`);
    const result = spawnSync(process.execPath, [script, "istanbul", input, output, ...args], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 1);
    assert.equal(existsSync(output), false);
  }
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
