import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import {
  syntheticIdentities,
  syntheticGuidanceClientID,
  syntheticTasklyClientID,
  syntheticTasklyClientSecret,
} from "./e2e-identities.mjs";

// Only synthetic identities and data are accepted. These servers bind loopback
// and are launched solely by the E2E runner, never by the production image.
export async function startServices(output) {
  const requests = new Map(),
    codes = new Map(),
    tokens = new Map(),
    refreshTokens = new Map(),
    revokedFamilies = new Set(),
    shortAccess = new Map(),
    refreshCounts = new Map();
  const subjects = Object.keys(syntheticIdentities);
  let unavailable = false;
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const form = async (req) => {
    let body = "";
    for await (const part of req) {
      body += part;
      if (body.length > 8192) throw Error("Oversized request");
    }
    return new URLSearchParams(body);
  };
  const token = () => randomBytes(32).toString("base64url");
  const revokeFamily = (family) => {
    revokedFamilies.add(family);
    for (const [access, value] of tokens) {
      if (value.family === family) tokens.delete(access);
    }
  };
  const issueTokens = (sub, family, refreshExpiry, expiresIn = 900) => {
    const access = token(),
      refresh = token();
    tokens.set(access, {
      sub,
      family,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    refreshTokens.set(refresh, {
      sub,
      family,
      expiresAt: refreshExpiry,
      used: false,
    });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: expiresIn,
    };
  };
  const issuer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1:3372");
      if (url.pathname === "/oauth/authorize") {
        const q = url.searchParams;
        if (
          q.get("client_id") !== syntheticGuidanceClientID ||
          q.get("redirect_uri") !== "http://127.0.0.1:3371/auth/callback" ||
          q.get("code_challenge_method") !== "S256" ||
          q.get("scope") !== "taskly:login"
        )
          return json(res, 400, { error: "invalid_request" });
        const id = token();
        requests.set(id, Object.fromEntries(q));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(
          `<html lang="ja"><head><title>検証用ログイン</title></head><body><h1>検証用ログイン</h1><form method="POST" action="/mock/login"><input type="hidden" name="id" value="${id}"><label>検証アカウント<select name="subject">${subjects.map((subject) => `<option value="${subject}">${subject}</option>`).join("")}</select></label><button type="submit">検証用アカウントで続ける</button></form></body></html>`,
        );
      }
      if (url.pathname === "/mock/login" && req.method === "POST") {
        const q = await form(req),
          request = requests.get(q.get("id"));
        if (!request || !subjects.includes(q.get("subject")))
          return json(res, 400, { error: "invalid_login" });
        requests.delete(q.get("id"));
        const code = token();
        codes.set(code, { ...request, sub: q.get("subject") });
        const target = new URL(request.redirect_uri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", request.state);
        target.searchParams.set("iss", "http://127.0.0.1:3372");
        res.writeHead(302, { Location: target.href });
        return res.end();
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const q = await form(req);
        if (q.get("grant_type") === "refresh_token") {
          const refresh = refreshTokens.get(q.get("refresh_token"));
          if (
            q.get("client_id") !== syntheticGuidanceClientID ||
            !refresh ||
            refresh.expiresAt <= Date.now() ||
            revokedFamilies.has(refresh.family)
          )
            return json(res, 400, { error: "invalid_grant" });
          if (refresh.used) {
            revokeFamily(refresh.family);
            return json(res, 400, { error: "invalid_grant" });
          }
          refresh.used = true;
          refreshCounts.set(
            refresh.sub,
            (refreshCounts.get(refresh.sub) || 0) + 1,
          );
          return json(
            res,
            200,
            issueTokens(refresh.sub, refresh.family, refresh.expiresAt),
          );
        }
        const code = codes.get(q.get("code"));
        if (
          q.get("grant_type") !== "authorization_code" ||
          !code ||
          q.get("client_id") !== code.client_id ||
          q.get("redirect_uri") !== code.redirect_uri ||
          createHash("sha256")
            .update(q.get("code_verifier") || "")
            .digest("base64url") !== code.code_challenge
        )
          return json(res, 400, { error: "invalid_grant" });
        codes.delete(q.get("code"));
        return json(
          res,
          200,
          issueTokens(
            code.sub,
            token(),
            Date.now() + 30 * 86400 * 1000,
            shortAccess.get(code.sub) || 900,
          ),
        );
      }
      if (url.pathname === "/oauth/userinfo") {
        if (unavailable) return json(res, 503, { error: "synthetic_outage" });
        const access = tokens.get(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
        );
        if (
          !access ||
          access.expiresAt <= Date.now() ||
          revokedFamilies.has(access.family)
        )
          return json(res, 401, { error: "invalid_token" });
        return json(res, 200, {
          sub: syntheticIdentities[access.sub],
          email: `${access.sub}@example.test`,
          name: `検証ユーザー ${access.sub}`,
        });
      }
      if (url.pathname === "/oauth/introspect" && req.method === "POST") {
        const expected = `Basic ${Buffer.from(`${syntheticTasklyClientID}:${syntheticTasklyClientSecret}`).toString("base64")}`;
        if (req.headers.authorization !== expected)
          return json(res, 401, { error: "invalid_client" });
        if (unavailable) return json(res, 503, { error: "synthetic_outage" });
        const q = await form(req);
        const access = tokens.get(q.get("token"));
        if (
          !access ||
          access.expiresAt <= Date.now() ||
          revokedFamilies.has(access.family)
        )
          return json(res, 200, { active: false });
        return json(res, 200, {
          active: true,
          sub: syntheticIdentities[access.sub],
          client_id: syntheticGuidanceClientID,
          aud: "taskly-api",
          scope: "taskly:login",
          iss: "http://127.0.0.1:3372",
          exp: Math.floor(access.expiresAt / 1000),
          token_type: "Bearer",
        });
      }
      if (url.pathname === "/oauth/revoke" && req.method === "POST") {
        const q = await form(req),
          refresh = refreshTokens.get(q.get("token"));
        if (refresh) revokeFamily(refresh.family);
        else tokens.delete(q.get("token"));
        return json(res, 200, {});
      }
      if (url.pathname === "/__test/revoke" && req.method === "POST") {
        for (const value of [...tokens.values(), ...refreshTokens.values()])
          if (value.sub === url.searchParams.get("subject"))
            revokeFamily(value.family);
        return json(res, 200, {});
      }
      if (url.pathname === "/__test/short-token" && req.method === "POST") {
        const subject = url.searchParams.get("subject");
        if (!subjects.includes(subject))
          return json(res, 400, { error: "invalid_subject" });
        shortAccess.set(subject, 2);
        return json(res, 200, {});
      }
      if (url.pathname === "/__test/refresh-count" && req.method === "GET") {
        return json(res, 200, {
          count: refreshCounts.get(url.searchParams.get("subject")) || 0,
        });
      }
      if (url.pathname === "/__test/active-families" && req.method === "GET") {
        const families = new Set(
          [...refreshTokens.values()]
            .filter(
              (value) =>
                value.sub === url.searchParams.get("subject") &&
                value.expiresAt > Date.now() &&
                !revokedFamilies.has(value.family),
            )
            .map((value) => value.family),
        );
        return json(res, 200, { count: families.size });
      }
      if (url.pathname === "/__test/outage" && req.method === "POST") {
        unavailable = url.searchParams.get("enabled") === "1";
        return json(res, 200, {});
      }
      return json(res, 404, { error: "not_found" });
    } catch {
      return json(res, 500, { error: "synthetic_issuer_error" });
    }
  });
  const root = resolve(output);
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".map": "application/json",
    ".txt": "text/plain",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
  };
  const web = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(
        new URL(req.url, "http://127.0.0.1:3300").pathname,
      );
      let file = resolve(root, `.${path}`);
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403);
        return res.end();
      }
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await Promise.all([
    new Promise((ok, fail) =>
      issuer.once("error", fail).listen(3372, "127.0.0.1", ok),
    ),
    new Promise((ok, fail) =>
      web.once("error", fail).listen(3300, "127.0.0.1", ok),
    ),
  ]);
  return async () => {
    await Promise.all([
      new Promise((ok) => issuer.close(ok)),
      new Promise((ok) => web.close(ok)),
    ]);
  };
}
