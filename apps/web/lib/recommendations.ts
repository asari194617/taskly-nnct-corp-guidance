import type { Assignment, Company, Guidance } from "./types";
import { walkingDistances } from "./walking-distance";

export type Recommendation = { company: Company; reasons: string[] };
export type RecommendationOptions = {
  data: Pick<Guidance, "companies" | "documents">;
  assignment?: Assignment | null;
  savedIDs: ReadonlySet<string>;
  department?: string | null;
  session?: "all" | "AM" | "PM";
  limit?: number;
};

const companyID = /^[A-Za-z0-9_-]{1,64}$/;
const normalized = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ja").trim();
const companyOrder = (a: Company, b: Company) =>
  a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id, "en");

function industryNames(company: Company) {
  return [...new Set(company.industries.map(normalized).filter(Boolean))];
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
  const interests = new Set<string>();
  for (const company of unique.values()) {
    if (!savedIDs.has(company.id)) continue;
    for (const industry of industryNames(company)) interests.add(industry);
  }
  const routes = new Map<Company["session"], Map<number, number>[]>();
  for (const session of ["AM", "PM"] as const) {
    const sources = new Set(
      assigned
        .filter((company) => company.session === session)
        .map((company) => company.booth),
    );
    if (sources.size)
      routes.set(
        session,
        data.documents.map((document) => walkingDistances(document, sources)),
      );
  }
  const companies = [...unique.values()].filter(
    (company) =>
      !assignedIDs.has(company.id) &&
      !savedIDs.has(company.id) &&
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
    const sharedInterest = industries.some((industry) =>
      interests.has(industry),
    );
    if (sharedInterest) {
      score += 18;
      reasons.push("気になる企業と同じ業種");
    }
    let nearest = Infinity;
    for (const floor of routes.get(company.session) || [])
      nearest = Math.min(nearest, floor.get(company.booth) ?? Infinity);
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
    const next = candidates.shift();
    if (!next) break;
    recommendations.push({ company: next.company, reasons: next.reasons });
    for (const industry of next.industries)
      shownIndustries.set(industry, (shownIndustries.get(industry) || 0) + 1);
  }
  return recommendations;
}

/** Retain visible order, fill saved-card vacancies, and keep history for rollback. */
export function reconcileRecommendations(
  options: RecommendationOptions,
  history: readonly string[],
): { history: string[]; recommendations: Recommendation[] } {
  const limit = options.limit ?? 6;
  const count = Math.min(
    12,
    Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 6)),
  );
  const nextHistory = [...new Set(history)];
  const context = scoringContext(options);
  const available = new Map(
    context.companies.map((company) => [company.id, company]),
  );
  const selected = new Map<string, Company>();
  for (const id of nextHistory) {
    const company = available.get(id);
    if (company && selected.size < count) selected.set(id, company);
  }
  if (selected.size < count) {
    for (const item of suggestRecommendations({ ...options, limit: 12 })) {
      const { company } = item;
      if (selected.has(company.id)) continue;
      selected.set(company.id, company);
      if (!nextHistory.includes(company.id)) nextHistory.push(company.id);
      if (selected.size === count) break;
    }
  }
  return {
    history: nextHistory,
    recommendations: [...selected.values()].map((company) => ({
      company,
      reasons: context.assess(company).reasons,
    })),
  };
}
