import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServices } from "./e2e-services.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  web = resolve(root, "apps/web");
// A failed startup must not leave a previous run's successful coverage report.
await rm(resolve(web, "coverage/e2e"), { recursive: true, force: true });
await rm(resolve(root, "e2e.json"), { force: true });
const { default: mysql } = await import(
  pathToFileURL(resolve(web, "node_modules/mysql2/promise.js"))
);
const database = process.env.E2E_MYSQL_DATABASE || "guidance_e2e";
if (!/^[a-zA-Z0-9_]+_e2e$/.test(database))
  throw Error(
    "E2E database name must end in _e2e; production databases are forbidden",
  );
const host = process.env.E2E_MYSQL_HOST || "127.0.0.1",
  port = Number(process.env.E2E_MYSQL_PORT || 3306),
  user = process.env.E2E_MYSQL_USER || "root",
  password = process.env.E2E_MYSQL_PASSWORD;
if (!password)
  throw Error("E2E_MYSQL_PASSWORD required (disposable MySQL only)");
const dsn = `${user}:${password}@tcp(${host}:${port})/${database}?parseTime=true&charset=utf8mb4&loc=UTC`;
const privateDir = await mkdtemp(resolve(tmpdir(), "guidance-e2e-"));
const env = {
  ...process.env,
  MYSQL_DSN: dsn,
  SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
  UI_ORIGIN: "http://127.0.0.1:3300",
  API_ORIGIN: "http://127.0.0.1:3371",
  AUTH_ISSUER: "http://127.0.0.1:3372",
  AUTH_CLIENT_ID: "synthetic-e2e",
  DATA_DIR: privateDir,
  ADDR: "127.0.0.1:3371",
  NEXT_PUBLIC_API_URL: "http://127.0.0.1:3371",
  E2E_COVERAGE: "1",
  NEXT_TELEMETRY_DISABLED: "1",
};
const run = (command, args, cwd = root) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? ok() : fail(Error(`${command} exited ${code}`)),
    );
  });
let api, stop;
try {
  const db = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
  });
  try {
    for (const statement of (
      await readFile(resolve(root, "schema.sql"), "utf8")
    ).split(";"))
      if (statement.trim()) await db.query(statement);
    for (const table of [
      "guidance_bookmarks",
      "guidance_sessions",
      "guidance_oauth_flows",
    ])
      await db.query(`DELETE FROM ${table}`);
  } finally {
    await db.end();
  }
  const companies = [
    {
      id: "AM-1",
      name: "架空あおばソフト",
      session: "AM",
      booth: 1,
      industries: ["情報処理"],
      source_page: 2,
    },
    {
      id: "AM-2",
      name: "架空いろは機械",
      session: "AM",
      booth: 2,
      industries: ["機械"],
      source_page: 2,
    },
    {
      id: "PM-1",
      name: "架空みらい建設",
      session: "PM",
      booth: 1,
      industries: ["建設"],
      source_page: 3,
    },
    {
      id: "PM-2",
      name: "架空よつば研究",
      session: "PM",
      booth: 2,
      industries: [
        "研究",
        "架空の研究開発・技術評価・先端素材・環境分析・製造設備・情報技術・共同研究・品質保証・実験支援・産業技術・設計検証・応用研究・技術コンサルティング",
      ],
      source_page: 3,
    },
  ];
  const schedule = Array.from({ length: 8 }, (_, i) => ({
    id: `term-${i + 1}`,
    title: `検証ターム${i + 1}`,
    session: i < 4 ? "AM" : "PM",
    start: `${i < 4 ? "09" : "13"}:${String((i % 4) * 10).padStart(2, "0")}`,
    end: `${i < 4 ? "09" : "13"}:${String((i % 4) * 10 + 5).padStart(2, "0")}`,
    term: i + 1,
    required_grades:
      i === 0 || i === 4
        ? [3, 4]
        : i === 2 || i === 5
          ? [3]
          : i === 3 || i === 7
            ? [4]
            : [],
  }));
  const documents = [
    {
      id: "floor-a",
      title: "検証1階マップ",
      kind: "map",
      mime_type: "image/png",
      file_name: "floor-a.png",
      source_page: 4,
    },
    {
      id: "floor-b",
      title: "検証2階マップ",
      kind: "map",
      mime_type: "image/png",
      file_name: "floor-b.png",
      source_page: 5,
    },
    {
      id: "guide",
      title: "検証用ガイドPDF",
      kind: "guidebook",
      mime_type: "application/pdf",
      file_name: "guide.pdf",
      source_page: 1,
    },
  ].map((d) => ({ ...d, url: `/api/documents/${d.id}` }));
  const dataset = {
    event: {
      title: "架空企業交流会",
      date: "2030-05-14",
      venue: "架空ホール",
      description: "検証専用データ",
    },
    companies,
    schedule,
    assignments: [
      {
        department: "架空工学科",
        grade: 4,
        number: 7,
        visits: [
          { term: 1, company_id: "AM-1" },
          { term: 4, company_id: "AM-2" },
          { term: 5, company_id: "PM-1" },
          { term: 8, company_id: "PM-2" },
        ],
      },
      {
        department:
          "架空の先端情報技術・環境計測・複合材料・機械設計・電気制御・通信技術・社会基盤・応用科学・生産技術・共同研究・技術開発・総合システム工学科",
        grade: 4,
        number: 8,
        visits: [
          { term: 1, company_id: "AM-1" },
          { term: 4, company_id: "AM-2" },
          { term: 5, company_id: "PM-1" },
          { term: 8, company_id: "PM-2" },
        ],
      },
    ],
    documents,
    notices: ["検証用の案内です。実際の配布資料ではありません。"],
  };
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iB2kAAAAASUVORK5CYII=",
    "base64",
  );
  await Promise.all([
    writeFile(resolve(privateDir, "guidance.json"), JSON.stringify(dataset)),
    writeFile(resolve(privateDir, "floor-a.png"), pixel),
    writeFile(resolve(privateDir, "floor-b.png"), pixel),
    writeFile(
      resolve(privateDir, "guide.pdf"),
      "%PDF-1.4\n% Synthetic E2E document\n%%EOF\n",
    ),
  ]);
  await run("go", [
    "run",
    "./cmd/import-guidance",
    "-input",
    resolve(privateDir, "guidance.json"),
  ]);
  if (process.env.E2E_SKIP_BUILD !== "1")
    await run("npm", ["run", "build"], web);
  await run("go", ["build", "-o", resolve(privateDir, "api"), "./cmd/api"]);
  await mkdir(resolve(web, "coverage/e2e/raw"), { recursive: true });
  stop = await startServices(resolve(web, "out"));
  api = spawn(resolve(privateDir, "api"), [], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3371/readyz")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  if (!ready) throw Error("E2E API did not become ready");
  await run("npm", ["run", "test:e2e"], web);
} finally {
  api?.kill("SIGTERM");
  if (stop) await stop();
  await rm(privateDir, { recursive: true, force: true });
}
