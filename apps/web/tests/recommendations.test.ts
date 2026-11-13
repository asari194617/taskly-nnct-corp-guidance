import { describe, expect, it } from "vitest";
import {
  recommendationReasons,
  suggestRecommendations,
} from "../lib/recommendations";
import type { Assignment, BoothBounds, Company, Document } from "../lib/types";

const company = (id: string, options: Partial<Company> = {}): Company => ({
  id,
  name: `架空${id}`,
  session: "AM",
  booth: 1,
  industries: [],
  source_page: 1,
  ...options,
});
const assignment = (...ids: string[]): Assignment => ({
  department: "電子制御工学科",
  grade: 4,
  number: 1,
  visits: ids.map((company_id, index) => ({ term: index + 1, company_id })),
});
const box = (booth: number, x: number, y: number): BoothBounds => ({
  booth,
  x,
  y,
  width: 0.02,
  height: 0.02,
});
const map = (
  booths: BoothBounds[],
  options: Partial<Document> = {},
): Document => ({
  id: "synthetic-map",
  title: "検証用図面",
  kind: "map",
  mime_type: "image/png",
  file_name: "map.png",
  source_page: 1,
  url: "/synthetic",
  image_width: 1000,
  image_height: 1000,
  booths,
  ...options,
});
function suggest(
  companies: Company[],
  options: Partial<Parameters<typeof suggestRecommendations>[0]> = {},
) {
  return suggestRecommendations({
    data: { companies, documents: [] },
    savedIDs: new Set(),
    ...options,
  });
}

describe("explainable guidance recommendations", () => {
  it("uses a transparent Ec4 industry heuristic ahead of a favourite alone", () => {
    const generic = company("saved", { industries: ["一般サービス"] });
    const relevant = company("related", { industries: ["電子機器"] });
    const result = suggest([generic, relevant], {
      department: "電子制御工学科",
      savedIDs: new Set(["saved"]),
    });
    expect(result.map((item) => item.company.id)).toEqual(["related", "saved"]);
    expect(result[0].reasons).toEqual(["電子制御に関連する業種"]);
    expect(result[1].reasons).toEqual(["気になる企業"]);
    expect(
      suggest([generic, relevant], {
        department: " EC4 ",
        savedIDs: new Set(["saved"]),
      })[0].company.id,
    ).toBe("related");
    expect(
      suggest([company("broad", { industries: ["製造業"] })], {
        department: "電子制御工学科",
      })[0].reasons,
    ).toEqual([]);
  });

  it("does not infer department matches for missing or unsupported departments", () => {
    const companies = [company("one", { industries: ["情報通信"] })];
    for (const department of [undefined, null, "", "未設定", "機械工学科"]) {
      expect(suggest(companies, { department })[0].reasons).toEqual([]);
    }
  });

  it("uses other favourites' industries and does not count a company's own industry twice", () => {
    const favourite = company("favourite", { industries: [" 情報 ", "情報"] });
    const related = company("related", { industries: ["情報"] });
    const result = suggest([related, favourite], {
      savedIDs: new Set([favourite.id]),
    });
    expect(result[0]).toEqual({
      company: favourite,
      reasons: ["気になる企業"],
    });
    expect(result[1]).toEqual({
      company: related,
      reasons: ["気になる企業と同じ業種"],
    });
    expect(
      suggest([related], { savedIDs: new Set(["unknown"]) })[0].reasons,
    ).toEqual([]);
  });

  it("deduplicates popular favourite industries instead of multiplying their influence", () => {
    const a = company("a", { industries: ["情報"] });
    const b = company("b", { industries: ["電子"] });
    const favourites = [
      company("s1", { industries: ["情報"] }),
      company("s2", { industries: ["情報"] }),
      company("s3", { industries: ["電子"] }),
    ];
    const compare = (saved: string[]) =>
      suggest([a, b, ...favourites], {
        assignment: assignment("s1", "s2", "s3"),
        savedIDs: new Set(saved),
      });
    expect(compare(["s1", "s3"])).toEqual(compare(["s1", "s2", "s3"]));
    expect(compare(["s1", "s2", "s3"])[0].company.id).toBe("a");
  });

  it("excludes every assigned company even when saved and respects the requested session", () => {
    const companies = [
      company("required"),
      company("morning"),
      company("afternoon", { session: "PM" }),
    ];
    const options = {
      assignment: assignment("required", "missing"),
      savedIDs: new Set(["required"]),
    };
    expect(
      suggest(companies, { ...options, session: "PM" }).map(
        (item) => item.company.id,
      ),
    ).toEqual(["afternoon"]);
    expect(
      suggest(companies, { ...options, session: "AM" }).map(
        (item) => item.company.id,
      ),
    ).toEqual(["morning"]);
    expect(suggest(companies, { ...options, session: "all" })).toHaveLength(2);
  });

  it("uses real coordinates for proximity and never booth-number differences", () => {
    const required = company("required", { booth: 1 });
    const near = company("near", { booth: 99, name: "架空う" });
    const far = company("far", { booth: 2, name: "架空あ" });
    const result = suggest([far, required, near], {
      assignment: assignment("required"),
      data: {
        companies: [far, required, near],
        documents: [
          map([box(1, 0.5, 0.5), box(99, 0.51, 0.5), box(2, 0.9, 0.9)]),
        ],
      },
    });
    expect(result[0].company.id).toBe("near");
    expect(result[0].reasons).toEqual(["指定企業の近く"]);
    expect(result[1].reasons).toEqual([]);
  });

  it("corrects physical distance for image aspect ratio", () => {
    const companies = [
      company("required", { booth: 1 }),
      company("horizontal", { booth: 2 }),
      company("vertical", { booth: 3 }),
    ];
    const result = suggest(companies, {
      assignment: assignment("required"),
      data: {
        companies,
        documents: [
          map([box(1, 0.4, 0.4), box(2, 0.5, 0.4), box(3, 0.4, 0.6)], {
            image_width: 2000,
            image_height: 200,
          }),
        ],
      },
    });
    expect(result.map((item) => item.company.id)).toEqual([
      "vertical",
      "horizontal",
    ]);
    expect(
      result.every((item) => item.reasons.includes("指定企業の近く")),
    ).toBe(true);
  });

  it("never compares different sessions or coordinates across separate floors", () => {
    const companies = [
      company("required", { booth: 1 }),
      company("other-floor", { booth: 2 }),
      company("afternoon", { booth: 1, session: "PM" }),
    ];
    const result = suggest(companies, {
      assignment: assignment("required"),
      data: {
        companies,
        documents: [
          map([box(1, 0.2, 0.2)]),
          map([box(2, 0.2, 0.2)], { id: "other-floor" }),
        ],
      },
    });
    expect(
      result.every((item) => !item.reasons.includes("指定企業の近く")),
    ).toBe(true);
    expect(
      suggest(companies, { assignment: assignment("unknown") }).every(
        (item) => item.reasons.length === 0,
      ),
    ).toBe(true);
  });

  it("omits proximity when dimensions, image kind, or actual geometry are unavailable", () => {
    const companies = [
      company("required", { booth: 1 }),
      company("candidate", { booth: 2 }),
    ];
    const valid = map([box(1, 0.2, 0.2), box(2, 0.21, 0.2)]);
    const invalid = [
      { ...valid, image_width: undefined },
      { ...valid, image_height: 0 },
      { ...valid, image_width: -1 },
      { ...valid, image_height: Infinity },
      { ...valid, kind: "guidebook" },
      { ...valid, mime_type: "application/pdf" },
      { ...valid, booths: undefined },
    ];
    for (const document of invalid)
      expect(
        suggest(companies, {
          assignment: assignment("required"),
          data: { companies, documents: [document] },
        })[0].reasons,
      ).toEqual([]);
  });

  it("rejects malformed and ambiguous booth bounds", () => {
    const companies = [
      company("required", { booth: 1 }),
      company("candidate", { booth: 2 }),
    ];
    const invalid: BoothBounds[] = [
      { ...box(2, 0.2, 0.2), booth: 0 },
      { ...box(2, 0.2, 0.2), booth: 1.5 },
      { ...box(2, 0.2, 0.2), x: NaN },
      { ...box(2, 0.2, 0.2), x: -0.1 },
      { ...box(2, 0.2, 0.2), y: -0.1 },
      { ...box(2, 0.2, 0.2), width: 0 },
      { ...box(2, 0.2, 0.2), height: -0.1 },
      { ...box(2, 0.99, 0.2), width: 0.1 },
      { ...box(2, 0.2, 0.99), height: 0.1 },
    ];
    for (const bounds of invalid) {
      expect(
        suggest(companies, {
          assignment: assignment("required"),
          data: { companies, documents: [map([box(1, 0.2, 0.2), bounds])] },
        })[0].reasons,
      ).toEqual([]);
    }
    expect(
      suggest(companies, {
        assignment: assignment("required"),
        data: {
          companies,
          documents: [
            map([
              box(1, 0.2, 0.2),
              box(2, 0.21, 0.2),
              box(2, 0.21, 0.2),
              box(2, 0.21, 0.2),
            ]),
          ],
        },
      })[0].reasons,
    ).toEqual([]);
  });

  it("keeps results stable, deduplicates valid IDs, and does not mutate input", () => {
    const first = company("valid", { name: "架空あ" }),
      duplicate = { ...first, name: "重複" };
    const second = company("z", { name: "架空い" }),
      third = company("a", { name: "架空い" });
    const companies = [
      second,
      company(""),
      first,
      duplicate,
      third,
      company("bad/id"),
    ];
    const before = JSON.stringify(companies);
    expect(suggest(companies).map((item) => item.company.id)).toEqual([
      "valid",
      "a",
      "z",
    ]);
    expect(
      suggest([...companies].reverse())
        .map((item) => item.company.id)
        .sort(),
    ).toEqual(["a", "valid", "z"]);
    expect(JSON.stringify(companies)).toBe(before);
    expect(suggest(companies)[0].company).toBe(first);
    expect(suggest([], { assignment: null })).toEqual([]);
  });

  it("adds modest diversity without overwhelming meaningful relevance", () => {
    const companies = [
      company("a", { name: "架空あ", industries: ["情報"] }),
      company("b", { name: "架空い", industries: ["情報"] }),
      company("c", { name: "架空う", industries: ["電子"] }),
      company("d", { name: "架空え", industries: ["一般"] }),
    ];
    expect(
      suggest(companies, { department: "電子制御工学科" }).map(
        (item) => item.company.id,
      ),
    ).toEqual(["a", "c", "b", "d"]);
  });

  it("bounds requested counts, supports zero, and handles non-finite limits sensibly", () => {
    const companies = Array.from({ length: 20 }, (_, i) => company(`c${i}`));
    expect(suggest(companies, { limit: 0 })).toEqual([]);
    expect(suggest(companies, { limit: -4 })).toEqual([]);
    expect(suggest(companies, { limit: 2.8 })).toHaveLength(2);
    expect(suggest(companies, { limit: 100 })).toHaveLength(12);
    expect(suggest(companies, { limit: NaN })).toHaveLength(6);
    expect(suggest(companies)).toHaveLength(6);
  });
  it("refreshes reasons for retained cards even outside the current recommendation limit", () => {
    const companies = [company("a"), company("z", { industries: ["電子"] })];
    const options = {
      data: { companies, documents: [] },
      savedIDs: new Set<string>(),
      limit: 1,
    };
    expect(suggestRecommendations(options)[0].company.id).toBe("a");
    expect(recommendationReasons(options, companies[1])).toEqual([]);
    const changed = {
      ...options,
      savedIDs: new Set(["z"]),
      department: "電子制御工学科",
    };
    expect(recommendationReasons(changed, companies[1])).toEqual([
      "電子制御に関連する業種",
      "気になる企業",
    ]);
    expect(
      recommendationReasons(
        { ...changed, assignment: assignment("z") },
        companies[1],
      ),
    ).toEqual([]);
    expect(
      recommendationReasons({ ...changed, session: "PM" }, companies[1]),
    ).toEqual([]);
    expect(recommendationReasons(changed, company("unknown"))).toEqual([]);
  });
});
