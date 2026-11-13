import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from extract_guidance import (
    assignment_row, booth_rectangles, company_rows, extract, extract_map_booths,
    notice_sections, notice_text, recognize_booth_candidates, resolve_booth_numbers, schedule_rows, validate,
    task_actions,
)


class SyntheticMapPage:
    mediabox = SimpleNamespace(width=100, height=200)

    def __init__(self, rectangles=None, rotation=0):
        self.rectangles = rectangles if rectangles is not None else [
            (20, 40, -10, -20), (40, 60, -10, -20), (.1, .1, .1, .1),
            (50, 70, 30, 40),
        ]
        self.rotation = rotation

    def get(self, key, default):
        return self.rotation

    def extract_text(self, visitor_operand_before):
        visitor_operand_before(b"q", [], [1, 0, 0, 1, 0, 0], None)
        for rectangle in self.rectangles:
            visitor_operand_before(b"re", rectangle, [1, 0, 0, 1, 0, 0], None)


class SyntheticImage:
    def __init__(self, width=100, height=200):
        self.width, self.height = width, height
        self.loaded = False

    def load(self):
        self.loaded = True

    def crop(self, box):
        return SyntheticImage(box[2] - box[0], box[3] - box[1])

    def convert(self, mode):
        return self

    def resize(self, size):
        return SyntheticImage(*size)

    def paste(self, image, position):
        pass

    def save(self, path):
        path.write_bytes(b"synthetic OCR image")


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

    def test_notice_text_joins_japanese_wraps_and_preserves_english_and_urls(self):
        self.assertEqual(notice_text("架空の資 料を確認し\nてください。 ４ 年生"), "架空の資料を確認してください。4年生")
        self.assertEqual(notice_text("Taskly Example ( https://example.test/path )"),
                         "Taskly Example (https://example.test/path)")
        self.assertEqual(notice_text("９： ３０ ～ １０： ００"), "9:30 ~ 10:00")

    def test_notice_sections_preserve_headings_lists_notes_and_page_continuations(self):
        result = notice_sections([
            "架空資料のページ見出し\n【説明】\n　説明を折り\n返して記載。\n次の段落。\n"
            "【一覧】\n1. 一覧\n1） 集合\n３ 年生 ８：００ 架空教室\n４ 年生 ８：１０ 架空教室\n"
            "※注意を折り\n返す。\n2. 準備\n・ 持ち物を準備し\n　 当日持参してください。",
            "・ 別の持ち物。\nまた、確認してください。\n▶ 選択肢Ａ\n▶ 選択肢Ｂ\n"
            "〈例. 架空学年〉\n説明文。\n\n（注）追記。\n− 2 −",
        ])
        self.assertEqual([section["title"] for section in result], ["説明", "集合", "準備"])
        self.assertEqual(result[0]["blocks"], [
            {"type": "paragraph", "text": "説明を折り返して記載。"},
            {"type": "paragraph", "text": "次の段落。"},
        ])
        self.assertEqual(result[1]["blocks"][0], {"type": "list", "items": [
            "3年生8:00架空教室", "4年生8:10架空教室"]})
        self.assertEqual(result[1]["blocks"][1], {"type": "paragraph", "text": "※注意を折り返す。"})
        self.assertEqual(result[2]["blocks"][0], {"type": "list", "items": [
            "持ち物を準備し当日持参してください。", "別の持ち物。"]})
        self.assertEqual(result[2]["blocks"][1], {"type": "paragraph", "text": "また、確認してください。"})
        self.assertEqual(result[2]["blocks"][2], {"type": "list", "items": ["選択肢A", "選択肢B"]})
        self.assertEqual(result[2]["blocks"][-1], {"type": "paragraph", "text": "(注)追記。"})
        self.assertEqual(notice_sections(["見出しがないページ\n本文"]), [])

    def test_task_actions_extract_source_links_deadline_and_physical_sheet_page(self):
        texts = [
            "架空の表紙",
            "−7−\n1社聴講終了ごとに架空シートを記入し、見学アンケートに回答してください。\n"
            "キャリアガイダンス終了後は全体アンケートに回答してください。\n"
            "本科3、4年生はP70-71の用紙を会場出口の箱に提出してください。\n"
            "見学アンケート、全体アンケートの回答期限は６月１７日２４時です。",
            "−9−\n【アンケート】\n【見学アンケート】\n〈 https://forms.example.test/visit-feedback 〉\n"
            "【全体アンケート】\n〈 https://forms.example.test/event-feedback 〉",
            "−70−\nキャリアガイダンス 見学企業シート\n"
            "このチェックシートは終了後、出口の箱に切り取って提出してください。",
            "−71−\n架空シートの裏面",
        ]
        actions = task_actions(texts, "2032-06-17")
        self.assertEqual(actions["visit_survey"], {
            "url": "https://forms.example.test/visit-feedback", "source_page": 9,
            "due_at": "2032-06-18T00:00:00+09:00",
            "instructions": "1社聴講終了ごとに架空シートを記入し、見学アンケートに回答してください。",
        })
        self.assertEqual(actions["overall_survey"]["due_at"], "2032-06-18T00:00:00+09:00")
        self.assertEqual(actions["overall_survey"]["instructions"], "キャリアガイダンス終了後は全体アンケートに回答してください。")
        self.assertEqual(actions["sheet_submission"], {
            "document_id": "guidebook", "page": 4, "source_page": 70,
            "instructions": "本科3、4年生はP70-71の用紙を会場出口の箱に提出してください。",
        })
        self.assertNotIn("due_at", actions["sheet_submission"])

    def test_task_actions_do_not_invent_missing_links_or_a_clock_deadline(self):
        self.assertEqual(task_actions(["アンケートは当日中に回答する。"], "2032-06-17"), {})
        actions = task_actions(["【見学アンケート】\nhttps://forms.example.test/visit-feedback\n回答期限は当日です。"], "2032-06-17")
        self.assertEqual(actions, {"visit_survey": {"url": "https://forms.example.test/visit-feedback"}})
        fallback = task_actions([
            "キャリアガイダンス 見学企業シート\nこのチェックシートは出口に提出してください。",
        ], "2032-06-17")["sheet_submission"]
        self.assertEqual(fallback["page"], 1)
        self.assertEqual(fallback["instructions"], "このチェックシートは出口に提出してください。")
        self.assertNotIn("source_page", fallback)
        no_instruction = task_actions(["見学企業シート このチェックシートは未完の文"], "2032-06-17")
        self.assertNotIn("instructions", no_instruction["sheet_submission"])

    def test_task_actions_reject_unsafe_missing_and_ambiguous_source_urls(self):
        for link in ["http://forms.example.test/visit", "https://user:secret@forms.example.test/visit",
                     "https://forms.example.test/one https://forms.example.test/two", "URLなし"]:
            with self.subTest(link=link), self.assertRaises(ValueError):
                task_actions(["【見学アンケート】\n" + link], "2032-06-17")
        with self.assertRaisesRegex(ValueError, "Conflicting questionnaire URLs"):
            task_actions(["【見学アンケート】https://forms.example.test/one",
                          "【見学アンケート】https://forms.example.test/two"], "2032-06-17")
        repeated = task_actions(["【見学アンケート】https://forms.example.test/one"] * 2, "2032-06-17")
        self.assertEqual(repeated["visit_survey"]["url"], "https://forms.example.test/one")

    def test_task_actions_deadline_preserves_source_year_minutes_and_rejects_conflicts(self):
        heading = "【全体アンケート】https://forms.example.test/event-feedback"
        actions = task_actions([heading, "回答期限は2033年2月3日17時30分です。"], "2032-06-17")
        self.assertEqual(actions["overall_survey"]["due_at"], "2033-02-03T17:30:00+09:00")
        for value in ["回答期限は6月17日25時", "回答期限は6月17日24時1分", "回答期限は6月17日17時60分",
                      "回答期限は2月30日17時"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                task_actions([heading, value], "2032-06-17")
        with self.assertRaisesRegex(ValueError, "Conflicting questionnaire deadlines"):
            task_actions([heading, "回答期限は6月17日23時", "回答期限は6月18日23時"], "2032-06-17")

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
            "【開催趣旨】\n架空の説明。\n【次】\n参加企業:2社\n架空会社A AM 1 情報処理\n架空会社B PM 1 機械",
            "ガイダンススケジュール\n時　　間 内　　容\n" + "\n".join(f"{9 + term}:00 ～ {9 + term}:20 {term}ターム（3年指定）" for term in range(1, 9)),
            "名簿 番号\n①ターム ③ターム ⑤ターム ⑥ターム\n架空学科 3年生 1 架空会社A 1 架空会社A 1 架空会社B 1 架空会社B 1",
            "−1−\nブース配置図(架空階)",
            "−2−\n昼食休憩室案内図(架空階)",
            "−9−\n【見学アンケート】https://forms.example.test/visit-feedback\n"
            "【全体アンケート】https://forms.example.test/event-feedback\n回答期限は1月2日24時です。",
            "−70−\nキャリアガイダンス 見学企業シート\nこのチェックシートは出口に提出してください。",
        ]

        class Writer:
            def add_page(self, page):
                pass

            def write(self, stream):
                stream.write(b"%PDF- synthetic")

        class Image:
            width, height = 600, 400

            def save(self, path):
                path.write_bytes(b"synthetic PNG")

        fake_reader = SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda text=text: text) for text in texts])
        fake_pdf = [SimpleNamespace(render=lambda **kwargs: SimpleNamespace(to_pil=lambda: Image())) for _ in texts]
        modules = {
            "pypdf": SimpleNamespace(PdfReader=lambda path: fake_reader, PdfWriter=Writer),
            "pypdfium2": SimpleNamespace(PdfDocument=lambda path: fake_pdf),
        }
        with TemporaryDirectory() as directory, patch.dict("sys.modules", modules), patch(
            "extract_guidance.extract_map_booths",
            return_value=[{"booth": 1, "x": .1, "y": .2, "width": .1, "height": .1}],
        ):
            source = Path(directory) / "source.pdf"
            source.write_bytes(b"%PDF- synthetic")
            output = Path(directory) / "private"
            result = extract(source, output)
            self.assertEqual(result["event"]["date"], "2030-01-02")
            self.assertEqual(result["event"]["task_actions"]["visit_survey"]["url"], "https://forms.example.test/visit-feedback")
            self.assertEqual(result["event"]["task_actions"]["overall_survey"]["due_at"], "2030-01-03T00:00:00+09:00")
            self.assertEqual(result["event"]["task_actions"]["sheet_submission"]["page"], 8)
            self.assertEqual(len(result["companies"]), 2)
            self.assertEqual(len(result["assignments"]), 1)
            self.assertEqual(len(result["documents"]), 5)
            self.assertEqual(result["notice_sections"][0]["title"], "開催趣旨")
            self.assertEqual(result["documents"][0]["booths"][0]["booth"], 1)
            self.assertEqual(result["documents"][0]["image_width"], 600)
            self.assertEqual(result["documents"][0]["image_height"], 400)
            self.assertEqual(result["documents"][2]["image_width"], 600)
            self.assertNotIn("image_width", result["documents"][1])
            self.assertEqual((output / "guidance.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            self.assertEqual((output / "guidebook.pdf").read_bytes(), source.read_bytes())

    def test_private_output_rejects_repository_directory(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            extract(Path("absent.pdf"), Path(__file__).resolve().parents[1] / "private")

    def test_map_cell_rectangles_are_rotated_and_normalized_from_vectors(self):
        boxes = booth_rectangles(SyntheticMapPage(), 2)
        self.assertEqual(boxes[0], {"x": .1, "y": .1, "width": .1, "height": .1})
        self.assertEqual(boxes[1], {"x": .2, "y": .3, "width": .1, "height": .1})
        with self.assertRaisesRegex(ValueError, "rotation"):
            booth_rectangles(SyntheticMapPage(rotation=90), 2)
        with self.assertRaisesRegex(ValueError, "unambiguous"):
            booth_rectangles(SyntheticMapPage(), 0)
        with self.assertRaisesRegex(ValueError, "unambiguous"):
            booth_rectangles(SyntheticMapPage(), 3)

    def test_ocr_candidates_resolve_only_unique_complete_number_assignment(self):
        self.assertEqual(resolve_booth_numbers([{1, 2}, {2}], {1, 2}), [1, 2])
        self.assertEqual(resolve_booth_numbers([{1, 9}, {2}], {1, 2}), [1, 2])
        invalid = [
            ([], set()),
            ([{1}], {1, 2}),
            ([set(), {2}], {1, 2}),
            ([{1, 2}, {1, 2}], {1, 2}),
            ([{1}, {1}], {1, 2}),
            ([{1}, {1}, {2, 3}], {1, 2, 3}),
        ]
        for candidates, expected in invalid:
            with self.subTest(candidates=candidates), self.assertRaises(ValueError):
                resolve_booth_numbers(candidates, expected)

    def test_cell_ocr_uses_two_crops_and_never_accepts_non_numeric_output(self):
        with patch("extract_guidance.subprocess.run", side_effect=[
            SimpleNamespace(stdout="2\n"), SimpleNamespace(stdout="not a number"),
        ]) as run:
            candidates = recognize_booth_candidates(
                SyntheticImage(), {"x": .1, "y": .1, "width": .2, "height": .2})
        self.assertEqual(candidates, {2})
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.kwargs["env"]["OMP_THREAD_LIMIT"], "1")
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    def test_map_extraction_validates_image_bounds_and_missing_ocr(self):
        image = SyntheticImage()
        with patch("extract_guidance.shutil.which", return_value=None):
            with self.assertRaisesRegex(ValueError, "Tesseract"):
                extract_map_booths(None, image, {1, 2})
        boxes = [{"x": .1, "y": .1, "width": .1, "height": .1},
                 {"x": .2, "y": .3, "width": .1, "height": .1}]
        with patch("extract_guidance.shutil.which", return_value="synthetic-tesseract"), patch(
            "extract_guidance.booth_rectangles", return_value=boxes
        ), patch("extract_guidance.recognize_booth_candidates", side_effect=lambda image, box: {1 if box["x"] == .1 else 2}):
            result = extract_map_booths(None, image, {1, 2})
            self.assertEqual([booth["booth"] for booth in result], [1, 2])
            self.assertTrue(image.loaded)
            boxes[1]["width"] = 1
            with self.assertRaisesRegex(ValueError, "outside"):
                extract_map_booths(None, image, {1, 2})


if __name__ == "__main__":
    unittest.main()
