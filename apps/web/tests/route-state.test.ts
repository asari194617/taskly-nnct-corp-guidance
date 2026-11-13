import { describe, expect, it } from "vitest";
import {
  defaultRoute,
  isAppPath,
  readRoute,
  routeHref,
} from "../lib/route-state";

const paths = {
  home: "/",
  search: "/search/",
  schedule: "/schedule/",
  map: "/map/",
  plan: "/favorites/",
  info: "/documents/",
} as const;

describe("shareable guidance pages", () => {
  it("uses the clean home page by default", () => {
    expect(readRoute("")).toEqual(defaultRoute);
    expect(routeHref(defaultRoute)).toBe("/");
    expect(readRoute("?view=companies&session=all&saved=0&assigned=0")).toEqual(
      { ...defaultRoute, view: "search", sessionExplicit: true },
    );
  });

  it.each(Object.entries(paths) as [keyof typeof paths, string][])(
    "roundtrips the actual %s page without losing company context or multiple industries",
    (view, path) => {
      const route = {
        view,
        company: "AM-1",
        focus: "AM-2",
        session: "PM" as const,
        sessionExplicit: true,
        q: "研究 開発&製造",
        industries: ["機械", "通信・開発"],
        saved: true,
        assigned: true,
      };
      const href = routeHref(route),
        url = new URL(href, "https://example.invalid");
      expect(url.pathname).toBe(path);
      expect(url.searchParams.has("view")).toBe(false);
      expect(url.searchParams.getAll("industry")).toEqual(route.industries);
      expect(readRoute(url.search, url.pathname)).toEqual(route);
      expect(href).not.toContain(route.q);
    },
  );

  it.each(Object.entries(paths) as [keyof typeof paths, string][])(
    "normalizes old view=%s links into their own page",
    (view, path) => {
      const legacy = readRoute(`?view=${view}&company=AM-1`);
      const url = new URL(routeHref(legacy), "https://example.invalid");
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("company")).toBe("AM-1");
      expect(url.searchParams.has("view")).toBe(false);
    },
  );

  it("keeps legacy listing company links usable on the actual search page", () => {
    const legacy = readRoute(
      "?view=companies&company=AM-2&industry=機械&saved=1",
    );
    expect(legacy).toMatchObject({
      view: "search",
      company: "AM-2",
      industries: ["機械"],
      saved: true,
    });
    expect(routeHref(legacy)).toBe(
      "/search/?company=AM-2&industry=%E6%A9%9F%E6%A2%B0&saved=1",
    );
  });

  it("lets a dedicated page take precedence over an obsolete view parameter", () => {
    expect(readRoute("?view=map", "/search/").view).toBe("search");
    expect(readRoute("?view=plan", "/documents/").view).toBe("info");
  });

  it("accepts morning links and valid identifier boundaries", () => {
    expect(
      readRoute(`?company=A&focus=${"a".repeat(64)}&session=AM`, "/map/"),
    ).toMatchObject({
      view: "map",
      company: "A",
      focus: "a".repeat(64),
      session: "AM",
    });
  });

  it.each([
    "?view=../../map&company=../AM-1&focus=<script>&session=night&saved=true&assigned=true",
    `?view=unknown&company=${"a".repeat(65)}&focus=AM%201&session=am&saved=2&assigned=2`,
    "?company=https%3A%2F%2Fexample.invalid&focus=%00",
    "?view=constructor",
    "?view=toString",
    "?view=__proto__",
  ])("ignores malformed identifiers and flags in %s", (search) => {
    expect(readRoute(search)).toEqual(defaultRoute);
  });

  it("bounds text and deduplicates repeated industry choices", () => {
    const query = new URLSearchParams({ q: `${"検".repeat(200)}extra` });
    query.append("industry", `${"業".repeat(200)}extra`);
    expect(readRoute(`?${query}`)).toMatchObject({
      q: "検".repeat(200),
      industries: ["業".repeat(200)],
    });
    expect(
      readRoute(
        "?q=%3Cscript%3E%26&industry=機械&industry=通信&industry=機械&industry=",
      ),
    ).toMatchObject({
      q: "<script>&",
      industries: ["機械", "通信"],
    });
  });

  it("recognizes only exported app paths when restoring a login destination", () => {
    for (const path of [
      "/",
      "/index.html",
      "/map",
      "/map/",
      "/map/index.html",
      "/documents/",
    ])
      expect(isAppPath(path)).toBe(true);
    for (const path of [
      "/unrelated",
      "/map/child/",
      "/search.evil/",
      "//other.invalid/map/",
      "/../map/",
    ])
      expect(isAppPath(path)).toBe(false);
  });

  it("bounds the number of selected industries and produces unique shared parameters", () => {
    const query = new URLSearchParams();
    for (let index = 0; index < 45; index++)
      query.append("industry", `検証分類${index}`);
    expect(readRoute(`?${query}`, "/search/").industries).toHaveLength(40);
    const url = new URL(
      routeHref({ ...defaultRoute, industries: ["機械", "機械", "", "通信"] }),
      "https://example.invalid",
    );
    expect(url.searchParams.getAll("industry")).toEqual(["機械", "通信"]);
  });

  it.each(["AM", "PM", "all"] as const)(
    "keeps an explicit %s choice distinguishable from an automatic default",
    (session) => {
      const route = readRoute(`?session=${session}`, "/search/");
      expect(route).toMatchObject({ session, sessionExplicit: true });
      expect(routeHref(route)).toBe(`/search/?session=${session}`);
      expect(
        readRoute(
          new URL(routeHref(route), "https://example.invalid").search,
          "/search/",
        ),
      ).toEqual(route);
    },
  );
  it("does not serialize derived automatic sessions into shared URLs", () => {
    expect(routeHref({ ...defaultRoute, session: "AM" })).toBe("/");
    expect(routeHref({ ...defaultRoute, session: "PM" })).toBe("/");
    expect(readRoute("?session=night").sessionExplicit).toBe(false);
  });

  it("does not copy personal roster information or unrelated parameters into shared links", () => {
    const route = readRoute(
      "?roster_number=7&department=Ec4&access_token=private&saved=1",
      "/favorites/",
    );
    expect(routeHref(route)).toBe("/favorites/?saved=1");
    expect(defaultRoute).toEqual({
      view: "home",
      company: "",
      focus: "",
      session: "all",
      sessionExplicit: false,
      q: "",
      industries: [],
      saved: false,
      assigned: false,
    });
  });
});
