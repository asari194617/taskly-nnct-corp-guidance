import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServices } from "./e2e-services.mjs";
import { startObjectStore, syntheticObjectStore } from "./e2e-object-store.mjs";
import {
  syntheticGuidanceClientID,
  syntheticEventID,
  syntheticTasklyClientID,
  syntheticTasklyClientSecret,
} from "./e2e-identities.mjs";

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
if (host !== "127.0.0.1")
  throw Error("The two-service E2E stack requires loopback MySQL (127.0.0.1)");
if (!password)
  throw Error("E2E_MYSQL_PASSWORD required (disposable MySQL only)");
const dsn = `${user}:${password}@tcp(${host}:${port})/${database}?parseTime=true&charset=utf8mb4&loc=UTC`;
// The second checkout is pinned by CI to a reviewed immutable Taskly commit.
// Importing its actual bridge and GraphQL implementation proves both services
// agree on identity, event binding and the canonical MySQL completion records.
if (!process.env.E2E_TASKLY_DIR)
  throw Error("E2E_TASKLY_DIR must point to the reviewed Taskly checkout");
const tasklyServer = resolve(process.env.E2E_TASKLY_DIR, "apps/server");
await readFile(resolve(tasklyServer, "cmd/guidance-e2e/main.go"));
const tasklyDatabase = "taskly_guidance_e2e";
const tasklyDSN = `${user}:${password}@tcp(${host}:${port})/${tasklyDatabase}?parseTime=true&charset=utf8mb4&loc=UTC`;
const privateDir = await mkdtemp(resolve(tmpdir(), "guidance-e2e-"));
const env = {
  ...process.env,
  MYSQL_DSN: dsn,
  SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
  UI_ORIGIN: "http://127.0.0.1:3300",
  API_ORIGIN: "http://127.0.0.1:3371",
  AUTH_ISSUER: "http://127.0.0.1:3372",
  AUTH_CLIENT_ID: syntheticGuidanceClientID,
  DATA_DIR: privateDir,
  DOCUMENT_STORAGE: "r2",
  R2_ENDPOINT: "http://127.0.0.1:3373",
  R2_BUCKET: syntheticObjectStore.bucket,
  R2_ACCESS_KEY_ID: syntheticObjectStore.accessKey,
  R2_SECRET_ACCESS_KEY: syntheticObjectStore.secretKey,
  ADDR: "127.0.0.1:3371",
  NEXT_PUBLIC_API_URL: "http://127.0.0.1:3371",
  E2E_COVERAGE: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  TASKLY_API_ORIGIN: "http://127.0.0.1:3374",
  TASKLY_GUIDANCE_EVENT_ID: syntheticEventID,
};
const run = (command, args, cwd = root) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? ok() : fail(Error(`${command} exited ${code}`)),
    );
  });
let api, taskly, stop, objectStore;
async function waitReady(url, service) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`E2E ${service} did not become ready`);
}
try {
  // Both harness checks use loopback ports and run before any long-lived stack.
  await run(process.execPath, ["--test", "--test-concurrency=1", "scripts/e2e-object-store.test.mjs", "scripts/e2e-services.test.mjs"]);
  const administrator = await mysql.createConnection({ host, port, user, password });
  try {
    // Exact synthetic name, never accepted from arbitrary environment input.
    // Taskly's harness additionally requires an entirely empty *_e2e database.
    await administrator.query(`DROP DATABASE IF EXISTS ${tasklyDatabase}`);
    await administrator.query(`CREATE DATABASE ${tasklyDatabase} CHARACTER SET utf8mb4`);
  } finally {
    await administrator.end();
  }
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
      "guidance_preferences",
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
      name: "架空よつば研究・環境設備・情報技術・共同研究開発センター株式会社",
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
      i === 0 || i === 5
        ? [3, 4]
        : i === 1 || i === 4
          ? [3]
          : i === 2 || i === 6
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
      booths: [
        { booth: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        { booth: 2, x: 0.55, y: 0.1, width: 0.2, height: 0.2 },
      ],
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
      task_actions: {
        visit_survey: { url: "https://forms.example.test/synthetic-visit", due_at: "2030-05-15T09:00:00+09:00" },
        overall_survey: { url: "https://forms.example.test/synthetic-overall", due_at: "2030-05-16T09:00:00+09:00" },
        sheet_submission: { document_id: "guide", page: 25, due_at: "2030-05-17T09:00:00+09:00" },
      },
    },
    companies,
    schedule,
    assignments: [
      {
        department: "電子制御工学科",
        grade: 4,
        number: 7,
        visits: [
          { term: 1, company_id: "AM-1" },
          { term: 3, company_id: "AM-2" },
          { term: 6, company_id: "PM-1" },
          { term: 7, company_id: "PM-2" },
        ],
      },
      {
        department: "電子制御工学科",
        grade: 4,
        number: 8,
        visits: [
          { term: 1, company_id: "AM-2" },
          { term: 3, company_id: "AM-1" },
          { term: 6, company_id: "PM-2" },
          { term: 7, company_id: "PM-1" },
        ],
      },
      {
        department: "電子制御工学科",
        grade: 4,
        number: 9,
        visits: [
          { term: 1, company_id: "AM-1" },
          { term: 3, company_id: "AM-1" },
          { term: 6, company_id: "PM-1" },
          { term: 7, company_id: "PM-1" },
        ],
      },
    ],
    documents,
    notices: ["検証用の案内です。実際の配布資料ではありません。"],
    notice_sections: [
      {
        id: "preparation",
        title: "見学前の準備",
        blocks: [
          { type: "paragraph", text: "検証用の持ち物案内です。" },
          { type: "list", items: ["検証用の筆記具", "検証用の名札"] },
        ],
      },
      {
        id: "questions",
        title: "質問するとき",
        blocks: [{ type: "paragraph", text: "検証用の質問を整理しましょう。" }],
      },
    ],
  };
  // Synthetic white paper and black booth numerals allow the browser tests to
  // verify the rendered dark drawing, independently of CSS filter declarations.
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  };
  const width = 100,
    height = 100;
  const raster = Buffer.alloc(height * (width * 3 + 1), 255);
  for (let y = 0; y < height; y++) raster[y * (width * 3 + 1)] = 0;
  for (const [center, glyph] of [
    [20, ["010", "110", "010", "010", "111"]],
    [65, ["111", "001", "111", "100", "111"]],
  ]) {
    for (let row = 0; row < glyph.length; row++)
      for (let column = 0; column < 3; column++) {
        if (glyph[row][column] !== "1") continue;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const offset =
              (15 + row * 2 + dy) * (width * 3 + 1) +
              1 +
              (center - 3 + column * 2 + dx) * 3;
            raster.fill(0, offset, offset + 3);
          }
      }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixel = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  // Physical page 25 must exist: testing only a URL fragment against a one-page
  // PDF would not prove the report sheet can actually be reached.
  const pageCount = 26;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let page = 1; page <= pageCount; page++) {
    const stream = `BT /F1 12 Tf 20 100 Td (Synthetic physical page ${page}) Tj ET`;
    const contentID = objects.length + 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentID} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const crossReference = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF\n`;
  await Promise.all([
    writeFile(resolve(privateDir, "guidance.json"), JSON.stringify(dataset)),
    writeFile(resolve(privateDir, "floor-a.png"), pixel),
    writeFile(resolve(privateDir, "floor-b.png"), pixel),
    writeFile(resolve(privateDir, "guide.pdf"), pdf),
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
  await run("go", ["build", "-o", resolve(privateDir, "taskly"), "./cmd/guidance-e2e"], tasklyServer);
  await mkdir(resolve(web, "coverage/e2e/raw"), { recursive: true });
  objectStore = await startObjectStore(privateDir);
  stop = await startServices(resolve(web, "out"));
  taskly = spawn(resolve(privateDir, "taskly"), [], {
    cwd: tasklyServer,
    env: {
      ...env,
      NODE_ENV: "test",
      TASKLY_GUIDANCE_E2E: "1",
      TASKLY_E2E_MYSQL_DSN: tasklyDSN,
      ADDR: "127.0.0.1:3374",
      AUTH_CLIENT_ID: syntheticTasklyClientID,
      AUTH_CLIENT_SECRET: syntheticTasklyClientSecret,
      NNCT_GUIDANCE_EVENT_ID: syntheticEventID,
      WEB_PUBLIC_URL: "http://127.0.0.1:3374",
    },
    stdio: "inherit",
  });
  await waitReady("http://127.0.0.1:3374/__test/ready", "Taskly bridge");
  api = spawn(resolve(privateDir, "api"), [], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  await waitReady("http://127.0.0.1:3371/readyz", "guidance API");
  await run("npm", ["run", "test:e2e"], web);
} finally {
  api?.kill("SIGTERM");
  taskly?.kill("SIGTERM");
  if (stop) await stop();
  if (objectStore) await objectStore.close();
  await rm(privateDir, { recursive: true, force: true });
}
