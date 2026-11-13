// These aliases and numeric subjects belong only to the disposable E2E stack.
// Guidance's OAuth userinfo and Taskly's introspection must identify one user.
export const syntheticIdentities = Object.fromEntries(
  [
    "alice", "bob", "onboarding", "routing", "map", "outage", "mobile",
    "documents", "presentation", "refresh", "menu", "home", "home-denied",
    "home-failure", "home-other",
  ].map((alias, index) => [alias, String(1001 + index)]),
);

export const syntheticEventID = "synthetic-guidance-2030";
export const syntheticGuidanceClientID = "nnct-corp-guidance-2026";
export const syntheticTasklyClientID = "taskly-e2e";
export const syntheticTasklyClientSecret = "synthetic-e2e-client-secret";
