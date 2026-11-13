import type { Assignment, Company, Document, Guidance } from "./types";

export type Recommendation = { company: Company; reasons: string[] };
export type RecommendationOptions = {
  data: Pick<Guidance, "companies" | "documents">;
  assignment?: Assignment | null;
  savedIDs: ReadonlySet<string>;
  department?: string | null;
  session?: "all" | "AM" | "PM";
  limit?: number;
};

type Location = { x: number; y: number };
const companyID = /^[A-Za-z0-9_-]{1,64}$/;
const normalized = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ja").trim();
const companyOrder = (a: Company, b: Company) =>
  a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id, "en");

function industryNames(company: Company) {
  return [...new Set(company.industries.map(normalized).filter(Boolean))];
}

function locations(document: Document): Map<number, Location> {
  const width = document.image_width,
    height = document.image_height;
  const result = new Map<number, Location>();
  if (
    document.kind !== "map" ||
    !document.mime_type.startsWith("image/") ||
    !width ||
    !height ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return result;
  const seen = new Set<number>();
  const diagonal = Math.hypot(width, height);
  for (const booth of document.booths || []) {
    if (seen.has(booth.booth)) {
      result.delete(booth.booth);
      continue;
    }
    seen.add(booth.booth);
    if (
      !Number.isInteger(booth.booth) ||
      booth.booth <= 0 ||
      ![booth.x, booth.y, booth.width, booth.height].every(Number.isFinite) ||
      booth.x < 0 ||
      booth.y < 0 ||
      booth.width <= 0 ||
      booth.height <= 0 ||
      booth.x + booth.width > 1.001 ||
      booth.y + booth.height > 1.001
    )
      continue;
    // Coordinates share one floor/image. Scaling by its real aspect ratio
    // yields a distance in fractions of that image's diagonal, not booth IDs.
    result.set(booth.booth, {
      x: ((booth.x + booth.width / 2) * width) / diagonal,
      y: ((booth.y + booth.height / 2) * height) / diagonal,
    });
  }
  return result;
}

function relatedToDepartment(
  department: string | null | undefined,
  industries: string[],
) {
  // This is a deliberately narrow industry heuristic, not an official list
  // of target departments. A broad category such as "製造業" alone is insufficient.
  return (
    /^(電子制御(?:工学科)?|ec4?)$/.test(normalized(department || "")) &&
    industries.some((industry) =>
      /機械|電気|電子|情報|通信|ソフトウェア|自動車|制御|ロボット|半導体|精密|計測/.test(
        industry,
      ),
    )
  );
}

function scoringContext({
  data,
  assignment,
  savedIDs,
  department,
  session = "all",
}: RecommendationOptions) {
  const unique = new Map<string, Company>();
  for (const company of data.companies) {
    if (companyID.test(company.id) && !unique.has(company.id))
      unique.set(company.id, company);
  }
  const assignedIDs = new Set(
    assignment?.visits.map((visit) => visit.company_id) || [],
  );
  const assigned = [...unique.values()].filter((company) =>
    assignedIDs.has(company.id),
  );
  // Several favourites in the same industry must not multiply its weight.
  const interests = new Map<string, Set<string>>();
  for (const company of unique.values()) {
    if (!savedIDs.has(company.id)) continue;
    for (const industry of industryNames(company)) {
      const owners = interests.get(industry) || new Set<string>();
      owners.add(company.id);
      interests.set(industry, owners);
    }
  }
  const floors = data.documents.map(locations).filter((floor) => floor.size);
  const companies = [...unique.values()].filter(
    (company) =>
      !assignedIDs.has(company.id) &&
      (session === "all" || company.session === session),
  );
  function assess(company: Company) {
    const industries = industryNames(company),
      reasons: string[] = [];
    let score = 0;
    if (relatedToDepartment(department, industries)) {
      score += 35;
      reasons.push("電子制御に関連する業種");
    }
    if (savedIDs.has(company.id)) {
      score += 20;
      reasons.push("気になる企業");
    }
    // A saved company's own industry is not additional evidence about it.
    const sharedInterest = industries.some((industry) => {
      const owners = interests.get(industry);
      return owners && (owners.size > 1 || !owners.has(company.id));
    });
    if (sharedInterest) {
      score += 18;
      reasons.push("気になる企業と同じ業種");
    }
    let nearest = Infinity;
    for (const floor of floors) {
      const candidate = floor.get(company.booth);
      if (!candidate) continue;
      for (const required of assigned) {
        if (required.session !== company.session) continue;
        const target = floor.get(required.booth);
        if (target)
          nearest = Math.min(
            nearest,
            Math.hypot(candidate.x - target.x, candidate.y - target.y),
          );
      }
    }
    if (nearest <= 0.12) {
      score += 24 * (1 - nearest / 0.12);
      reasons.push("指定企業の近く");
    }
    return { company, industries, reasons, score };
  }
  return { companies, assess };
}

/** Current reasons for a retained card, independent of its current ranking. */
export function recommendationReasons(
  options: RecommendationOptions,
  company: Company,
): string[] {
  const context = scoringContext(options);
  const current = context.companies.find(
    (candidate) => candidate.id === company.id,
  );
  return current ? context.assess(current).reasons : [];
}

/** Deterministic, explainable suggestions; no source data or model inference. */
export function suggestRecommendations(
  options: RecommendationOptions,
): Recommendation[] {
  const limit = options.limit ?? 6;
  const count = Math.min(
    12,
    Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 6)),
  );
  if (!count) return [];
  const context = scoringContext(options);
  const candidates = context.companies.map(context.assess);
  const recommendations: Recommendation[] = [];
  const shownIndustries = new Map<string, number>();
  while (recommendations.length < count && candidates.length) {
    // A small, bounded diversity penalty can break a run of one industry,
    // while the stronger department/interest signals still determine relevance.
    const adjusted = (candidate: (typeof candidates)[number]) =>
      candidate.score -
      Math.min(
        20,
        8 *
          Math.max(
            0,
            ...candidate.industries.map(
              (industry) => shownIndustries.get(industry) || 0,
            ),
          ),
      );
    candidates.sort(
      (a, b) => adjusted(b) - adjusted(a) || companyOrder(a.company, b.company),
    );
    const next = candidates.shift()!;
    recommendations.push({ company: next.company, reasons: next.reasons });
    for (const industry of next.industries)
      shownIndustries.set(industry, (shownIndustries.get(industry) || 0) + 1);
  }
  return recommendations;
}
