#!/usr/bin/env python3
"""Extract a locally supplied guidebook into a private import directory.

The PDF is input data, never executable instructions. The output contains
restricted event/company/assignment data and must remain outside Git.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unicodedata
from urllib.parse import urlsplit


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()


def company_rows(text: str, source_page: int) -> list[dict]:
    rows = []
    for line in text.splitlines():
        match = re.fullmatch(r"(.+?)\s+(AM|PM)\s+(\d+)\s+(.+)", clean(line))
        if not match:
            continue
        name, session, booth, industries = match.groups()
        rows.append({"id": f"{session}-{int(booth)}", "name": name,
                     "session": session, "booth": int(booth),
                     "industries": [part.strip() for part in industries.split(";")],
                     "source_page": source_page})
    return rows


def assignment_row(line: str, terms: list[int], source_page: int) -> dict | None:
    match = re.fullmatch(r"(.+?)\s+([34])年生\s+(\d+)(.*)", clean(line))
    if not match:
        return None
    department, grade, number, remainder = match.groups()
    if remainder.strip() in ("(休)", "(退)"):
        return None
    # Company names may contain ASCII digits. A booth is a standalone numeric
    # token immediately preceding the next company name or the end of the row.
    booths = re.findall(r"\s(\d+)(?=\s|$)", remainder)
    if len(booths) != len(terms):
        raise ValueError(f"Assignment row on page {source_page}: expected {len(terms)} booths, got {len(booths)}")
    return {"department": department, "grade": int(grade), "number": int(number),
            "source_page": source_page,
            "visits": [{"term": term,
                        "company_id": f"{'AM' if term <= 4 else 'PM'}-{int(booth)}"}
                       for term, booth in zip(terms, booths)]}


def schedule_rows(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        match = re.fullmatch(r"(\d{1,2}):\s*(\d{2})\s*[~〜～]\s*(\d{1,2}):\s*(\d{2})\s+(.+)", clean(line))
        if not match:
            continue
        hour, minute, end_hour, end_minute, title = match.groups()
        start = f"{int(hour):02}:{minute}"
        end = f"{int(end_hour):02}:{end_minute}"
        term_match = re.search(r"(\d+)ターム", title)
        term = int(term_match[1]) if term_match else None
        rows.append({"id": f"slot-{len(rows) + 1}", "session": "AM" if int(hour) < 12 else "PM",
                     "title": title, "start": start, "end": end, "term": term,
                     "required_grades": [int(grade) for grade in re.findall(r"([34])年指定", title)]})
    return rows


def notice_text(text: str) -> str:
    """Join PDF line wraps without inserting spaces inside Japanese words."""
    value = clean(text)
    value = re.sub(r"(?<=[^\x00-\x7f])\s+|\s+(?=[^\x00-\x7f])", "", value)
    value = re.sub(r"\s+([,.:;)])|([(:])\s+", lambda match: match[1] or match[2], value)
    return value


def notice_sections(notices: list[str]) -> list[dict]:
    """Turn source headings, paragraphs and bullets into ordered text blocks.

    All content comes from the local source. Only structural markers are
    recognized here; no event-specific wording or source text is embedded.
    """
    sections = []
    section = None
    pending = []
    pending_type = "paragraph"

    def flush():
        if not pending or section is None:
            return
        text = notice_text(" ".join(pending))
        if pending_type == "list":
            if section["blocks"] and section["blocks"][-1]["type"] == "list":
                section["blocks"][-1]["items"].append(text)
            else:
                section["blocks"].append({"type": "list", "items": [text]})
        else:
            section["blocks"].append({"type": "paragraph", "text": text})
        pending.clear()

    for page in notices:
        for raw in page.splitlines():
            line = clean(raw)
            if not line or re.fullmatch(r"[−-]\s*\d+\s*[−-]", line):
                flush()
                continue
            heading = re.fullmatch(r"【(.+)】|\d+[.)]\s*(.+)", line)
            if heading:
                flush()
                section = {"id": f"notice-{len(sections) + 1}",
                           "title": notice_text(heading[1] or heading[2]), "blocks": []}
                sections.append(section)
                continue
            if section is None:
                continue  # Ignore the page's running title before its first heading.
            bullet = re.match(r"^[・▶]\s*(.*)", line)
            row = re.match(r"^(?:〈[^〉]+〉|[34]\s*年生\s+\d|専攻\s*\d\s+\d)", line)
            note = re.match(r"^(?:[※*]|\(注\)|〈例)", line)
            if bullet or row or note:
                flush()
                pending_type = "list" if bullet or row and not note else "paragraph"
                pending.append(bullet[1] if bullet else line)
            else:
                if pending and not raw[0].isspace() and pending[-1].endswith("。"):
                    flush()
                if not pending:
                    pending_type = "paragraph"
                pending.append(line)
    flush()
    return [section for section in sections if section["blocks"]]


def task_actions(texts: list[str], event_date: str) -> dict:
    """Read questionnaire links and submission instructions from the source.

    URLs, dates and prose remain source data in the private JSON. A missing
    section has no invented fallback, and conflicting links/deadlines fail.
    PDF page numbers are physical one-based indices; source_page is printed.
    """
    actions = {}
    normalized = [notice_text(text) for text in texts]
    printed_page = lambda text: next((int(match[1]) for match in re.finditer(
        r"(?:^|\n)[−-]\s*(\d+)\s*[−-](?=\s*(?:\n|$))", text)), None)
    labels = {"見学アンケート": "visit_survey", "全体アンケート": "overall_survey"}
    for text in texts:
        for section in re.finditer(r"【\s*(見学アンケート|全体アンケート)\s*】(.*?)(?=【|$)", text, re.S):
            links = re.findall(r"https?://[^\s<>〈〉]+", section[2])
            if len(links) != 1:
                raise ValueError("A questionnaire section needs exactly one source URL")
            url = links[0]
            parsed = urlsplit(url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("Questionnaire source URL must be HTTPS without credentials")
            kind = labels[section[1].strip()]
            if kind in actions and actions[kind]["url"] != url:
                raise ValueError("Conflicting questionnaire URLs in source")
            if kind not in actions:
                actions[kind] = {"url": url}
                page = printed_page(text)
                if page is not None:
                    actions[kind]["source_page"] = page

    deadlines = set()
    for text in normalized:
        for match in re.finditer(r"回答期限は(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(\d{1,2})時(?:(\d{1,2})分)?", text):
            year = int(match[1]) if match[1] else datetime.fromisoformat(event_date).year
            month, day, hour = map(int, match.group(2, 3, 4))
            minute = int(match[5] or 0)
            if not (0 <= hour <= 24 and 0 <= minute <= 59) or hour == 24 and minute != 0:
                raise ValueError("Invalid questionnaire deadline in source")
            deadline = datetime(year, month, day, hour % 24, minute,
                                tzinfo=timezone(timedelta(hours=9)))
            if hour == 24:
                deadline += timedelta(days=1)
            deadlines.add(deadline.isoformat())
    if len(deadlines) > 1:
        raise ValueError("Conflicting questionnaire deadlines in source")
    if deadlines:
        for action in actions.values():
            action["due_at"] = next(iter(deadlines))

    instruction_patterns = {
        "visit_survey": r"1社聴講終了ごと[^。]*。",
        "overall_survey": r"キャリアガイダンス終了後は[^。]*全体アンケート[^。]*。",
    }
    for kind, pattern in instruction_patterns.items():
        if kind in actions:
            instruction = next((match[0] for text in normalized
                                if (match := re.search(pattern, text))), None)
            if instruction:
                actions[kind]["instructions"] = instruction

    for index, text in enumerate(normalized):
        if "見学企業シート" not in text or "このチェックシートは" not in text:
            continue
        instruction = next((match[0] for page in normalized if (match := re.search(
            r"本科3[^。]*P\d+-\d+[^。]*会場出口[^。]*提出してください。", page))), None)
        if not instruction:
            match = re.search(r"このチェックシートは[^。]*提出してください。", text)
            instruction = match[0] if match else None
        action = {"document_id": "guidebook", "page": index + 1}
        page = printed_page(texts[index])
        if page is not None:
            action["source_page"] = page
        if instruction:
            action["instructions"] = instruction
        actions["sheet_submission"] = action
        break
    return actions


def booth_rectangles(page, expected_count: int) -> list[dict]:
    """Find repeated vector cells and rotate their bounds with the map image.

    Cell dimensions and positions come from the supplied PDF. Numeral glyphs
    may be outlined paths, so label recognition is a separate OCR step.
    """
    if int(page.get("/Rotate", 0)) % 360:
        raise ValueError("Map page rotation must be normalized before extraction")
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    rectangles = []

    def visit(operator, arguments, matrix, _text_matrix):
        if operator != b"re":
            return
        x, y, w, h = map(float, arguments)
        a, b, c, d, e, f = matrix
        points = [(a * px + c * py + e, b * px + d * py + f)
                  for px, py in ((x, y), (x + w, y), (x, y + h), (x + w, y + h))]
        xs, ys = zip(*points)
        left, bottom, right, top = min(xs), min(ys), max(xs), max(ys)
        if right - left > width * .01 and top - bottom > height * .01:
            rectangles.append((left, bottom, right, top))

    page.extract_text(visitor_operand_before=visit)
    sizes = Counter((round(right - left, 1), round(top - bottom, 1))
                    for left, bottom, right, top in rectangles)
    groups = [size for size, count in sizes.items() if count == expected_count]
    if expected_count < 1 or len(groups) != 1:
        raise ValueError("Map does not contain one unambiguous repeated booth-cell group")
    selected = [box for box in rectangles
                if (round(box[2] - box[0], 1), round(box[3] - box[1], 1)) == groups[0]]
    # The rendered map is rotated clockwise 90 degrees: PDF bottom-left (x,y)
    # becomes displayed top-left (y,x). Values are independent of render scale.
    return [{"x": bottom / height, "y": left / width,
             "width": (top - bottom) / height, "height": (right - left) / width}
            for left, bottom, right, top in selected]


def resolve_booth_numbers(candidates: list[set[int]], expected: set[int]) -> list[int]:
    """Require a uniquely constrained assignment of OCR results to booth IDs.

    Only numbers actually recognized in a cell may be selected. If multiple
    assignments remain possible, fail rather than infer a layout or guess.
    """
    if not expected or len(candidates) != len(expected):
        raise ValueError("Map cell count does not match the company booth set")
    options = [set(values) & expected for values in candidates]
    resolved = {}
    remaining = set(expected)
    while len(resolved) < len(options):
        if any(not values for index, values in enumerate(options) if index not in resolved):
            raise ValueError("A map cell has no recognized booth number")
        forced = {index: next(iter(values)) for index, values in enumerate(options)
                  if index not in resolved and len(values) == 1}
        for number in remaining:
            cells = [index for index, values in enumerate(options)
                     if index not in resolved and number in values]
            if not cells:
                raise ValueError("An expected booth number was not recognized")
            if len(cells) == 1:
                index = cells[0]
                if index in forced and forced[index] != number:
                    raise ValueError("Conflicting booth-number recognition")
                forced[index] = number
        if not forced or len(set(forced.values())) != len(forced):
            raise ValueError("Ambiguous booth-number recognition; review the source map")
        resolved.update(forced)
        remaining -= set(forced.values())
        for index in range(len(options)):
            if index not in resolved:
                options[index] -= set(forced.values())
    return [resolved[index] for index in range(len(options))]


def recognize_booth_candidates(image, box: dict) -> set[int]:
    """Read one cell with two independent crop/segmentation settings."""
    result = set()
    with TemporaryDirectory(prefix="guidance-map-cell-") as directory:
        for margin, padded, scale, segmentation in ((.08, False, 200, 7), (.06, True, 300, 6)):
            x, y, width, height = (box[key] for key in ("x", "y", "width", "height"))
            bounds = (round((x + width * margin) * image.width),
                      round((y + height * margin) * image.height),
                      round((x + width * (1 - margin)) * image.width),
                      round((y + height * (1 - margin)) * image.height))
            cell = image.crop(bounds).convert("L")
            if padded:
                canvas = cell.resize((cell.width + 12, cell.height + 12))
                canvas.paste(255, (0, 0, canvas.width, canvas.height))
                canvas.paste(cell, (6, 6))
                cell = canvas
            path = Path(directory) / "cell.png"
            cell.resize((scale, scale)).save(path)
            process = subprocess.run(
                ["tesseract", str(path), "stdout", "--psm", str(segmentation),
                 "-c", "tessedit_char_whitelist=0123456789"],
                capture_output=True, text=True, check=True, timeout=15,
                env={**os.environ, "OMP_THREAD_LIMIT": "1"})
            value = process.stdout.strip()
            if re.fullmatch(r"\d+", value):
                result.add(int(value))
    return result


def extract_map_booths(page, image, expected: set[int]) -> list[dict]:
    if not shutil.which("tesseract"):
        raise ValueError("Tesseract OCR is required to identify numbered map cells")
    boxes = booth_rectangles(page, len(expected))
    image.load()  # Decode once before sharing the immutable image among workers.
    with ThreadPoolExecutor(max_workers=4) as workers:
        candidates = list(workers.map(lambda box: recognize_booth_candidates(image, box), boxes))
    numbers = resolve_booth_numbers(candidates, expected)
    booths = [{"booth": number, **box} for number, box in zip(numbers, boxes)]
    for booth in booths:
        if not (0 <= booth["x"] < 1 and 0 <= booth["y"] < 1
                and 0 < booth["width"] <= 1 - booth["x"]
                and 0 < booth["height"] <= 1 - booth["y"]):
            raise ValueError("A map cell falls outside the rendered map")
    return sorted(booths, key=lambda booth: booth["booth"])


def validate(dataset: dict, expected_companies: int | None = None, expected_students: int | None = None) -> None:
    companies = dataset["companies"]
    company_ids = {row["id"] for row in companies}
    if len(company_ids) != len(companies):
        raise ValueError("Duplicate company/session/booth")
    if expected_companies is not None and len(companies) != expected_companies:
        raise ValueError(f"Expected {expected_companies} companies, extracted {len(companies)}")
    for session in ("AM", "PM"):
        booths = sorted(row["booth"] for row in companies if row["session"] == session)
        if not booths or booths != list(range(1, max(booths) + 1)):
            raise ValueError(f"Missing or duplicate {session} booth")
    keys = set()
    for row in dataset["assignments"]:
        key = (row["department"], row["grade"], row["number"])
        if key in keys:
            raise ValueError("Duplicate student assignment")
        keys.add(key)
        if len(row["visits"]) != 4 or any(visit["company_id"] not in company_ids for visit in row["visits"]):
            raise ValueError("Invalid assignment booth reference")
    if expected_students is not None and len(keys) != expected_students:
        raise ValueError(f"Expected {expected_students} assigned students, extracted {len(keys)}")
    terms = [row["term"] for row in dataset["schedule"] if row["term"] is not None]
    if terms != list(range(1, 9)):
        raise ValueError("Expected eight ordered schedule terms")


def extract(source: Path, output: Path) -> dict:
    output = output.resolve()
    if output.is_relative_to(Path(__file__).resolve().parents[1]) or any(
        (directory / ".git").exists() for directory in (output, *output.parents)
    ):
        raise ValueError("Private output must be outside the source repository")
    from pypdf import PdfReader, PdfWriter
    import pypdfium2 as pdfium
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.chmod(0o700)
    reader = PdfReader(source)
    texts = [page.extract_text() or "" for page in reader.pages]
    normalized = [clean(text) for text in texts]
    cover = normalized[0]
    date_match = re.search(r"開催日:\s*令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日", cover)
    if not date_match:
        raise ValueError("Event date not found")
    era, month, day = map(int, date_match.groups())
    title_match = re.search(r"令和\s*\d+\s*年度\s+(.+?)\s+学", cover)
    venue_match = re.search(r"開催場所:\s*(.+?)\s+主催:", cover)
    purpose_match = next((re.search(r"【開催趣旨】\s*(.+?)\s*【", text) for text in normalized if "【開催趣旨】" in text), None)
    if not title_match or not venue_match or not purpose_match:
        raise ValueError("Event title, venue, or purpose not found")
    companies = [row for page, text in enumerate(texts, 1) for row in company_rows(text, page)]
    schedule_page = next((text for text in texts if "ガイダンススケジュール" in text and "時　　間" in text), None)
    if not schedule_page:
        raise ValueError("Schedule page not found")
    assignments = []
    for page, text in enumerate(texts, 1):
        if "名簿" not in text or "ターム" not in text:
            continue
        grade_match = re.search(r"([34])年生", clean(text))
        if not grade_match:
            continue
        terms = [int(term) for term in re.findall(r"([1-8])ターム", clean(text))[:4]]
        if len(terms) != 4:
            raise ValueError(f"Assignment term headers not found on page {page}")
        assignments.extend(row for line in text.splitlines() if (row := assignment_row(line, terms, page)) is not None)
    event = {"title": title_match[1], "date": f"{era + 2018:04}-{month:02}-{day:02}",
             "venue": venue_match[1], "description": purpose_match[1]}
    actions = task_actions(texts, event["date"])
    if actions:
        event["task_actions"] = actions
    notices = []
    for text in texts:
        if "【開催趣旨】" in text or "5. 当日までに準備すること" in clean(text):
            notices.append(re.sub(r"^−\d+−\s*", "", text).strip())
    dataset = {"event": event, "companies": companies, "schedule": schedule_rows(schedule_page),
               "assignments": assignments, "documents": [], "notices": notices,
               "notice_sections": notice_sections(notices)}
    all_text = " ".join(normalized)
    count_match = re.search(r"参加企業:\s*(\d+)\s*社", all_text)
    # Participant overview totals can include roster entries explicitly marked
    # as on leave or withdrawn. Only import rows that contain actual visits.
    validate(dataset, int(count_match[1]) if count_match else None)

    def document(doc_id: str, title: str, kind: str, mime: str, filename: str, page: int | None):
        dataset["documents"].append({"id": doc_id, "title": title, "kind": kind,
                                     "mime_type": mime, "file_name": filename,
                                     "source_page": page, "url": f"/api/documents/{doc_id}"})

    pdf = pdfium.PdfDocument(str(source))
    map_pages = [(index, text) for index, text in enumerate(texts)
                 if ("配置図" in text or "案内図" in text) and len(clean(text)) < 100]
    for index, text in map_pages:
        title = re.sub(r"^[−-]\d+[−-]\s*", "", clean(text)).strip()
        doc_id = "arena-map" if "配置図" in text else "lunch-map"
        filename = f"{doc_id}.png"
        # The map is laid out sideways on the portrait book page. Render it
        # landscape for the viewer without modifying the source PDF.
        image = pdf[index].render(scale=3, rotation=90).to_pil()
        image.save(output / filename)
        document(doc_id, title, "map", "image/png", filename, index + 1)
        dataset["documents"][-1].update(image_width=image.width, image_height=image.height)
        if "配置図" in text:
            expected = {company["booth"] for company in companies}
            dataset["documents"][-1]["booths"] = extract_map_booths(reader.pages[index], image, expected)
        writer = PdfWriter()
        writer.add_page(reader.pages[index])
        pdf_filename = f"{doc_id}.pdf"
        with (output / pdf_filename).open("wb") as stream:
            writer.write(stream)
        document(f"{doc_id}-pdf", title, "map-pdf", "application/pdf", pdf_filename, index + 1)
    if len(map_pages) != 2:
        raise ValueError(f"Expected two map pages, got {len(map_pages)}")
    shutil.copyfile(source, output / "guidebook.pdf")
    document("guidebook", event["title"], "guidebook", "application/pdf", "guidebook.pdf", None)
    (output / "guidance.json").write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n")
    for path in output.iterdir():
        if path.is_file():
            path.chmod(0o600)
    return dataset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, help="Private directory outside the Git repository")
    args = parser.parse_args()
    os.umask(0o077)
    dataset = extract(args.source.resolve(), args.output.resolve())
    print(json.dumps({"companies": len(dataset["companies"]), "assignments": len(dataset["assignments"]),
                      "schedule_slots": len(dataset["schedule"]), "documents": len(dataset["documents"])}))


if __name__ == "__main__":
    main()
