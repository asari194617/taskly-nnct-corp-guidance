import { readFileSync, writeFileSync } from "node:fs";

const [kind, input, output, minimumArg = "0", ...filterArgs] =
  process.argv.slice(2);
if (!kind || !input || !output) {
  throw new Error(
    "Usage: coverage-summary.mjs <go|go-profile|istanbul|lcov> <input> <output> [minimum] [--include-path <literal-file-or-directory/> | --include-prefix <literal-Go-file-prefix>]",
  );
}
const includePath = filterArgs[1];
const includePrefix = filterArgs[0] === "--include-prefix";
if (
  filterArgs.length &&
  ((kind !== "go-profile" && kind !== "lcov") ||
    filterArgs.length !== 2 ||
    (filterArgs[0] !== "--include-path" &&
      !(kind === "go-profile" && includePrefix)) ||
    !includePath ||
    includePath.length > 4096 ||
    includePath.trim() !== includePath ||
    /[\s\\\0]/.test(includePath) ||
    includePath
      .split("/")
      .some(
        (segment, index, parts) =>
          segment === "." ||
          segment === ".." ||
          (!segment && index !== parts.length - 1),
      ))
)
  throw new Error("Invalid literal coverage include path");

let percent;
let statements;
if (kind === "go") {
  const match = readFileSync(input, "utf8").match(
    /^total:\s+\(statements\)\s+([\d.]+)%\s*$/m,
  );
  if (!match) throw new Error(`Go coverage total is missing from ${input}`);
  percent = Number(match[1]);
} else if (kind === "go-profile") {
  let covered = 0;
  let total = 0;
  for (const line of readFileSync(input, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const match = line.match(/^(.*):\d+\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)$/);
    if (!match) throw new Error(`Invalid Go coverage profile line: ${line}`);
    // Prefix mode is literal startsWith; path mode keeps exact-file/directory semantics.
    if (
      includePath &&
      (includePrefix || includePath.endsWith("/")
        ? !match[1].startsWith(includePath)
        : match[1] !== includePath)
    )
      continue;
    const statements = Number(match[2]);
    total += statements;
    if (Number(match[3]) > 0) covered += statements;
  }
  if (total === 0)
    throw new Error(`Go coverage profile has no matching statements: ${input}`);
  percent = (covered / total) * 100;
  if (includePrefix) statements = { covered, total };
} else if (kind === "istanbul") {
  percent = JSON.parse(readFileSync(input, "utf8")).total?.lines?.pct;
} else if (kind === "lcov") {
  let total = 0,
    covered = 0;
  for (const record of readFileSync(input, "utf8").split("end_of_record")) {
    const file = record.match(/^SF:(.+)$/m)?.[1];
    if (
      !file ||
      (includePath &&
        (includePath.endsWith("/")
          ? !file.startsWith(includePath)
          : file !== includePath))
    )
      continue;
    const found = record.match(/^LF:(\d+)$/m)?.[1];
    const hit = record.match(/^LH:(\d+)$/m)?.[1];
    if (found === undefined || hit === undefined || Number(hit) > Number(found))
      throw new Error(`Invalid LCOV line totals: ${file}`);
    total += Number(found);
    covered += Number(hit);
  }
  if (total === 0)
    throw new Error(`LCOV has no matching runtime lines: ${input}`);
  percent = (covered / total) * 100;
} else {
  throw new Error(`Unknown coverage format: ${kind}`);
}

if (
  typeof percent !== "number" ||
  !Number.isFinite(percent) ||
  percent < 0 ||
  percent > 100
) {
  throw new Error(`Invalid coverage percentage: ${percent}`);
}
const minimum = Number(minimumArg);
if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
  throw new Error(`Invalid minimum coverage percentage: ${minimumArg}`);
}
writeFileSync(output, `${JSON.stringify({ percent, ...statements })}\n`);
if (percent < minimum) {
  throw new Error(
    `Coverage ${percent.toFixed(1)}% is below the ${minimum.toFixed(1)}% minimum`,
  );
}
