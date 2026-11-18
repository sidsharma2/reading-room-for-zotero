"""papers.py on a small fake Zotero library: what is missing, the shared folder, loose copies, and the report."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import sqlite3
import sys
import zlib
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("papers", HERE / "papers.py")
papers = importlib.util.module_from_spec(spec)
sys.modules["papers"] = papers
spec.loader.exec_module(papers)

SCHEMA = """
CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT, key TEXT);
CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, path TEXT, syncState INT, storageModTime INT, storageHash TEXT);
CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, libraryID INT);
CREATE TABLE collectionItems (collectionID INT, itemID INT);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE itemTags (itemID INT, tagID INT);
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
CREATE TABLE itemAnnotations (itemID INTEGER PRIMARY KEY, parentItemID INT, type INT);
INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment');
INSERT INTO fields VALUES (1, 'title'), (2, 'DOI'), (3, 'date'), (4, 'extra'), (5, 'url');
"""
HELD = b"%PDF-1.7\n% held paper\n"


def pdf_with(text: bytes) -> bytes:
    """A small PDF whose text is in a compressed stream, as real ones are."""
    body = zlib.compress(b"BT (" + text + b") Tj ET")
    return b"%PDF-1.7\n1 0 obj << /Filter /FlateDecode >>\nstream\n" + body + b"\nendstream\nendobj\n%%EOF\n"


@pytest.fixture()
def library(tmp_path: Path) -> Path:
    data = tmp_path / "Zotero"
    (data / "storage" / "ATTHELD1").mkdir(parents=True)
    (data / "storage" / "ATTHELD1" / "Held.pdf").write_bytes(HELD)
    db = sqlite3.connect(data / "zotero.sqlite")
    db.executescript(SCHEMA)
    papers_ = [
        (1, "PARHELD1", "Held paper about soot inception in flames", "10.1000/held", 11, "ATTHELD1", "Held.pdf", hashlib.md5(HELD).hexdigest()),
        (2, "PARMISS1", "Missing paper about mobility diameter of aggregates", "10.1000/miss", 12, "ATTMISS1", "Missing.pdf", ""),
        (3, "PARMISS2", "Another missing paper on effective density measurement", "", 13, "ATTMISS2", "Another.pdf", ""),
        (4, "PARDUPE1", "Held paper about soot inception in flames", "", 0, "", "", ""),
    ]
    value = 0
    for item_id, key, title, doi, attachment_id, attachment_key, filename, md5 in papers_:
        db.execute("INSERT INTO items VALUES (?, 1, 1, ?)", (item_id, key))
        for field_id, text in ((1, title), (2, doi)):
            if text:
                value += 1
                db.execute("INSERT INTO itemDataValues VALUES (?, ?)", (value, text))
                db.execute("INSERT INTO itemData VALUES (?, ?, ?)", (item_id, field_id, value))
        if attachment_id:
            db.execute("INSERT INTO items VALUES (?, 2, 1, ?)", (attachment_id, attachment_key))
            db.execute("INSERT INTO itemAttachments VALUES (?, ?, 0, 'application/pdf', ?, 2, NULL, ?)", (attachment_id, item_id, f"storage:{filename}", md5 or None))
    db.execute("INSERT INTO items VALUES (20, 1, 1, 'PARTRASH')")
    db.execute("INSERT INTO items VALUES (21, 2, 1, 'ATTTRASH')")
    db.execute("INSERT INTO itemAttachments VALUES (21, 20, 0, 'application/pdf', 'storage:Trash.pdf', 2, NULL, NULL)")
    db.execute("INSERT INTO deletedItems VALUES (20)")
    db.executescript("""INSERT INTO collections VALUES (1, 'Soot', NULL, 1), (2, 'Empty', NULL, 1);
        INSERT INTO collectionItems VALUES (1, 1), (1, 2);
        INSERT INTO tags VALUES (1, 'soot'), (2, 'once');
        INSERT INTO itemTags VALUES (1, 1), (2, 1), (3, 2);""")
    db.commit()
    db.close()
    return data


def args(tmp_path: Path, data: Path, **extra) -> argparse.Namespace:
    return argparse.Namespace(**{"root": str(tmp_path / "room"), "data": str(data), "list": False, "execute": False, "include_name_only": False, **extra})


def test_status_counts_what_is_here_and_what_was_never_uploaded(library: Path, tmp_path: Path) -> None:
    result = papers.status(args(tmp_path, library))
    assert (result["pdfs"], result["here"], result["missing"], result["missing_never_uploaded"]) == (3, 1, 2, 2), "the trash is left out"


def test_the_database_copy_is_removed_and_the_real_one_untouched(library: Path, tmp_path: Path) -> None:
    before = (library / "zotero.sqlite").read_bytes()
    papers.status(args(tmp_path, library))
    folders = [folder for _, folder in papers.SNAPSHOTS]
    papers.drop_snapshots()
    assert (library / "zotero.sqlite").read_bytes() == before and not any(folder.exists() for folder in folders)


def test_share_then_fetch_moves_a_pdf_to_a_machine_that_lacks_it(library: Path, tmp_path: Path) -> None:
    shared = tmp_path / "iCloud" / "Zotero PDFs"
    assert papers.share(args(tmp_path, library, to=str(shared)))["would share"] == 1 and not shared.exists(), "a dry run copies nothing"
    papers.share(args(tmp_path, library, to=str(shared), execute=True))
    [own] = shared.glob("manifest-*.json")
    manifest = json.loads(own.read_text(encoding="utf-8"))
    assert manifest["ATTHELD1"] == {**manifest["ATTHELD1"], "file": "Held.pdf", "md5": hashlib.md5(HELD).hexdigest()}
    assert (shared / "Held.pdf").read_bytes() == HELD and "Zotero library PDFs" in (shared / "README.md").read_text(encoding="utf-8")
    other = tmp_path / "laptop"
    (other / "storage").mkdir(parents=True)
    (other / "zotero.sqlite").write_bytes((library / "zotero.sqlite").read_bytes())
    result = papers.fetch(args(tmp_path, other, **{"from": str(shared), "execute": True}))
    assert result["copied"] == 1 and (other / "storage" / "ATTHELD1" / "Held.pdf").read_bytes() == HELD
    assert papers.fetch(args(tmp_path, other, **{"from": str(shared), "execute": True})).get("copied") is None, "a second run copies nothing"


def test_a_shared_file_that_does_not_match_its_hash_is_skipped(library: Path, tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    papers.share(args(tmp_path, library, to=str(shared), execute=True))
    (shared / "Held.pdf").write_bytes(b"%PDF tampered")
    other = tmp_path / "laptop"
    (other / "storage").mkdir(parents=True)
    (other / "zotero.sqlite").write_bytes((library / "zotero.sqlite").read_bytes())
    assert papers.fetch(args(tmp_path, other, **{"from": str(shared), "execute": True}))["hash does not match, skipped"] == 1
    assert not (other / "storage" / "ATTHELD1").exists()


def test_each_machine_writes_only_its_own_manifest_and_names_never_collide(tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    shared.mkdir()
    (shared / "manifest-mac.json").write_text(json.dumps({"MACKEY01": {"file": "Paper.pdf", "md5": "x"}}), encoding="utf-8")
    (shared / "Paper.pdf").write_bytes(b"%PDF mac")
    item = papers.Attachment("PCKEY001", "Paper.pdf", "", "P", "A paper", "")
    assert papers.shared_name(item, shared, {"Paper.pdf"}) == "Paper [PCKEY001].pdf"
    assert set(papers.read_manifest(shared)) == {"MACKEY01"}


def test_swap_uses_the_folder_setup_recorded(library: Path, tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    (tmp_path / "room").mkdir()
    (tmp_path / "room" / "reading_room.json").write_text(json.dumps({"papers_folder": str(shared), "machine": "pc"}), encoding="utf-8")
    result = papers.swap(args(tmp_path, library, folder=""))
    assert result["share"]["shared"] == 1 and result["fetch"]["not in the shared folder yet"] == 2
    assert (shared / "manifest-pc.json").exists()
    (tmp_path / "room" / "reading_room.json").write_text("{}", encoding="utf-8")
    with pytest.raises(SystemExit):
        papers.swap(args(tmp_path, library, folder=""))


ARTICLE = papers.Article("K1", "Effective density of soot from a micro turbojet", 2021, "Olfert", "", "")


@pytest.mark.parametrize(("candidate", "matched"), [
    ({"doi": "10.1/a", "title": "Effective Density of Soot from a Micro-Turbojet", "year": 2021, "surnames": ["Olfert"]}, True),
    ({"doi": "10.1/a", "title": "Effective density of soot from a micro turbojet", "year": 2015, "surnames": ["Olfert"]}, False),
    ({"doi": "10.1/a", "title": "Effective density of soot from a micro turbojet", "year": 2021, "surnames": ["Someone"]}, False),
    ({"doi": "10.1/a", "title": "Effective density of soot from a micro turbojet engine", "year": 2021, "surnames": ["Olfert"]}, True),
    ({"doi": "10.1/a", "title": "Effective density of soot from a micro turbojet engine", "year": None, "surnames": []}, False),
    ({"doi": "", "title": "Effective density of soot from a micro turbojet", "year": 2021, "surnames": ["Olfert"]}, False),
])
def test_a_doi_needs_the_same_title_and_no_disagreement_on_year_or_author(candidate: dict, matched: bool) -> None:
    assert bool(papers.same_paper(ARTICLE, candidate)) is matched


@pytest.mark.parametrize(("article", "candidate", "matched"), [
    (papers.Article("K", "Validation of a dynamic simulation approach for transient performance", 2020, "Goeing", "", ""),
     {"doi": "10.1/v", "title": "Validation of a Dynamic Simulation Approach for Transient Performance", "year": 2021, "surnames": ["Göing", "Hogrefe"]}, True),
    (papers.Article("K", "Thermodynamic and mechanical design concept for micro-turbojet to micro-turboshaft", 2020, "Christoph¨ottl", "", ""),
     {"doi": "10.1/t", "title": "Thermodynamic and Mechanical Design Concept for Micro-Turbojet to Micro-Turboshaft", "year": 2021, "surnames": ["Öttl"]}, True),
    (papers.Article("K", "Particulate matter emissions from aircraft", 2022, "Owen", "", ""),
     {"doi": "10.3390/a", "title": "Review: Particulate Matter Emissions from Aircraft", "year": 2022, "surnames": ["Owen", "Anet"]}, True),
    (papers.Article("K", "Predictions of NOx formation under combined droplet and partially premixed reaction", 2002, "Rizk", "", ""),
     {"doi": "10.1115/x", "title": "Predictions of NOx Formation Under Combined Droplet and Partially Premixed Reaction", "year": 1999, "surnames": ["Rizk"]}, True),
    (papers.Article("K", "Predictions of NOx formation under combined droplet and partially premixed reaction", 2004, "Rizk", "", ""),
     {"doi": "10.1115/x", "title": "Predictions of NOx Formation Under Combined Droplet and Partially Premixed Reaction", "year": 1999, "surnames": ["Rizk"]}, False),
    (papers.Article("K", "Soot: A review of computational models at different length scales", 2023, "Li", "", ""),
     {"doi": "10.1007/s", "title": "Soot: A review of computational models at different length scales", "year": 2023, "surnames": ["Li", "Bao"]}, True),
    (papers.Article("K", "Toward accommodating realistic fuel chemistry in large-scale computations", 2009, "Lu", "", ""),
     {"doi": "10.1016/p", "title": "Toward accommodating realistic fuel chemistry in large-scale computations", "year": 2009, "surnames": ["Lu", "Law"]}, True),
    (papers.Article("K", "Toward accommodating realistic fuel chemistry in large-scale computations", 2009, "Lu", "", ""),
     {"doi": "10.1016/p", "title": "Toward accommodating realistic fuel chemistry in large-scale computations", "year": 2009, "surnames": ["Luo", "Law"]}, False),
    (papers.Article("K", "Soot and flow field in turbulent swirl-stabilized spray flames of Jet A-1", 2022, "Weber", "", ""),
     {"doi": "10.1016/y", "title": "Soot and flow field in turbulent swirl-stabilized spray flames of Jet A-1", "year": 2019, "surnames": ["Wang", "Bauer"]}, False),
])
def test_names_match_across_accents_and_garbling_but_another_author_never_does(article, candidate: dict, matched: bool) -> None:
    assert bool(papers.same_paper(article, candidate)) is matched


def test_of_two_versions_the_one_dated_closest_to_the_item_wins(library: Path, tmp_path: Path) -> None:
    db = sqlite3.connect(library / "zotero.sqlite")
    db.execute("INSERT INTO itemDataValues VALUES (95, '2002')")
    db.execute("INSERT INTO itemData VALUES (3, 3, 95)")
    db.commit()
    db.close()
    title = "Another missing paper on effective density measurement"

    def fake(url: str) -> dict:
        if "crossref" in url and "effective" in url.lower():
            return {"message": {"items": [{"DOI": "10.1115/99-GT-1", "title": [title], "issued": {"date-parts": [[1999]]}},
                                          {"DOI": "10.1115/1.journal", "title": [title], "issued": {"date-parts": [[2001]]}}]}}
        return {"message": {"items": []}, "results": [], "data": []}

    rows = {row["key"]: row for row in csv.DictReader(open(papers.dois(args(tmp_path, library), fetch=fake, pause=0)["csv"], encoding="utf-8-sig"))}
    assert rows["PARMISS2"]["doi"] == "10.1115/1.journal"

    def tie(url: str) -> dict:  # both dated the same year, as Crossref dates Rizk's two versions
        if "crossref" in url and "effective" in url.lower():
            return {"message": {"items": [{"DOI": "10.1115/99-GT-1", "title": [title], "issued": {"date-parts": [[2001]]}, "type": "proceedings-article"},
                                          {"DOI": "10.1115/1.journal", "title": [title], "issued": {"date-parts": [[2001]]}, "type": "journal-article"}]}}
        return {"message": {"items": []}, "results": [], "data": []}

    rows = {row["key"]: row for row in csv.DictReader(open(papers.dois(args(tmp_path, library), fetch=tie, pause=0)["csv"], encoding="utf-8-sig"))}
    assert rows["PARMISS2"]["doi"] == "10.1115/1.journal", "on a tie the journal article wins"


def test_a_search_that_fails_holds_the_item_and_never_trashes_it(library: Path, tmp_path: Path) -> None:
    def refuse(url: str) -> dict:
        raise RuntimeError("HTTP Error 429: Too Many Requests")

    rows = {row["key"]: row for row in csv.DictReader(open(papers.dois(args(tmp_path, library), fetch=refuse, pause=0)["csv"], encoding="utf-8-sig"))}
    assert {row["action"] for row in rows.values()} == {"hold"}
    assert "lookup incomplete" in rows["PARDUPE1"]["why"]


def test_dois_sets_what_it_finds_and_trashes_only_what_holds_nothing(library: Path, tmp_path: Path) -> None:
    db = sqlite3.connect(library / "zotero.sqlite")
    db.execute("INSERT INTO items VALUES (30, 1, 1, 'PARPDF01')")
    db.execute("INSERT INTO itemDataValues VALUES (90, 'A paper with a PDF but no DOI anywhere at all')")
    db.execute("INSERT INTO itemData VALUES (30, 1, 90)")
    db.execute("INSERT INTO items VALUES (31, 2, 1, 'ATTPDF01')")
    db.execute("INSERT INTO itemAttachments VALUES (31, 30, 0, 'application/pdf', 'storage:x.pdf', 2, NULL, NULL)")
    db.commit()
    db.close()

    def fake(url: str) -> dict:
        if "crossref" in url and "effective" in url.lower():
            return {"message": {"items": [{"DOI": "10.5555/Another", "title": ["Another missing paper on effective density measurement"], "issued": {"date-parts": [[2020]]}}]}}
        return {"message": {"items": []}, "results": [], "data": []}

    result = papers.dois(args(tmp_path, library), fetch=fake, pause=0)
    rows = {row["key"]: row for row in csv.DictReader(open(result["csv"], encoding="utf-8-sig"))}
    assert rows["PARMISS2"]["action"] == "set doi" and rows["PARMISS2"]["doi"] == "10.5555/another"
    assert rows["PARDUPE1"]["action"] == "trash", "nothing found and it holds nothing"
    assert rows["PARPDF01"]["action"] == "hold" and rows["PARPDF01"]["holds"] == "PDF"
    assert "PARHELD1" not in rows, "an item with a DOI is not looked up"


def test_a_manifest_cannot_point_outside_the_folder(library: Path, tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    shared.mkdir()
    secret = tmp_path / "elsewhere.pdf"
    secret.write_bytes(HELD)
    (shared / "manifest-x.json").write_text(json.dumps({"ATTMISS1": {"file": "../elsewhere.pdf", "md5": hashlib.md5(HELD).hexdigest()}}), encoding="utf-8")
    assert papers.fetch(args(tmp_path, library, **{"from": str(shared), "execute": True}))["outside the shared folder, skipped"] == 1


def test_find_places_only_copies_the_pdf_itself_confirms(library: Path, tmp_path: Path) -> None:
    loose = tmp_path / "Downloads"
    loose.mkdir()
    (loose / "Missing paper about mobility diameter of aggregates.pdf").write_bytes(pdf_with(b"doi:10.1000/miss"))
    (loose / "Another missing paper on effective density measurement (copy).pdf").write_bytes(pdf_with(b"an unrelated paper"))
    dry = papers.find(args(tmp_path, library, into=[str(loose)]))
    assert dry["would copy (checked: doi)"] == 1 and dry["copy found, not confirmed"] == 1
    assert not (library / "storage" / "ATTMISS1").exists()
    papers.find(args(tmp_path, library, into=[str(loose)], execute=True))
    assert (library / "storage" / "ATTMISS1" / "Missing.pdf").exists() and not (library / "storage" / "ATTMISS2").exists()
    assert (loose / "Missing paper about mobility diameter of aggregates.pdf").exists(), "the source stays where it was"
    log = (tmp_path / "room" / "papers" / "placed.jsonl").read_text(encoding="utf-8")
    assert "ATTMISS1" in log and "doi inside" in log


def test_the_title_inside_the_pdf_also_confirms_it(library: Path, tmp_path: Path) -> None:
    item = papers.Attachment("K", "x.pdf", "", "P", "Another missing paper on effective density measurement", "")
    path = tmp_path / "a.pdf"
    path.write_bytes(pdf_with(b"Another Missing Paper on Effective Density Measurement, by someone"))
    assert papers.check(path, item) == "title"
    path.write_bytes(b"not a pdf at all")
    assert papers.check(path, item) == "not a PDF"


def test_an_existing_file_is_never_replaced(library: Path, tmp_path: Path) -> None:
    source = tmp_path / "other.pdf"
    source.write_bytes(b"%PDF other")
    target = library / "storage" / "ATTHELD1" / "Held.pdf"
    assert papers.place(source, target, tmp_path, "test", True) == "already there"
    assert target.read_bytes() == HELD


def test_duplicate_groups_that_share_a_paper_are_listed_once() -> None:
    assert papers.merge_groups([[1, 2], [3, 4], [2, 5], [6, 7]]) == [(1, 2, 5), (3, 4), (6, 7)]


def test_tidy_reports_collections_duplicates_and_tags_and_changes_nothing(library: Path, tmp_path: Path) -> None:
    before = (library / "zotero.sqlite").read_bytes()
    result = papers.tidy(args(tmp_path, library))
    report = Path(result["report"]).read_text(encoding="utf-8")
    assert result["duplicate_groups"] == 1 and result["empty_collections"] == ["Empty"] and result["tags_used_once"] == 1
    assert "| Soot | 2 |" in report and "zotero://select/library/items/PARDUPE1" in report
    assert (library / "zotero.sqlite").read_bytes() == before
