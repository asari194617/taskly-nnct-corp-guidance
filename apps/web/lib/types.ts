export type User = { sub: string; email: string; name: string };
export type Company = {
  id: string;
  name: string;
  session: "AM" | "PM";
  booth: number;
  industries: string[];
  source_page: number;
};
export type Slot = {
  id: string;
  session: string;
  title: string;
  start: string;
  end: string;
  term?: number;
  required_grades: number[];
};
export type Assignment = {
  department: string;
  grade: number;
  number: number;
  visits: { term: number; company_id: string }[];
};
export type BoothBounds = {
  booth: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type Preferences = {
  roster_number: number | null;
  department: string;
  grade: number;
};
export type Document = {
  id: string;
  title: string;
  kind: string;
  mime_type: string;
  file_name: string;
  source_page: number;
  url: string;
  booths?: BoothBounds[];
  image_width?: number;
  image_height?: number;
};
export type NoticeSection = {
  id: string;
  title: string;
  blocks: (
    | { type: "paragraph"; text: string }
    | { type: "list"; items: string[] }
  )[];
};
export type Guidance = {
  event: { title: string; date: string; venue: string; description: string };
  companies: Company[];
  schedule: Slot[];
  assignments: Assignment[];
  documents: Document[];
  notices: string[];
  notice_sections?: NoticeSection[];
};
