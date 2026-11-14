import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import {
  signatureForURL,
  validObjectRequest,
  startObjectStore,
  syntheticObjectStore,
} from "./e2e-object-store.mjs";

const now = Date.parse("2030-05-14T09:00:00Z");
function signed(
  origin = "http://127.0.0.1:3373",
  { method = "GET", file = "guide.pdf", expires = 300 } = {},
) {
  const url = new URL(`/${syntheticObjectStore.bucket}/${file}`, origin);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set(
    "X-Amz-Credential",
    `${syntheticObjectStore.accessKey}/20300514/auto/s3/aws4_request`,
  );
  url.searchParams.set("X-Amz-Date", "20300514T090000Z");
  url.searchParams.set("X-Amz-Expires", String(expires));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  url.searchParams.set(
    "response-content-disposition",
    'inline; filename="guide.pdf"',
  );
  url.searchParams.set("response-content-type", "application/pdf");
  url.searchParams.set("response-cache-control", "no-store");
  url.searchParams.set(
    "X-Amz-Signature",
    signatureForURL(url, method, syntheticObjectStore.secretKey),
  );
  return url;
}

test("the independent signer matches the published AWS SigV4 query example", () => {
  // Public example credentials and expected signature, not usable credentials:
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html
  const url = new URL(
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
  );
  assert.equal(
    signatureForURL(url, "GET", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("presigned access binds method, path, query, key and a maximum five-minute lifetime", () => {
  const original = signed();
  assert.equal(validObjectRequest(original, "GET", now), true);
  assert.equal(validObjectRequest(original, "HEAD", now), false);
  assert.equal(validObjectRequest(original, "GET", now + 300_000), false);
  assert.equal(validObjectRequest(original, "GET", now - 60_000), false);
  assert.equal(
    validObjectRequest(signed(undefined, { expires: 301 }), "GET", now),
    false,
  );
  for (const mutate of [
    (url) => {
      url.pathname = `/${syntheticObjectStore.bucket}/floor-a.png`;
    },
    (url) => {
      url.searchParams.set("response-content-type", "text/html");
    },
    (url) => {
      url.searchParams.set("X-Amz-Signature", "0".repeat(64));
    },
    (url) => {
      url.searchParams.set(
        "X-Amz-Credential",
        "wrong/20300514/auto/s3/aws4_request",
      );
    },
    (url) => {
      url.searchParams.append("X-Amz-Expires", "300");
    },
  ]) {
    const changed = new URL(original);
    mutate(changed);
    assert.equal(validObjectRequest(changed, "GET", now), false);
  }
});

test("the loopback object store serves signed bytes and ranges, rejects unsigned URLs and limits CORS", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "synthetic-object-store-"));
  await writeFile(resolve(directory, "guide.pdf"), "%PDF-1.4 synthetic object");
  const store = await startObjectStore(directory, { port: 0, now: () => now });
  try {
    const url = signed(store.origin);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "%PDF-1.4 synthetic object");
    const range = await fetch(url, {
      headers: { Range: "bytes=0-3", Origin: "http://127.0.0.1:3300" },
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "%PDF");
    assert.equal(
      range.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:3300",
    );
    assert.equal(
      (await fetch(url, { headers: { Range: "bytes=999-" } })).status,
      416,
    );
    const untrusted = await fetch(url, {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(untrusted.status, 200);
    assert.equal(untrusted.headers.get("access-control-allow-origin"), null);
    assert.equal(
      (
        await fetch(url, {
          method: "OPTIONS",
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(new URL(url.pathname, store.origin))).status,
      403,
    );
    assert.equal((await fetch(url, { method: "HEAD" })).status, 403);
    const head = await fetch(signed(store.origin, { method: "HEAD" }), {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.equal(
      (await fetch(signed(store.origin, { file: "unlisted.pdf" }))).status,
      404,
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the synthetic clock expires real signed requests and resets without exposing credentials", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "synthetic-object-clock-"));
  await writeFile(
    resolve(directory, "guide.pdf"),
    "%PDF-1.4 synthetic clock object",
  );
  const store = await startObjectStore(directory, { port: 0, now: () => now });
  const clock = new URL("/__test/clock", store.origin);
  const update = (value, headers = {}, target = clock) =>
    fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
  try {
    const document = signed(store.origin);
    assert.equal((await fetch(document)).status, 200);
    const advanced = await update({ offset_ms: 301_000 });
    assert.equal(advanced.status, 200);
    assert.equal(advanced.headers.get("cache-control"), "no-store");
    assert.deepEqual(await advanced.json(), { offset_ms: 301_000 });
    assert.equal((await fetch(document)).status, 403);
    assert.equal((await update({ offset_ms: 0 })).status, 200);
    assert.equal((await fetch(document)).status, 200);

    for (const invalid of [
      null,
      [],
      {},
      { offset_ms: -1 },
      { offset_ms: 3_600_001 },
      { offset_ms: 1.5 },
      { offset_ms: "0" },
      { offset_ms: 0, extra: true },
      "invalid JSON",
    ])
      assert.equal((await update(invalid)).status, 400);
    assert.equal((await update(" ".repeat(257))).status, 413);
    assert.equal((await fetch(clock)).status, 405);
    assert.equal(
      (await update({ offset_ms: 0 }, { "Content-Type": "text/plain" })).status,
      415,
    );
    assert.equal(
      (await update({ offset_ms: 0 }, { Origin: "http://127.0.0.1:3300" }))
        .status,
      403,
    );
    const forgedHostStatus = await new Promise((done, fail) => {
      const request = httpRequest(
        clock,
        {
          method: "POST",
          headers: {
            Host: "untrusted.example",
            "Content-Type": "application/json",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => done(response.statusCode));
        },
      );
      request.on("error", fail);
      request.end(JSON.stringify({ offset_ms: 0 }));
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal(
      (await update({ offset_ms: 0 }, {}, new URL("?unexpected=1", clock)))
        .status,
      400,
    );
    assert.equal(
      (await fetch(document)).status,
      200,
      "rejected clock changes preserve the current time",
    );
  } finally {
    await update({ offset_ms: 0 });
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
