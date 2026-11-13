import type { CSSProperties } from "react";
export type IconName =
  | "home"
  | "building"
  | "calendar"
  | "map"
  | "bookmark"
  | "search"
  | "arrow"
  | "check"
  | "close"
  | "logout"
  | "location"
  | "clock"
  | "external"
  | "lock"
  | "plus"
  | "minus"
  | "grid"
  | "user"
  | "document"
  | "info"
  | "fit"
  | "filter";
const paths: Record<IconName, React.ReactNode> = {
  home: <path d="m3 10 9-7 9 7v11h-7v-7h-4v7H3V10Z" />,
  building: (
    <>
      <path d="M4 21V7l8-4 8 4v14M9 21v-5h6v5M8 8h1m6 0h1M8 12h1m6 0h1M2 21h20" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4m10-4v4M3 11h18m-13 4h1m6 0h1m-8 3h1" />
    </>
  ),
  map: (
    <>
      <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15" />
    </>
  ),
  bookmark: <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4-6 4Z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  logout: (
    <>
      <path d="M10 4H5v16h5m4-12 4 4-4 4m-5-4h12" />
    </>
  ),
  location: (
    <>
      <path d="M19 10c0 6-7 11-7 11S5 16 5 10a7 7 0 1 1 14 0Z" />
      <circle cx="12" cy="10" r="2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m-10 3L21 3M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3" />
    </>
  ),
  plus: <path d="M5 12h14M12 5v14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  filter: <path d="M4 7h16M4 17h16M8 4v6m8 4v6" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
      <path d="M14 3v6h6M8 13h8m-8 4h6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10h.01" />
    </>
  ),
};
const filledPaths: Partial<Record<IconName, React.ReactNode>> = {
  home: (
    <path
      fill="currentColor"
      stroke="none"
      d="m2 10 10-8 10 8-1 2-1-1v11h-7v-8h-2v8H4V11l-1 1-1-2Z"
    />
  ),
  building: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      d="m12 2 9 4v16h-7v-6h-4v6H3V6l9-4Zm-5 6v3h3V8H7Zm7 0v3h3V8h-3Z"
    />
  ),
  calendar: (
    <>
      <path
        fill="currentColor"
        stroke="none"
        fillRule="evenodd"
        d="M5 4h14a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Zm0 7v8h14v-8H5Z"
      />
      <path d="M7 2v5m10-5v5M8 14h1m6 0h1m-8 3h1" strokeWidth="2.5" />
    </>
  ),
  map: (
    <path
      fill="currentColor"
      stroke="none"
      d="m2 6 6-3v15l-6 3V6Zm8-3 4 2v16l-4-3V3Zm6 3 6-3v15l-6 3V6Z"
    />
  ),
  bookmark: (
    <path
      fill="currentColor"
      stroke="currentColor"
      d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4-6 4Z"
    />
  ),
  search: (
    <>
      <path
        fill="currentColor"
        stroke="none"
        fillRule="evenodd"
        d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"
      />
      <path d="m16 16 5 5" strokeWidth="3.5" />
    </>
  ),
};
export function Icon({
  name,
  size = 20,
  style,
  filled = false,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  filled?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-filled={filled || undefined}
      style={style}
    >
      {filled && filledPaths[name] ? filledPaths[name] : paths[name]}
    </svg>
  );
}
