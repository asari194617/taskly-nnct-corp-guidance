import { readFileSync, writeFileSync } from "node:fs";

const [kind, input, output, minimumArg = "0", includePattern = ""] = process.argv.slice(2);
if (!kind || !input || !output) {
  throw new Error("Usage: coverage-summary.mjs <go|go-profile|istanbul> <input> <output> [minimum] [include-regex]");
}

let percent;
if (kind === "go") {
  const match = readFileSync(input, "utf8").match(/^total:\s+\(statements\)\s+([\d.]+)%\s*$/m);
  if (!match) throw new Error(`Go coverage total is missing from ${input}`);
  percent = Number(match[1]);
} else if (kind === "go-profile") {
  const include = includePattern ? new RegExp(includePattern) : null;
  let covered = 0;
  let total = 0;
  for (const line of readFileSync(input, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const match = line.match(/^(.*):\d+\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)$/);
    if (!match) throw new Error(`Invalid Go coverage profile line: ${line}`);
    if (include && !include.test(match[1])) continue;
    const statements = Number(match[2]);
    total += statements;
    if (Number(match[3]) > 0) covered += statements;
  }
  if (total === 0) throw new Error(`Go coverage profile has no matching statements: ${input}`);
  percent = (covered / total) * 100;
} else if (kind === "istanbul") {
  percent = JSON.parse(readFileSync(input, "utf8")).total?.lines?.pct;
} else {
  throw new Error(`Unknown coverage format: ${kind}`);
}

if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
  throw new Error(`Invalid coverage percentage: ${percent}`);
}
const minimum = Number(minimumArg);
if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
  throw new Error(`Invalid minimum coverage percentage: ${minimumArg}`);
}
writeFileSync(output, JSON.stringify({ percent }) + "\n");
if (percent < minimum) {
  throw new Error(`Coverage ${percent.toFixed(1)}% is below the ${minimum.toFixed(1)}% minimum`);
}
