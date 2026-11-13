export type View =
  | "companies"
  | "search"
  | "schedule"
  | "map"
  | "plan"
  | "info";
export type RouteState = {
  view: View;
  company: string;
  focus: string;
  session: "all" | "AM" | "PM";
  q: string;
  industry: string;
  saved: boolean;
  assigned: boolean;
};
export const defaultRoute: RouteState = {
  view: "companies",
  company: "",
  focus: "",
  session: "all",
  q: "",
  industry: "",
  saved: false,
  assigned: false,
};
const id = (value: string | null) =>
  value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "";
export function readRoute(search: string): RouteState {
  const query = new URLSearchParams(search),
    view = query.get("view");
  const session = query.get("session");
  return {
    view:
      view === "search" ||
      view === "schedule" ||
      view === "map" ||
      view === "plan" ||
      view === "info"
        ? view
        : "companies",
    company: id(query.get("company")),
    focus: id(query.get("focus")),
    session: session === "AM" || session === "PM" ? session : "all",
    q: (query.get("q") || "").slice(0, 200),
    industry: (query.get("industry") || "").slice(0, 200),
    saved: query.get("saved") === "1",
    assigned: query.get("assigned") === "1",
  };
}
export function routeHref(route: RouteState): string {
  const query = new URLSearchParams();
  if (route.view !== "companies") query.set("view", route.view);
  if (route.company) query.set("company", route.company);
  if (route.focus) query.set("focus", route.focus);
  if (route.session !== "all") query.set("session", route.session);
  if (route.q) query.set("q", route.q);
  if (route.industry) query.set("industry", route.industry);
  if (route.saved) query.set("saved", "1");
  if (route.assigned) query.set("assigned", "1");
  return query.size ? `/?${query}` : "/";
}
