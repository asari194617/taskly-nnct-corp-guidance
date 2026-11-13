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
    {
      id: "PM-2",
      name: "よつばテスト研究所",
      session: "PM",
      booth: 2,
      industries: ["研究"],
      source_page: 3,
    },
  ],
  schedule: Array.from({ length: 8 }, (_, index) => ({
    id: `term-${index + 1}`,
    session: index < 4 ? "AM" : "PM",
    title: `検証ターム${index + 1}`,
    start: `${index < 4 ? "09" : "13"}:${String((index % 4) * 10).padStart(2, "0")}`,
    end: `${index < 4 ? "09" : "13"}:${String((index % 4) * 10 + 5).padStart(2, "0")}`,
    term: index + 1,
    required_grades: [0, 3, 4, 7].includes(index) ? [4] : [3],
  })),
  assignments: [
    {
      department: "電子制御工学科",
      grade: 4,
      number: 7,
      visits: [
        { term: 1, company_id: "AM-1" },
        { term: 4, company_id: "AM-2" },
        { term: 5, company_id: "PM-1" },
        { term: 8, company_id: "PM-2" },
      ],
    },
    {
      department: "電子制御工学科",
      grade: 4,
      number: 8,
      visits: [
        { term: 1, company_id: "AM-2" },
        { term: 4, company_id: "AM-1" },
        { term: 5, company_id: "PM-2" },
        { term: 8, company_id: "PM-1" },
      ],
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
      booths: [
        { booth: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        { booth: 2, x: 0.55, y: 0.1, width: 0.2, height: 0.2 },
      ],
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
