import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { startOfflineWorker } from "./offline-worker.mjs";

const pages = ["", "search", "favorites", "schedule", "documents", "map"];
export async function generateOfflineShell(root) {
  const paths = pages.map((page) =>
    page ? `/${page}/index.html` : "/index.html",
  );
  paths.push("/taskly-logo.svg");
  async function collect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isSymbolicLink())
        throw new Error("Offline shell symlinks are forbidden");
      if (item.isDirectory()) await collect(path);
      else if (item.isFile() && /\.(js|css|woff2?|svg|png)$/.test(item.name))
        paths.push("/" + relative(root, path).replaceAll("\\", "/"));
    }
  }
  await collect(resolve(root, "_next/static"));
  const assets = await Promise.all(
    paths.sort().map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(resolve(root, "." + path)))
        .digest("hex"),
    })),
  );
  const routes = pages.flatMap((page) => {
    const route = page ? `/${page}/` : "/";
    const file = `${route}index.html`;
    return [[route, file], [file, file], ...(page ? [[`/${page}`, file]] : [])];
  });
  const runtime = startOfflineWorker.toString();
  const revision = createHash("sha256")
    .update(JSON.stringify({ assets, routes, runtime }))
    .digest("hex");
  await writeFile(
    resolve(root, "offline-worker.js"),
    `// Public static shell only; no account data or API responses.\n(${runtime})(self,${JSON.stringify({ revision, assets, routes })});\n`,
  );
  return { revision, assets, routes };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await generateOfflineShell(resolve(process.argv[2] || "apps/web/out"));
