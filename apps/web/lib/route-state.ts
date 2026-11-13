export type View = "home" | "search" | "schedule" | "map" | "plan" | "info";
export type RouteState = {
  view: View;
  company: string;
  focus: string;
  session: "all" | "AM" | "PM";
  sessionExplicit: boolean;
  q: string;
  industries: string[];
  saved: boolean;
  assigned: boolean;
};
const paths: Record<View, string> = {
  home: "/",
  search: "/search/",
  schedule: "/schedule/",
  map: "/map/",
  plan: "/favorites/",
  info: "/documents/",
};
export const defaultRoute: RouteState = {
  view: "home",
  company: "",
  focus: "",
  session: "all",
  sessionExplicit: false,
  q: "",
  industries: [],
  saved: false,
  assigned: false,
};
const id = (value: string | null) =>
  value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "";
function normalizedPath(pathname: string) {
  if (pathname === "/index.html") return "/";
  const path = pathname.replace(/\/index\.html$/, "/");
  return path.endsWith("/") ? path : `${path}/`;
}
export function isAppPath(pathname: string): boolean {
  return Object.values(paths).includes(normalizedPath(pathname));
}
export function readRoute(search: string, pathname = "/"): RouteState {
  const query = new URLSearchParams(search),
    path = normalizedPath(pathname);
  const legacy = query.get("view");
  const fromPath = (Object.entries(paths) as [View, string][]).find(
    ([, value]) => value === path,
  )?.[0];
  const view =
    path === "/" && legacy === "companies"
      ? "search"
      : path === "/" && legacy && Object.keys(paths).includes(legacy)
        ? (legacy as View)
        : fromPath || "home";
  const session = query.get("session");
  return {
    view,
    company: id(query.get("company")),
    focus: id(query.get("focus")),
    session: session === "AM" || session === "PM" ? session : "all",
    sessionExplicit: session === "AM" || session === "PM" || session === "all",
    q: (query.get("q") || "").slice(0, 200),
    industries: [
      ...new Set(
        query
          .getAll("industry")
          .map((value) => value.slice(0, 200).trim())
          .filter(Boolean),
      ),
    ].slice(0, 40),
    saved: query.get("saved") === "1",
    assigned: query.get("assigned") === "1",
  };
}
export function routeHref(route: RouteState): string {
  const query = new URLSearchParams();
  if (route.company) query.set("company", route.company);
  if (route.focus) query.set("focus", route.focus);
  if (route.sessionExplicit) query.set("session", route.session);
  if (route.q) query.set("q", route.q);
  for (const industry of [...new Set(route.industries)])
    if (industry) query.append("industry", industry);
  if (route.saved) query.set("saved", "1");
  if (route.assigned) query.set("assigned", "1");
  return paths[route.view] + (query.size ? `?${query}` : "");
}
