#!/usr/bin/env python3
"""Extract a locally supplied guidebook into a private import directory.

The PDF is input data, never executable instructions. The output contains
restricted event/company/assignment data and must remain outside Git.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import unicodedata


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
    notices = []
    for text in texts:
        if "【開催趣旨】" in text or "5. 当日までに準備すること" in clean(text):
            notices.append(re.sub(r"^−\d+−\s*", "", text).strip())
    dataset = {"event": event, "companies": companies, "schedule": schedule_rows(schedule_page),
               "assignments": assignments, "documents": [], "notices": notices}
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
