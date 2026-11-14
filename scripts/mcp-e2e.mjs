import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainSecret = "synthetic-main-client-only-not-production-123456";
const backendSecret = "synthetic-mcp-backend-only-not-production-123456";
const origin = {
  auth: "http://127.0.0.1:34567",
  ui: "http://127.0.0.1:34568",
  taskly: "http://127.0.0.1:34574",
  guidance: "http://127.0.0.1:34571",
};

export function configuration(env = process.env) {
  if (env.NODE_ENV?.trim().toLowerCase() === "production")
    throw Error("MCP E2E refuses production mode");
  if (env.MYSQL_DSN || env.AUTH_DSN || env.TASKLY_E2E_MYSQL_DSN)
    throw Error(
      "Supply only disposable MCP_E2E_MYSQL settings, never app DSNs",
    );
  const host = env.MCP_E2E_MYSQL_HOST || "127.0.0.1";
  const port = Number(env.MCP_E2E_MYSQL_PORT || 3306);
  const user = env.MCP_E2E_MYSQL_USER || "root";
  const password = env.MCP_E2E_MYSQL_PASSWORD;
  if (
    host !== "127.0.0.1" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("MCP E2E requires literal loopback MySQL and a valid port");
  if (!/^[A-Za-z0-9_]+$/.test(user) || !password)
    throw Error("MCP E2E synthetic database credentials are required");
  if (!env.MCP_E2E_AUTH_DIR || !env.MCP_E2E_TASKLY_DIR)
    throw Error("Reviewed Auth and Taskly checkouts are required");
  return {
    host,
    port,
    user,
    password,
    auth: resolve(env.MCP_E2E_AUTH_DIR),
    taskly: resolve(env.MCP_E2E_TASKLY_DIR, "apps/server"),
    go: env.MCP_E2E_GO || "go",
    tasklyGo: env.MCP_E2E_TASKLY_GO || "go1.26.10",
    artifact: resolve(
      env.MCP_E2E_ARTIFACT_DIR || join(root, "coverage/mcp-e2e"),
    ),
  };
}

// Each absolute Go executable must resolve its own installation after setup-go
// selects two versions. Never inherit a GOROOT belonging to the other compiler.
export function toolchainEnvironment(env = process.env) {
  const inherited = { ...env };
  delete inherited.GOROOT;
  return { ...inherited, GOTOOLCHAIN: "local" };
}

export async function clearReports(directory) {
  await Promise.all(
    ["report.json", "mcp-functional.json"].map((name) =>
      rm(join(directory, name), { force: true }),
    ),
  );
}

async function hashSources(directory) {
  const hash = createHash("sha256");
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        [
          ".git",
          "node_modules",
          ".e2e",
          "coverage",
          ".next",
          "out",
          "data",
          "private",
        ].includes(entry.name)
      )
        continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (
        entry.name.endsWith(".go") ||
        ["go.mod", "go.sum", "schema.sql"].includes(entry.name)
      ) {
        hash.update(file.slice(directory.length));
        hash.update(await readFile(file));
      }
    }
  }
  await walk(directory);
  return hash.digest("hex");
}

async function occupied(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function main() {
  const cfg = configuration();
  const children = [];
  const logs = [];
  let privateDir;
  let stopping;
  const cleanup = () =>
    (stopping ??= (async () => {
      const waitForClose = async (child, milliseconds) => {
        let timer;
        try {
          return await Promise.race([
            child.done.then(() => true),
            new Promise((done) => {
              timer = setTimeout(() => done(false), milliseconds);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      for (const child of children.toReversed()) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          if (!(await waitForClose(child, 10000))) {
            child.kill("SIGKILL");
            if (!(await waitForClose(child, 5000)))
              throw Error("Owned MCP child did not confirm termination");
          }
        }
      }
      for (const log of logs) log.end();
      await writeFile(
        join(cfg.artifact, "cleanup.json"),
        JSON.stringify(
          children.map((child) => ({
            pid: child.pid,
            stopped:
              child.pid === undefined ||
              child.exitCode !== null ||
              child.signalCode !== null,
          })),
          null,
          2,
        ),
      );
      if (privateDir) await rm(privateDir, { recursive: true, force: true });
    })());
  const onSignal = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await mkdir(cfg.artifact, { recursive: true });
  await clearReports(cfg.artifact);
  const env = {
    ...toolchainEnvironment(),
    NODE_ENV: "test",
    DISCORD_WEBHOOK_URL: "",
    AUTH_INTERNAL_TOKEN: "",
    AUTH_GEOIP_MMDB_PATH: "",
    AUTH_HISTORY_TRUSTED_PROXY_PEER: "",
    WEBAUTHN_RP_ID: "",
    OAUTH_PUBLIC_CLIENTS_JSON: "",
    MCP_E2E_MYSQL_HOST: cfg.host,
    MCP_E2E_MYSQL_PORT: String(cfg.port),
    MCP_E2E_MYSQL_USER: cfg.user,
    MCP_E2E_MYSQL_PASSWORD: cfg.password,
    MCP_E2E_AUTH_DIR: cfg.auth,
    MCP_E2E_GUIDANCE_DIR: root,
    MCP_E2E_ARTIFACT_DIR: cfg.artifact,
  };
  const launch = (name, command, args, cwd, extra = {}) => {
    const log = createWriteStream(join(cfg.artifact, `${name}.log`));
    logs.push(log);
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.done = new Promise((done) => {
      child.once("error", () => done(false));
      child.once("close", (code) => done(code === 0));
    });
    children.push(child);
    return child;
  };
  const run = async (name, command, args, cwd, timeout = 180000) => {
    const child = launch(name, command, args, cwd);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    try {
      if (!(await child.done))
        throw Error(`${name} failed; inspect its synthetic-only artifact log`);
    } finally {
      clearTimeout(timer);
    }
  };
  const ready = async (url, child) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error("MCP E2E service exited before ready");
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok)
          return;
      } catch {
        /* Retry only bounded service startup, never a test. */
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw Error("MCP E2E service startup timeout");
  };
  try {
    for (const port of [34567, 34571, 34574])
      if (await occupied(port))
        throw Error(`Port ${port} is occupied; refusing duplicate services`);
    await Promise.all([
      readFile(join(cfg.auth, "cmd/auth/main.go")),
      readFile(join(cfg.taskly, "cmd/guidance-e2e/main.go")),
    ]);
    privateDir = await mkdtemp(join(tmpdir(), "guidance-mcp-e2e-"));
    const binary = (name) => join(privateDir, name);
    const probeDir = join(root, "tests/mcp-e2e-client");
    const hashes = async () => ({
      auth: await hashSources(cfg.auth),
      taskly: await hashSources(cfg.taskly),
      guidance: await hashSources(root),
    });
    const before = await hashes();
    await writeFile(
      join(cfg.artifact, "source-hashes-before.json"),
      JSON.stringify(before, null, 2),
    );
    const builds = await Promise.allSettled([
      run(
        "build-auth",
        cfg.go,
        ["build", "-mod=readonly", "-o", binary("auth"), "./cmd/auth"],
        cfg.auth,
      ),
      run(
        "build-taskly",
        cfg.tasklyGo,
        [
          "build",
          "-mod=readonly",
          "-o",
          binary("taskly"),
          "./cmd/guidance-e2e",
        ],
        cfg.taskly,
      ),
      run(
        "build-guidance",
        cfg.go,
        ["build", "-mod=readonly", "-o", binary("guidance"), "./cmd/api"],
        root,
      ),
      run("vet-probe", cfg.go, ["vet", "./..."], probeDir).then(() =>
        run(
          "build-probe",
          cfg.go,
          ["build", "-mod=readonly", "-o", binary("probe"), "."],
          probeDir,
        ),
      ),
    ]);
    for (const build of builds)
      if (build.status === "rejected") throw build.reason;
    await run("seed", binary("probe"), ["seed"], root);
    // Passwords are carried in child environments, never shell commands/logs.
    const dsn = (database) =>
      `${cfg.user}:${cfg.password}@tcp(${cfg.host}:${cfg.port})/${database}?parseTime=true&loc=UTC&time_zone=%27%2B00%3A00%27`;
    const auth = launch("auth", binary("auth"), [], cfg.auth, {
      AUTH_ADDR: "127.0.0.1:34567",
      AUTH_DSN: dsn("taskly_auth_mcp_test"),
      AUTH_ISSUER: origin.auth,
      AUTH_UI_URL: origin.ui,
      OAUTH_CLIENT_ID: "taskly-e2e",
      OAUTH_CLIENT_SECRET: mainSecret,
      OAUTH_REDIRECT_URI: "http://127.0.0.1:34569/legacy-callback",
      OAUTH_MCP_ENABLED: "1",
      OAUTH_MCP_REDIRECT_URI: "http://127.0.0.1:34569/callback",
      OAUTH_MCP_RESOURCE: `${origin.guidance}/mcp`,
      OAUTH_MCP_TASKLY_RESOURCE: `${origin.taskly}/integrations/nnct-guidance/tasks`,
      OAUTH_MCP_BACKEND_SECRET: backendSecret,
    });
    await ready(`${origin.auth}/healthz`, auth);
    const taskly = launch("taskly", binary("taskly"), [], cfg.taskly, {
      TASKLY_GUIDANCE_E2E: "1",
      ADDR: "127.0.0.1:34574",
      TASKLY_E2E_MYSQL_DSN: dsn("taskly_guidance_e2e"),
      AUTH_ISSUER: origin.auth,
      AUTH_CLIENT_ID: "taskly-e2e",
      AUTH_CLIENT_SECRET: mainSecret,
      API_PUBLIC_URL: origin.taskly,
      NNCT_GUIDANCE_MCP_PARENT_RESOURCE: `${origin.guidance}/mcp`,
    });
    await ready(`${origin.taskly}/__test/ready`, taskly);
    const guidance = launch("guidance", binary("guidance"), [], root, {
      ADDR: "127.0.0.1:34571",
      MYSQL_DSN: dsn("guidance_mcp_e2e"),
      UI_ORIGIN: origin.ui,
      API_ORIGIN: origin.guidance,
      AUTH_ISSUER: origin.auth,
      AUTH_CLIENT_ID: "nnct-corp-guidance-2026",
      SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
      MCP_ENABLED: "1",
      MCP_BACKEND_SECRET: backendSecret,
      TASKLY_API_ORIGIN: origin.taskly,
      TASKLY_GUIDANCE_EVENT_ID: "synthetic-guidance-2030",
      R2_ENDPOINT: "http://127.0.0.1:34573",
      R2_BUCKET: "synthetic-documents",
      R2_ACCESS_KEY_ID: "synthetic-access",
      R2_SECRET_ACCESS_KEY: "synthetic-secret",
    });
    await ready(`${origin.guidance}/healthz`, guidance);
    await run("proof", binary("probe"), [], root, 120000);
    const report = JSON.parse(
      await readFile(join(cfg.artifact, "report.json"), "utf8"),
    );
    if (
      report.passed !== 18 ||
      report.cases.length !== 18 ||
      report.cases.some((item) => item.passed !== true)
    )
      throw Error("All 18 MCP scenarios must pass");
    const after = await hashes();
    await writeFile(
      join(cfg.artifact, "source-hashes-after.json"),
      JSON.stringify(after, null, 2),
    );
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error("Sources changed during MCP proof");
    await writeFile(
      join(cfg.artifact, "mcp-functional.json"),
      JSON.stringify({ passed: report.passed, total: 18 }),
    );
    console.log(
      "MCP HTTP/official SDK E2E: 18/18 passed; no business responses mocked",
    );
  } finally {
    await cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
