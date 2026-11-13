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
  // Measure all authored browser modules, including newly introduced routing,
  // onboarding and map components, instead of silently keeping the initial scope.
  async function modules(directory) {
    const files = [];
    for (const entry of await readdir(resolve(directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await modules(name));
      else if (/\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts") && name !== "lib/types.ts") files.push(name);
    }
    return files;
  }
  const expected = new Set([...await modules("components"), ...await modules("lib")]);
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
      const normalized = name.replaceAll("\\", "/");
      const relative = [...expected].find(file => normalized.endsWith(`/${file}`));
      if (relative) {
        data.path = resolve(relative);
        coverage.addFileCoverage(data);
      }
    }
  }
  const measured = new Set(coverage.files().map(file => file.replaceAll("\\", "/")));
  const missing = [...expected].filter(file => !measured.has(resolve(file).replaceAll("\\", "/")));
  if (missing.length)
    throw Error(`Authored browser modules missing from source coverage: ${missing.join(", ")}`);
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
    `Chromium E2E source line coverage: ${summary.lines.pct}% (V8 mapped to authored TypeScript; WebKit execution and unit coverage are separate).`,
  );
}
