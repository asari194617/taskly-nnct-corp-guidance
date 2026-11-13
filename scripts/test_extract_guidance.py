import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from extract_guidance import assignment_row, company_rows, extract, schedule_rows, validate


class ExtractionTests(unittest.TestCase):
    def test_company_unicode_and_semicolon_industries(self):
        rows = company_rows("架空会社Ａ AM １ 情報処理 ; 建設\n架空会社Ｂ PM 2 機械", 6)
        self.assertEqual(rows[0]["id"], "AM-1")
        self.assertEqual(rows[0]["industries"], ["情報処理", "建設"])
        self.assertEqual(rows[0]["source_page"], 6)

    def test_assignment_resolves_by_booth_and_term(self):
        row = assignment_row("架空学科 3年生 8 架空会社Ａ 1 架空会社Ｂ 2 架空会社Ｃ 3 架空会社Ｄ 4", [1, 3, 5, 6], 14)
        self.assertEqual([visit["company_id"] for visit in row["visits"]], ["AM-1", "AM-2", "PM-3", "PM-4"])
        self.assertEqual(row["number"], 8)

    def test_absent_roster_entries_have_no_assignments(self):
        for marker in ("(休)", "(退)"):
            self.assertIsNone(assignment_row("架空学科 4年生 8" + marker, [1, 4, 5, 8], 19))

    def test_incomplete_assignment_rejected(self):
        with self.assertRaises(ValueError):
            assignment_row("架空学科 3年生 8 架空会社Ａ 1", [1, 3, 5, 6], 14)

    def test_schedule_normalizes_fullwidth_times_and_grades(self):
        rows = schedule_rows("９：２０ ～ ９：４０ ①ターム（３年指定・４年自由）")
        self.assertEqual(rows[0]["start"], "09:20")
        self.assertEqual(rows[0]["term"], 1)
        self.assertEqual(rows[0]["required_grades"], [3])

    def test_invalid_and_duplicate_company_references_rejected(self):
        dataset = {
            "companies": [{"id": "AM-1", "session": "AM", "booth": 1}, {"id": "PM-1", "session": "PM", "booth": 1}],
            "assignments": [{"department": "架空学科", "grade": 3, "number": 1,
                             "visits": [{"company_id": "AM-1"}] * 3 + [{"company_id": "PM-2"}]}],
            "schedule": [{"term": term} for term in range(1, 9)],
        }
        with self.assertRaisesRegex(ValueError, "booth reference"):
            validate(dataset)
        dataset["assignments"] = []
        dataset["companies"].append(dataset["companies"][0])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate(dataset)

    def test_end_to_end_extraction_with_synthetic_pdf_adapter(self):
        # Inject a tiny PDF adapter so this test runs without PDF libraries and
        # verifies our parsing/output contract using entirely synthetic data.
        texts = [
            "令和 12 年度\n架空ガイダンス\n学 科\n開催日:令和 12 年 1 月 2 日\n開催場所:架空会場 主催:架空学校",
            "【開催趣旨】架空の説明。【次】参加企業:2社\n架空会社A AM 1 情報処理\n架空会社B PM 1 機械",
            "ガイダンススケジュール\n時　　間 内　　容\n" + "\n".join(f"{9 + term}:00 ～ {9 + term}:20 {term}ターム（3年指定）" for term in range(1, 9)),
            "名簿 番号\n①ターム ③ターム ⑤ターム ⑥ターム\n架空学科 3年生 1 架空会社A 1 架空会社A 1 架空会社B 1 架空会社B 1",
            "−1−\nブース配置図(架空階)",
            "−2−\n昼食休憩室案内図(架空階)",
        ]

        class Writer:
            def add_page(self, page):
                pass

            def write(self, stream):
                stream.write(b"%PDF- synthetic")

        class Image:
            def save(self, path):
                path.write_bytes(b"synthetic PNG")

        fake_reader = SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda text=text: text) for text in texts])
        fake_pdf = [SimpleNamespace(render=lambda **kwargs: SimpleNamespace(to_pil=lambda: Image())) for _ in texts]
        modules = {
            "pypdf": SimpleNamespace(PdfReader=lambda path: fake_reader, PdfWriter=Writer),
            "pypdfium2": SimpleNamespace(PdfDocument=lambda path: fake_pdf),
        }
        with TemporaryDirectory() as directory, patch.dict("sys.modules", modules):
            source = Path(directory) / "source.pdf"
            source.write_bytes(b"%PDF- synthetic")
            output = Path(directory) / "private"
            result = extract(source, output)
            self.assertEqual(result["event"]["date"], "2030-01-02")
            self.assertEqual(len(result["companies"]), 2)
            self.assertEqual(len(result["assignments"]), 1)
            self.assertEqual(len(result["documents"]), 5)
            self.assertEqual((output / "guidance.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            self.assertEqual((output / "guidebook.pdf").read_bytes(), source.read_bytes())

    def test_private_output_rejects_repository_directory(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            extract(Path("absent.pdf"), Path(__file__).resolve().parents[1] / "private")


if __name__ == "__main__":
    unittest.main()
