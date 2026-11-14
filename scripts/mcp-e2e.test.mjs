import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearReports,
  configuration,
  toolchainEnvironment,
} from "./mcp-e2e.mjs";

const valid = {
  MCP_E2E_AUTH_DIR: "/tmp/synthetic-auth",
  MCP_E2E_TASKLY_DIR: "/tmp/synthetic-taskly",
  MCP_E2E_MYSQL_PASSWORD: "synthetic-ci-only",
};
test("three-service runner requires loopback, synthetic credentials and both reviewed checkouts", () => {
  const cfg = configuration(valid);
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 3306);
  assert.equal(cfg.tasklyGo, "go1.26.10");
  for (const overrides of [
    { NODE_ENV: "Production" },
    { MCP_E2E_MYSQL_HOST: "db.example.test" },
    { MCP_E2E_MYSQL_PORT: "0" },
    { MCP_E2E_MYSQL_PORT: "65536" },
    { MCP_E2E_MYSQL_PORT: "NaN" },
    { MCP_E2E_MYSQL_PORT: "3.5" },
    { MCP_E2E_MYSQL_USER: "root@production" },
    { MCP_E2E_MYSQL_PASSWORD: "" },
    { MCP_E2E_AUTH_DIR: "" },
    { MCP_E2E_TASKLY_DIR: "" },
    { MYSQL_DSN: "production-dsn-is-never-parsed" },
    { AUTH_DSN: "production-dsn-is-never-parsed" },
    { TASKLY_E2E_MYSQL_DSN: "production-dsn-is-never-parsed" },
  ])
    assert.throws(() => configuration({ ...valid, ...overrides }));
});

test("each absolute Go compiler resolves its own GOROOT without mutating caller env", () => {
  const original = {
    GOROOT: "/other-go1.26/root",
    GOTOOLCHAIN: "auto",
    PATH: "/tools/bin",
  };
  const actual = toolchainEnvironment(original);
  assert.equal(actual.GOROOT, undefined);
  assert.equal(actual.GOTOOLCHAIN, "local");
  assert.equal(actual.PATH, original.PATH);
  assert.equal(original.GOROOT, "/other-go1.26/root");
});

test("failed rerun cannot retain a prior functional success artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-stale-report-"));
  try {
    await writeFile(join(directory, "report.json"), '{"passed":18}');
    await writeFile(
      join(directory, "mcp-functional.json"),
      '{"passed":18,"total":18}',
    );
    await writeFile(
      join(directory, "proof.log"),
      "previous synthetic evidence",
    );
    await clearReports(directory);
    await assert.rejects(readFile(join(directory, "report.json")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(directory, "mcp-functional.json")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(join(directory, "proof.log"), "utf8"),
      "previous synthetic evidence",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
