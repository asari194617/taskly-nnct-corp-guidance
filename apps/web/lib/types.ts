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
export type Document = {
  id: string;
  title: string;
  kind: string;
  mime_type: string;
  file_name: string;
  source_page: number;
  url: string;
};
export type Guidance = {
  event: { title: string; date: string; venue: string; description: string };
  companies: Company[];
  schedule: Slot[];
  assignments: Assignment[];
  documents: Document[];
  notices: string[];
};
