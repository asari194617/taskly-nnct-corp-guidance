import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import v8toIstanbul from "v8-to-istanbul";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

export default async function reportBrowserCoverage() {
  const output = resolve("coverage/e2e"),
    root = resolve("out");
  const inputs = await readdir(resolve(output, "raw"));
  const sources = new Map(),
    processes = [];
  for (const file of inputs) {
    const entries = JSON.parse(
      await readFile(resolve(output, "raw", file), "utf8"),
    ).filter(
      (e) =>
        e.url.startsWith("http://127.0.0.1:3300/_next/") &&
        e.url.endsWith(".js"),
    );
    for (const entry of entries) sources.set(entry.url, entry.source);
    processes.push({
      result: entries.map((entry, i) => ({
        scriptId: String(i),
        url: entry.url,
        functions: entry.functions,
      })),
    });
  }
  const merged = mergeProcessCovs(processes),
    coverage = libCoverage.createCoverageMap({});
  for (const entry of merged.result) {
    const path = new URL(entry.url).pathname;
    const script = resolve(root, `.${path}`);
    // Next's Turbopack hashes the map independently from the JS filename.
    // v8-to-istanbul resolves its sourceMappingURL relative to this disk path.
    const converter = v8toIstanbul(script, 0, {
      source: sources.get(entry.url),
    });
    await converter.load();
    converter.applyCoverage(entry.functions);
    for (const [name, data] of Object.entries(converter.toIstanbul())) {
      const match = name
        .replaceAll("\\", "/")
        .match(/\/(components\/(?:guidance-app|icons)\.tsx|lib\/api\.ts)$/);
      if (match) {
        data.path = resolve(match[1]);
        coverage.addFileCoverage(data);
      }
    }
  }
  if (coverage.files().length !== 3)
    throw Error(
      `Expected all 3 authored browser modules in source coverage, found ${coverage.files().length}`,
    );
  await mkdir(output, { recursive: true });
  const context = libReport.createContext({
    dir: output,
    coverageMap: coverage,
  });
  for (const name of ["json-summary", "lcovonly", "html", "text-summary"])
    reports.create(name).execute(context);
  const summary = coverage.getCoverageSummary().toJSON();
  await writeFile(
    resolve("../../e2e.json"),
    JSON.stringify({ percent: summary.lines.pct }) + "\n",
  );
  console.log(
    `Browser E2E source line coverage: ${summary.lines.pct}% (V8 mapped to authored TypeScript; separate from unit coverage).`,
  );
}
