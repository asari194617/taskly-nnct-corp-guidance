import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const script = resolve("deploy/remote-deploy.sh");
const sha = "a".repeat(40),
  previous = "b".repeat(40);
function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "nnct-deploy-test-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, ".env.production"), "SYNTHETIC=only\n");
  if (options.imported) writeFileSync(join(root, ".dataset-imported"), "");
  if (options.previous)
    writeFileSync(join(root, "deployed-sha"), options.previous + "\n");
  const docker = join(root, "bin", "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({args,tag:process.env.IMAGE_TAG})+'\\n');
if(args[0]==='image')process.stdout.write(process.env.TEST_REVISION+'\\n');
if(args[0]==='compose'&&args.includes('up')&&process.env.TEST_FAIL==='1'&&process.env.IMAGE_TAG===process.env.TEST_SHA)process.exit(1);
`,
    { mode: 0o700 },
  );
  const run = (arg = sha, extra = {}) =>
    spawnSync("sh", [script, arg], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: join(root, "bin") + ":" + process.env.PATH,
        TEST_LOG: join(root, "calls"),
        TEST_REVISION: sha,
        TEST_SHA: sha,
        ...extra,
      },
    });
  const calls = () =>
    existsSync(join(root, "calls"))
      ? readFileSync(join(root, "calls"), "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse)
      : [];
  return {
    root,
    run,
    calls,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("first deployment validates image revision, imports private host data and records ready release", () => {
  const ctx = setup();
  try {
    const result = ctx.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(ctx.root, "deployed-sha"), "utf8").trim(),
      sha,
    );
    assert.ok(existsSync(join(ctx.root, ".dataset-imported")));
    const calls = ctx.calls();
    assert.equal(calls.filter((c) => c.args[0] === "run").length, 1);
    assert.ok(
      calls.some(
        (c) =>
          c.args[0] === "compose" &&
          c.args.includes("--pull") &&
          c.args.includes("never"),
      ),
    );
  } finally {
    ctx.close();
  }
});
test("readiness failure restores previous release and preserves its record and data", () => {
  const ctx = setup({ imported: true, previous });
  try {
    const result = ctx.run(sha, { TEST_FAIL: "1" });
    assert.equal(result.status, 1);
    assert.equal(
      readFileSync(join(ctx.root, "deployed-sha"), "utf8").trim(),
      previous,
    );
    assert.equal(ctx.calls().filter((c) => c.args[0] === "run").length, 0);
    assert.deepEqual(
      ctx
        .calls()
        .filter((c) => c.args.includes("up"))
        .map((c) => c.tag),
      [sha, previous],
    );
  } finally {
    ctx.close();
  }
});
test("failed initial release is stopped; invalid SHA and wrong revision never start app", () => {
  const ctx = setup({ imported: true });
  try {
    assert.equal(ctx.run(sha, { TEST_FAIL: "1" }).status, 1);
    assert.ok(ctx.calls().some((c) => c.args.includes("stop")));
    assert.equal(ctx.run("invalid;echo unsafe").status, 2);
    const other = setup();
    try {
      assert.equal(other.run(sha, { TEST_REVISION: previous }).status, 2);
      assert.equal(
        other
          .calls()
          .filter((c) => c.args[0] === "compose" || c.args[0] === "run").length,
        0,
      );
    } finally {
      other.close();
    }
  } finally {
    ctx.close();
  }
});
test("forced SSH command rejects arbitrary commands before accessing production paths", () => {
  const file = resolve("deploy/deploy-entrypoint.sh");
  for (const command of [
    "true",
    "deploy x",
    "deploy " + sha + "; id",
    "deploy " + sha + " extra",
    "",
  ]) {
    const result = spawnSync("bash", [file], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /Only deploy/);
  }
});
