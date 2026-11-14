import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./coverage-summary.mjs", import.meta.url),
);

test("filters Go profiles and enforces the minimum", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage.out");
  const output = join(dir, "summary.json");
  writeFileSync(
    input,
    [
      "mode: set",
      "example/core.go:1.1,2.1 3 1",
      "example/core.go:3.1,4.1 1 0",
      "example/transport.go:1.1,9.1 20 0",
      "example/core.go.backup:1.1,9.1 100 0",
      "",
    ].join("\n"),
  );

  const pass = spawnSync(
    process.execPath,
    [
      script,
      "go-profile",
      input,
      output,
      "75",
      "--include-path",
      "example/core.go",
    ],
    { encoding: "utf8" },
  );
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 75 });

  const fail = spawnSync(
    process.execPath,
    [
      script,
      "go-profile",
      input,
      output,
      "76",
      "--include-path",
      "example/core.go",
    ],
    { encoding: "utf8" },
  );
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /below the 76\.0% minimum/);
});

test("selects importer directories without changing the statement denominator", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage.out");
  const output = join(dir, "summary.json");
  const scope =
    "github.com/asari194617/taskly-nnct-corp-guidance/cmd/import-guidance/";
  writeFileSync(
    input,
    [
      "mode: atomic",
      `${scope}main.go:1.1,2.1 7 8`,
      `${scope}main.go:3.1,4.1 1 0`,
      `${scope}parse.go:1.1,2.1 2 1`,
      `${scope.slice(0, -1)}-other/main.go:1.1,2.1 100 0`,
      "github.com/asari194617/taskly-nnct-corp-guidance/internal/server/server.go:1.1,2.1 50 0",
    ].join("\n"),
  );
  const run = (minimum, ...filter) =>
    spawnSync(
      process.execPath,
      [script, "go-profile", input, output, String(minimum), ...filter],
      { encoding: "utf8", timeout: 2000 },
    );
  const selected = run(90, "--include-path", scope);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 90 });
  const below = run(91, "--include-path", scope);
  assert.equal(below.status, 1);
  assert.match(below.stderr, /below the 91\.0% minimum/);
  const all = run(0);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(
    JSON.parse(readFileSync(output, "utf8")).percent,
    (9 / 160) * 100,
  );
});

test("treats regular-expression punctuation as literal file paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage.out");
  const output = join(dir, "summary.json");
  const literal = "example/core[ab]+(x)$|other.go";
  writeFileSync(
    input,
    [
      "mode: set",
      `${literal}:1.1,2.1 3 1`,
      "example/coreaaax.go:1.1,2.1 100 0",
    ].join("\n"),
  );
  const pass = spawnSync(
    process.execPath,
    [script, "go-profile", input, output, "100", "--include-path", literal],
    { encoding: "utf8", timeout: 2000 },
  );
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
    const result = spawnSync(
      process.execPath,
      [script, "go-profile", input, output, "0", ...filter],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(
      result.status,
      1,
      `${JSON.stringify(filter)}: ${result.stderr}`,
    );
    assert.equal(result.error, undefined);
    assert.match(
      result.stderr,
      /Invalid literal coverage include path|no matching statements/,
    );
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
    const result = spawnSync(
      process.execPath,
      [
        script,
        "go-profile",
        input,
        output,
        "0",
        "--include-path",
        "example/core.go",
      ],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /no matching statements|Invalid Go coverage profile line/,
    );
    assert.equal(existsSync(output), false);
  }
});

test("rejects a path selector for non-profile formats and invalid thresholds", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage-summary.json");
  writeFileSync(input, JSON.stringify({ total: { lines: { pct: 88.5 } } }));
  for (const [index, args] of [
    ["80", "--include-path", "example/core.go"],
    ["NaN"],
    ["101"],
    ["-1"],
  ].entries()) {
    const output = join(dir, `summary-${index}.json`);
    const result = spawnSync(
      process.execPath,
      [script, "istanbul", input, output, ...args],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(result.status, 1);
    assert.equal(existsSync(output), false);
  }
});

test("reads Istanbul line coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-coverage-"));
  const input = join(dir, "coverage-summary.json");
  const output = join(dir, "summary.json");
  writeFileSync(input, JSON.stringify({ total: { lines: { pct: 88.5 } } }));
  const result = spawnSync(
    process.execPath,
    [script, "istanbul", input, output, "75"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 88.5 });
});

test("reports actual worker LCOV separately and rejects missing or invalid runtime coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-worker-coverage-"));
  const input = join(dir, "worker.lcov"),
    output = join(dir, "summary.json");
  writeFileSync(
    input,
    "SF:deploy/r2/offline-worker.mjs\nLF:10\nLH:9\nend_of_record\nSF:tests/helpers.mjs\nLF:100\nLH:0\nend_of_record\nSF:deploy/r2/offline-worker.mjs.backup\nLF:100\nLH:0\nend_of_record\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "lcov",
      input,
      output,
      "80",
      "--include-path",
      "deploy/r2/offline-worker.mjs",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 90 });
  for (const invalid of [
    "",
    "SF:deploy/r2/offline-worker.mjs\nLF:1\nLH:2\nend_of_record\n",
    "SF:deploy/r2/offline-worker.mjs\nLF:10\nend_of_record\n",
  ]) {
    writeFileSync(input, invalid);
    assert.equal(
      spawnSync(process.execPath, [script, "lcov", input, output, "80"]).status,
      1,
    );
  }
});

test("LCOV path selectors stay literal and reject old regex arguments without summaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-worker-literal-"));
  const input = join(dir, "worker.lcov");
  const literal = "deploy/r2/offline-worker[ab]+(x)$|other.mjs";
  writeFileSync(
    input,
    `SF:${literal}\nLF:10\nLH:9\nend_of_record\nSF:deploy/r2/offline-workeraaax.mjs\nLF:100\nLH:0\nend_of_record\n`,
  );
  const output = join(dir, "literal.json");
  const result = spawnSync(
    process.execPath,
    [script, "lcov", input, output, "90", "--include-path", literal],
    { encoding: "utf8", timeout: 2000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { percent: 90 });
  for (const [index, args] of [
    ["offline-worker\\.mjs$"],
    ["--include-path", "deploy/r2/missing.mjs"],
    ["--include-path", "(a+)+$"],
    ["--include-path", "deploy/r2/../offline-worker.mjs"],
  ].entries()) {
    const rejected = join(dir, `rejected-${index}.json`);
    const failure = spawnSync(
      process.execPath,
      [script, "lcov", input, rejected, "80", ...args],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(failure.status, 1);
    assert.equal(failure.error, undefined);
    assert.equal(existsSync(rejected), false);
  }
});

test("MCP component prefix counts every matching file without changing whole-profile coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-mcp-prefix-"));
  const input = join(dir, "profile.out"),
    output = join(dir, "result.json");
  const prefix = "example/internal/server/mcp";
  writeFileSync(
    input,
    [
      "mode: atomic",
      `${prefix}.go:1.1,2.1 3 1`,
      `${prefix}_auth.go:1.1,2.1 2 4`,
      `${prefix}_catalog.go:1.1,2.1 1 0`,
      "example/internal/server/server.go:1.1,2.1 20 0",
    ].join("\n"),
  );
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [script, "go-profile", input, output, ...args],
      { encoding: "utf8", timeout: 2000 },
    );
  assert.equal(run("80", "--include-prefix", prefix).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
    percent: (5 / 6) * 100,
    covered: 5,
    total: 6,
  });
  assert.equal(run("84", "--include-prefix", prefix).status, 1);
  assert.equal(run("0").status, 0);
  assert.equal(
    JSON.parse(readFileSync(output, "utf8")).percent,
    (5 / 26) * 100,
  );
});

test("Go prefixes remain bounded literal strings even with regex metacharacters", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskly-mcp-literal-prefix-"));
  const input = join(dir, "profile.out"),
    output = join(dir, "result.json");
  const prefix = "example/mcp[ab]+(x)$|other";
  writeFileSync(
    input,
    `mode: set\n${prefix}_auth.go:1.1,2.1 2 1\nexample/mcpaaax_auth.go:1.1,2.1 100 0\n`,
  );
  const result = spawnSync(
    process.execPath,
    [script, "go-profile", input, output, "100", "--include-prefix", prefix],
    { encoding: "utf8", timeout: 2000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
    percent: 100,
    covered: 2,
    total: 2,
  });
  const invalid = [
    ["--include-prefix"],
    ["--include-prefix", ""],
    ["--include-prefix", "a".repeat(4097)],
    ["--include-prefix", " example/mcp"],
    ["--include-prefix", "example/../mcp"],
    ["--include-prefix", "example//mcp"],
    ["--include-prefix", "example/\\mcp"],
    ["--include-prefix", "example/mcp\n"],
    ["--include-prefix", "example/missing"],
    ["--include-prefix", prefix, "ignored"],
    ["--include-prefix", prefix, "--include-path", prefix],
  ];
  for (const [i, args] of invalid.entries()) {
    const file = join(dir, `invalid-${i}.json`);
    const failure = spawnSync(
      process.execPath,
      [script, "go-profile", input, file, "0", ...args],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(failure.status, 1, JSON.stringify(args));
    assert.equal(failure.error, undefined);
    assert.equal(existsSync(file), false);
  }
  for (const format of ["go", "istanbul", "lcov"]) {
    const file = join(dir, `${format}.json`);
    assert.equal(
      spawnSync(
        process.execPath,
        [script, format, input, file, "0", "--include-prefix", prefix],
        { timeout: 2000 },
      ).status,
      1,
    );
    assert.equal(existsSync(file), false);
  }
});
