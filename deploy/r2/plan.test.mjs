import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metadata, files, secureHTML, prepare } from "./plan.mjs";
test("private documents and unknown types cannot be uploaded", () => {
  for (const key of [
    "private/source.png",
    "data/example.txt",
    "handbook.pdf",
    ".env.txt",
    "source.map",
    "data.json",
  ])
    assert.throws(() => metadata(key));
  assert.equal(
    metadata("_next/static/a.js").CacheControl,
    "public, max-age=31536000, immutable",
  );
  assert.equal(metadata("index.html").CacheControl, "no-cache");
});
test("public JPEG OGP uses its actual MIME without admitting private images or PDFs", () => {
  assert.deepEqual(metadata("ogp.jpg"), {
    ContentType: "image/jpeg",
    CacheControl: "no-cache",
  });
  assert.equal(
    metadata("ogp.jpg").CacheControl,
    metadata("logo.png").CacheControl,
  );
  for (const key of ["private/ogp.jpg", "data/ogp.jpg", "guidebook.pdf"])
    assert.throws(() => metadata(key));
});
test("CSP hashes bootstrap bytes and permits only trusted signed document image origins", () => {
  const script = 'self.__next_f.push([1,"synthetic"]);';
  const html = secureHTML(
    `<html><head><script>${script}</script><script src="/app.js"></script></head></html>`,
    "https://api.example.test",
  );
  assert.ok(
    html.includes(
      `sha256-${createHash("sha256").update(script).digest("base64")}`,
    ),
  );
  assert.ok(html.includes("connect-src 'self' https://api.example.test"));
  assert.ok(html.includes("worker-src 'self'"));
  assert.ok(
    html.includes(
      "img-src 'self' blob: https://cdn.taskly.iy0306.com https://api.example.test",
    ),
  );
  assert.ok(html.includes("frame-src 'none'"));
  assert.ok(html.includes("object-src 'none'"));
  assert.ok(!html.includes("connect-src blob:"));
  assert.throws(() => secureHTML("<head>", "http://api.example.test"));
  assert.throws(() => secureHTML("<head>", "https://api.example.test/path"));
  const documents = secureHTML(
    "<head>",
    "https://api.example.test",
    "https://private.example.test",
  );
  assert.ok(
    documents.includes(
      "img-src 'self' blob: https://cdn.taskly.iy0306.com https://api.example.test https://private.example.test",
    ),
  );
  assert.ok(
    documents.includes(
      "connect-src 'self' https://api.example.test https://private.example.test",
    ),
  );
  for (const origin of [
    "http://private.example.test",
    "https://private.example.test/path",
    "https://private.example.test/?token=secret",
    "https://user:secret@private.example.test",
  ])
    assert.throws(() =>
      secureHTML("<head>", "https://api.example.test", origin),
    );
});
const scriptHash = (body) =>
  `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
function assertScriptHashes(source, bodies) {
  const secured = secureHTML(source, "https://api.example.test");
  const scriptPolicy = secured.match(/script-src 'self' ([^;]*);/)[1];
  assert.deepEqual(scriptPolicy.match(/'sha256-[^']+'/g) ?? [], [
    ...new Set(bodies.map(scriptHash)),
  ]);
  // Discovery must never serialize, reformat, decode, or rewrite the source.
  assert.equal(
    secured.replace(
      /<meta http-equiv="Content-Security-Policy" content="[^"]*"><meta name="referrer" content="no-referrer">/,
      "",
    ),
    source,
  );
}
test("HTML parser recognizes browser-valid whitespace and case in script end tags", () => {
  const body = '  self.__next_f.push([1,"synthetic 日本語"]);\n';
  for (const closing of [
    "</script >",
    "</ScRiPt>",
    "</SCRIPT\t\n >",
    "</script/>",
    '</script ignored="value > end">',
  ])
    assertScriptHashes(`<html><head><ScRiPt>${body}${closing}</head></html>`, [
      body,
    ]);
});
test("real parsed src attributes exclude external scripts, including empty and boolean attributes", () => {
  for (const attribute of [
    'src="/app.js"',
    'SRC = "/app.js?value=>"',
    "sRc\n=\t''",
    "src",
    'src="" data-value="inline > text"',
  ])
    assertScriptHashes(
      `<head><script ${attribute}>ignoredInlineBody();</script ></head>`,
      [],
    );
});
test("quoted angle brackets, data-src and src-like text do not masquerade as src attributes", () => {
  const body = "const attributeText = 'src=\"not-an-attribute\"';";
  for (const attribute of [
    'data-src="/fake.js"',
    "data-note=\"src='/fake.js' > text\"",
    "data-note='> SRC=\"/fake.js\"'",
    'src-not="/fake.js"',
  ])
    assertScriptHashes(`<head><script ${attribute}>${body}</script></head>`, [
      body,
    ]);
});
test("only actual script nodes are hashed, excluding comments, raw text and inert template content", () => {
  const body = "actualBootstrap();";
  assertScriptHashes(
    `<html><head><title><script>titleOnly();</script></title><style><script>styleOnly();</script></style><noscript><script>noscriptOnly();</script></noscript></head><body><!-- <script>commentOnly();</script> --><textarea><script>textareaOnly();</script></textarea><iframe><script>iframeOnly();</script></iframe><template><script>templateOnly();</script></template><script>${body}</script></body></html>`,
    [body],
  );
});
test("script raw text keeps entities, whitespace and script-like strings exactly as parsed by browsers", () => {
  const body =
    '\n  const text = "&lt;tag&gt; &amp; &#x41;";\nconst nested = \'<script src="synthetic">\';\n';
  assertScriptHashes(`<head><script>${body}</script ></head>`, [body]);
  const escaped = "<!--<script>synthetic();</script>-->tail();";
  assertScriptHashes(`<head><script>${escaped}</script ></head>`, [escaped]);
});
test("browser newline normalization affects CSP hashes while original HTML bytes stay intact", () => {
  const body = '\r\nconst message = "日本語";\rnext();\n';
  assertScriptHashes(`<head><script>${body}</script ></head>`, [
    '\nconst message = "日本語";\nnext();\n',
  ]);
});
test("empty scripts are omitted, repeated bodies are deduplicated, and unclosed raw text is parsed through EOF", () => {
  const body = "bootstrap();";
  assertScriptHashes(
    `<head><script></script><script>${body}</script><script>${body}</script></head>`,
    [body],
  );
  assertScriptHashes("<head></head><body><script>throughEOF();", [
    "throughEOF();",
  ]);
});
test("assets precede HTML; index required; symlinks rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnct-r2-test-"));
  try {
    await assert.rejects(prepare(root, "https://api.example.test"));
    await writeFile(join(root, "index.html"), "<html><head></head></html>");
    await mkdir(join(root, "_next"));
    await writeFile(join(root, "_next", "a.js"), "");
    assert.deepEqual(await files(root), ["_next/a.js", "index.html"]);
    await mkdir(join(root, "_next/static"));
    await writeFile(join(root, "_next/static", "a.js"), "");
    await writeFile(join(root, "taskly-logo.svg"), "<svg/>");
    for (const route of [
      "search",
      "favorites",
      "schedule",
      "documents",
      "map",
    ]) {
      await mkdir(join(root, route));
      await writeFile(
        join(root, route, "index.html"),
        "<html><head></head></html>",
      );
    }
    const keys = await prepare(root, "https://api.example.test");
    assert.equal(keys.at(-1), "offline-worker.js");
    assert.equal(metadata("offline-worker.js").CacheControl, "no-cache");
    const worker = await readFile(join(root, "offline-worker.js"), "utf8");
    assert.ok(
      worker.includes(
        createHash("sha256")
          .update(await readFile(join(root, "index.html")))
          .digest("hex"),
      ),
    );
    await symlink(join(root, "index.html"), join(root, "link.html"));
    await assert.rejects(files(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
