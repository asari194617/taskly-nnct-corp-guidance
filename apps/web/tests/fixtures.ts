import type { Guidance } from "../lib/types";

// Entirely synthetic test content. Never copy private source documents into fixtures.
export const guidance: Guidance = {
  event: {
    title: "テスト企業交流会",
    date: "2030-05-14",
    venue: "テスト会場",
    description: "検証専用",
  },
  companies: [
    {
      id: "AM-1",
      name: "あおばテスト株式会社",
      session: "AM",
      booth: 1,
      industries: ["ソフトウェア", "通信"],
      source_page: 2,
    },
    {
      id: "AM-2",
      name: "いろはテスト製作所",
      session: "AM",
      booth: 2,
      industries: ["機械"],
      source_page: 2,
    },
    {
      id: "PM-1",
      name: "みらいテスト建設",
      session: "PM",
      booth: 1,
      industries: ["建設"],
      source_page: 3,
    },
  ],
  schedule: [
    {
      id: "opening",
      session: "AM",
      title: "検証用開会式",
      start: "09:00",
      end: "09:10",
      required_grades: [],
    },
    {
      id: "term-1",
      session: "AM",
      title: "検証ターム1",
      start: "2030-05-14T09:10:00+09:00",
      end: "2030-05-14T09:30:00+09:00",
      term: 1,
      required_grades: [3, 4],
    },
    {
      id: "term-2",
      session: "PM",
      title: "検証ターム2",
      start: "13:00",
      end: "13:20",
      term: 2,
      required_grades: [3],
    },
    {
      id: "other",
      session: "ALL",
      title: "検証用休憩",
      start: "12:00",
      end: "13:00",
      required_grades: [],
    },
  ],
  assignments: [
    {
      department: "テスト工学科",
      grade: 4,
      number: 7,
      visits: [
        { term: 1, company_id: "AM-1" },
        { term: 2, company_id: "PM-1" },
        { term: 9, company_id: "missing" },
      ],
    },
    {
      department: "テスト工学科",
      grade: 3,
      number: 8,
      visits: [{ term: 1, company_id: "AM-2" }],
    },
  ],
  documents: [
    {
      id: "floor-a",
      title: "テスト会場配置",
      kind: "map",
      mime_type: "image/png",
      file_name: "test-floor-a.png",
      source_page: 4,
      url: "/api/documents/floor-a",
    },
    {
      id: "floor-b",
      title: "テスト休憩室",
      kind: "map",
      mime_type: "image/png",
      file_name: "test-floor-b.png",
      source_page: 5,
      url: "/api/documents/floor-b",
    },
    {
      id: "guide",
      title: "テストガイド原本",
      kind: "guide",
      mime_type: "application/pdf",
      file_name: "test-guide.pdf",
      source_page: 0,
      url: "/api/documents/guide",
    },
  ],
  notices: ["検証用のお知らせ"],
};
export function fixture() {
  return structuredClone(guidance);
}
