import { describe, expect, it } from "vitest";
import { defaultRoute, readRoute, routeHref } from "../lib/route-state";

describe("shareable guidance routes", () => {
  it("uses a clean homepage URL for the default company view", () => {
    expect(readRoute("")).toEqual(defaultRoute);
    expect(routeHref(defaultRoute)).toBe("/");
    expect(readRoute("?view=companies&session=all&saved=0&assigned=0")).toEqual(defaultRoute);
  });

  it.each(["companies", "search", "schedule", "map", "plan"] as const)(
    "roundtrips the %s view without losing company context or filters",
    (view) => {
      const route = {
        view,
        company: "AM-1",
        focus: "AM-2",
        session: "PM" as const,
        q: "研究 開発&製造",
        industry: "機械・通信",
        saved: true,
        assigned: true,
      };
      const href = routeHref(route);
      expect(href.startsWith("/?")).toBe(true);
      expect(readRoute(new URL(href, "https://example.invalid").search)).toEqual(route);
      expect(href).not.toContain("研究 開発&製造");
    },
  );

  it("accepts morning links and valid identifier boundaries", () => {
    expect(readRoute(`?company=A&focus=${"a".repeat(64)}&session=AM`)).toMatchObject({
      company: "A",
      focus: "a".repeat(64),
      session: "AM",
    });
  });

  it.each([
    "?view=../../map&company=../AM-1&focus=<script>&session=night&saved=true&assigned=true",
    `?view=unknown&company=${"a".repeat(65)}&focus=AM%201&session=am&saved=2&assigned=2`,
    "?company=https%3A%2F%2Fexample.invalid&focus=%00",
  ])("ignores malformed view, identifiers and flags in %s", (search) => {
    expect(readRoute(search)).toEqual(defaultRoute);
  });

  it("bounds user-supplied search text while preserving ordinary punctuation", () => {
    const query = new URLSearchParams({
      q: `${"検".repeat(200)}extra`,
      industry: `${"業".repeat(200)}extra`,
    });
    expect(readRoute(`?${query}`)).toMatchObject({
      q: "検".repeat(200),
      industry: "業".repeat(200),
    });
    expect(readRoute("?q=%3Cscript%3E%26&industry=%E6%A9%9F%E6%A2%B0")).toMatchObject({
      q: "<script>&",
      industry: "機械",
    });
  });

  it("does not copy personal roster information or unrelated parameters into shared links", () => {
    const route = readRoute("?view=plan&roster_number=7&department=Ec4&access_token=private&saved=1");
    expect(routeHref(route)).toBe("/?view=plan&saved=1");
    expect(defaultRoute).toEqual({
      view: "companies", company: "", focus: "", session: "all", q: "", industry: "", saved: false, assigned: false,
    });
  });
});
