import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServices } from "./e2e-services.mjs";
import {
  syntheticGuidanceClientID,
  syntheticIdentities,
  syntheticTasklyClientID,
  syntheticTasklyClientSecret,
} from "./e2e-identities.mjs";

test("the synthetic issuer joins userinfo and authenticated introspection to the same canonical numeric subject", async () => {
  const output = await mkdtemp(join(tmpdir(), "guidance-issuer-test-"));
  await writeFile(join(output, "index.html"), "Synthetic UI only");
  let stop;
  try {
    stop = await startServices(output);
    const issuer = "http://127.0.0.1:3372";
    const verifier = "synthetic-verifier-with-enough-entropy-for-e2e-only";
    const redirect = "http://127.0.0.1:3371/auth/callback";
    const authorization = new URL(`${issuer}/oauth/authorize`);
    authorization.search = new URLSearchParams({
      client_id: syntheticGuidanceClientID,
      redirect_uri: redirect,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      scope: "taskly:login",
      state: "synthetic-state",
    }).toString();
    const response = await fetch(authorization);
    assert.equal(response.status, 200);
    const id = (await response.text()).match(/name="id" value="([^"]+)"/)[1];
    const login = await fetch(`${issuer}/mock/login`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ id, subject: "home" }),
    });
    assert.equal(login.status, 302);
    const code = new URL(login.headers.get("location")).searchParams.get(
      "code",
    );
    const issued = await fetch(`${issuer}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: syntheticGuidanceClientID,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
    });
    assert.equal(issued.status, 200);
    const { access_token: access } = await issued.json();
    const user = await (
      await fetch(`${issuer}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${access}` },
      })
    ).json();
    assert.equal(user.sub, syntheticIdentities.home);
    const introspect = (authorization) =>
      fetch(`${issuer}/oauth/introspect`, {
        method: "POST",
        headers: { Authorization: authorization },
        body: new URLSearchParams({
          token: access,
          token_type_hint: "access_token",
        }),
      });
    assert.equal(
      (await introspect("Basic invalid-synthetic-client")).status,
      401,
    );
    const basic = `Basic ${Buffer.from(`${syntheticTasklyClientID}:${syntheticTasklyClientSecret}`).toString("base64")}`;
    const identity = await (await introspect(basic)).json();
    assert.equal(identity.active, true);
    assert.equal(identity.sub, user.sub);
    assert.equal(identity.client_id, syntheticGuidanceClientID);
    assert.equal(identity.aud, "taskly-api");
    assert.equal(identity.iss, issuer);
    assert.equal(identity.scope, "taskly:login");
    assert.equal(identity.token_type, "Bearer");
    assert.ok(identity.exp > Date.now() / 1000);
    await fetch(`${issuer}/__test/revoke?subject=home`, { method: "POST" });
    assert.deepEqual(await (await introspect(basic)).json(), { active: false });
    assert.equal(
      (
        await fetch(`${issuer}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${access}` },
        })
      ).status,
      401,
    );
  } finally {
    if (stop) await stop();
    await rm(output, { force: true, recursive: true });
  }
});

test("the synthetic UI matches the public index redirect while canonical shells remain direct downloads", async () => {
  const output = await mkdtemp(join(tmpdir(), "guidance-canonical-ui-test-"));
  const pages = ["", "search", "favorites", "schedule", "documents", "map"];
  for (const page of pages) {
    await mkdir(join(output, page), { recursive: true });
    await writeFile(
      join(output, page, "index.html"),
      `Synthetic ${page || "home"} shell`,
    );
  }
  let stop;
  try {
    stop = await startServices(output);
    const origin = "http://127.0.0.1:3300";
    for (const query of [
      "?company=AM-1&q=synthetic&industry=information&industry=mechanical",
      "?next=//evil.example/path&redirect_uri=https%3A%2F%2Fevil.example%2F&company=AM-1",
      "?//evil.example/path&q=%0d%0aLocation%3Ahttps%3A%2F%2Fevil.example",
    ]) {
      const alias = await fetch(`${origin}/index.html${query}`, {
        redirect: "manual",
      });
      assert.equal(alias.status, 302);
      const target = new URL(alias.headers.get("location"));
      assert.equal(target.origin, origin);
      assert.equal(target.pathname, "/");
      assert.equal(target.search, query);
    }
    await assert.rejects(fetch(`${origin}/index.html`, { redirect: "error" }));
    for (const page of pages) {
      const path = page ? `/${page}/` : "/";
      const response = await fetch(origin + path, { redirect: "error" });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `Synthetic ${page || "home"} shell`);
    }
    assert.equal(
      (await fetch(`${origin}/not-a-page/`, { redirect: "manual" })).status,
      404,
    );
  } finally {
    if (stop) await stop();
    await rm(output, { force: true, recursive: true });
  }
});
