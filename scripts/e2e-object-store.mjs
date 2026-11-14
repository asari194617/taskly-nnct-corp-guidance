import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// This loopback-only object store is a test double, never a production service.
// Its independent SigV4 implementation checks the Go SDK's real presigned URLs.
export const syntheticObjectStore = {
  bucket: "synthetic-guidance-documents",
  accessKey: "synthetic-r2-access",
  secretKey: "synthetic-r2-secret-never-production",
};
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function signatureForURL(url, method, secretKey) {
  const scope = url.searchParams.get("X-Amz-Credential").split("/").slice(1);
  const query = [...url.searchParams]
    .filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
          ? 1
          : a[1] < b[1]
            ? -1
            : a[1] > b[1]
              ? 1
              : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [
    method,
    url.pathname,
    query,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const signingKey = scope.reduce(
    (key, value) => hmac(key, value),
    Buffer.from(`AWS4${secretKey}`),
  );
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    url.searchParams.get("X-Amz-Date"),
    scope.join("/"),
    sha(canonical),
  ].join("\n");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

export function validObjectRequest(url, method, now = Date.now()) {
  const query = url.searchParams;
  for (const parameter of [
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-SignedHeaders",
    "X-Amz-Signature",
  ]) {
    if (query.getAll(parameter).length !== 1) return false;
  }
  if (
    query.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    query.get("X-Amz-SignedHeaders") !== "host"
  )
    return false;
  const credential = query.get("X-Amz-Credential").split("/");
  const date = query.get("X-Amz-Date");
  if (
    !/^\d{8}T\d{6}Z$/.test(date) ||
    credential.length !== 5 ||
    credential[0] !== syntheticObjectStore.accessKey ||
    credential[1] !== date.slice(0, 8) ||
    credential[2] !== "auto" ||
    credential[3] !== "s3" ||
    credential[4] !== "aws4_request"
  )
    return false;
  const issued = Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
  );
  const duration = query.get("X-Amz-Expires");
  if (
    !/^\d+$/.test(duration) ||
    Number(duration) < 1 ||
    Number(duration) > 300 ||
    !Number.isFinite(issued) ||
    now < issued - 5000 ||
    now >= issued + Number(duration) * 1000
  )
    return false;
  const supplied = query.get("X-Amz-Signature");
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(
    Buffer.from(supplied, "hex"),
    Buffer.from(
      signatureForURL(url, method, syntheticObjectStore.secretKey),
      "hex",
    ),
  );
}

export async function startObjectStore(
  directory,
  { port = 3373, now = Date.now } = {},
) {
  let clockOffset = 0;
  const objects = new Map([
    ["floor-a.png", "image/png"],
    ["floor-b.png", "image/png"],
    ["guide.pdf", "application/pdf"],
  ]);
  const ui = "http://127.0.0.1:3300";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      // Only the disposable harness can advance its own clock. Browser origins
      // cannot call this endpoint, and production never imports this server.
      if (url.pathname === "/__test/clock") {
        const reply = (status, body) => {
          res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(body));
        };
        if (req.headers.host !== `127.0.0.1:${server.address().port}` ||
            req.socket.remoteAddress !== "127.0.0.1" || req.headers.origin)
          return reply(403, { error: "forbidden" });
        if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
        if (req.headers["content-type"] !== "application/json")
          return reply(415, { error: "json_required" });
        if (url.search) return reply(400, { error: "invalid_clock" });
        let body = "";
        for await (const part of req) {
          body += part;
          if (Buffer.byteLength(body) > 256) return reply(413, { error: "oversized_clock" });
        }
        let value;
        try { value = JSON.parse(body); }
        catch { return reply(400, { error: "invalid_clock" }); }
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            Object.keys(value).length !== 1 || !Number.isInteger(value.offset_ms) ||
            value.offset_ms < 0 || value.offset_ms > 3_600_000)
          return reply(400, { error: "invalid_clock" });
        clockOffset = value.offset_ms;
        return reply(200, { offset_ms: clockOffset });
      }
      const origin = req.headers.origin;
      if (origin === ui) {
        res.setHeader("Access-Control-Allow-Origin", ui);
        res.setHeader(
          "Access-Control-Expose-Headers",
          "Accept-Ranges, Content-Length, Content-Range",
        );
      }
      if (req.method === "OPTIONS") {
        if (origin !== ui) {
          res.writeHead(403);
          return res.end();
        }
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, HEAD",
          "Access-Control-Allow-Headers": "Range",
        });
        return res.end();
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        return res.end();
      }
      if (!validObjectRequest(url, req.method, now() + clockOffset)) {
        res.writeHead(403);
        return res.end();
      }
      const pieces = decodeURIComponent(url.pathname).split("/");
      const file = pieces[2];
      if (
        pieces.length !== 3 ||
        pieces[1] !== syntheticObjectStore.bucket ||
        !objects.has(file)
      ) {
        res.writeHead(404);
        return res.end();
      }
      const body = await readFile(resolve(directory, file));
      const headers = {
        "Content-Type":
          url.searchParams.get("response-content-type") || objects.get(file),
        "Content-Disposition":
          url.searchParams.get("response-content-disposition") ||
          `inline; filename="${file}"`,
        "Cache-Control":
          url.searchParams.get("response-cache-control") || "no-store",
        "Accept-Ranges": "bytes",
        "Content-Length": body.length,
      };
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        const first = range ? Number(range[1]) : NaN;
        const last =
          range && range[2]
            ? Math.min(Number(range[2]), body.length - 1)
            : body.length - 1;
        if (!Number.isFinite(first) || first > last || first >= body.length) {
          res.writeHead(416, { "Content-Range": `bytes */${body.length}` });
          return res.end();
        }
        res.writeHead(206, {
          ...headers,
          "Content-Range": `bytes ${first}-${last}/${body.length}`,
          "Content-Length": last - first + 1,
        });
        return res.end(
          req.method === "HEAD" ? undefined : body.subarray(first, last + 1),
        );
      }
      res.writeHead(200, headers);
      return res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((ok, fail) =>
    server.once("error", fail).listen(port, "127.0.0.1", ok),
  );
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
