#!/usr/bin/env python3
"""Your PDFs on every machine, and a report on how the library is organised.

Zotero syncs items between machines, but a PDF reaches another machine only through Zotero's file storage. When that
fills up (the free plan holds 300 MB), each laptop keeps the PDFs it added, and the others see the item with no file.
This moves the files themselves, through any folder that all your machines sync (iCloud Drive, OneDrive, Google Drive).

    python3 papers.py status                         what this machine has and lacks
    python3 papers.py share --to FOLDER              copy this machine's PDFs into the shared folder (dry run)
    python3 papers.py fetch --from FOLDER            copy the PDFs this machine lacks out of it (dry run)
    python3 papers.py swap                           share, then fetch, for real, through the folder setup recorded
    python3 papers.py find --in DIR [--in DIR ...]   look for loose copies of missing PDFs and check each one (dry run)
    python3 papers.py tidy                           write a report on how the library is organised
    python3 papers.py dois                           look up DOIs for journal articles with none, and write a CSV
                                                     that Reading Room Tools can apply (Tools, Apply Item Changes)

Add --execute to share, fetch or find to copy for real. Nothing here writes to zotero.sqlite. A PDF goes only into
<Zotero data>/storage/<attachment key>/ under the name Zotero expects, and only where no file is there yet. Sources
are never changed, and every copy is logged in <root>/papers/placed.jsonl. Needs only the standard library.
"""
from __future__ import annotations

import argparse
import atexit
import collections
import csv
import difflib
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

CONFIG_NAME = "reading_room.json"
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "site-packages", "processor0", "postProcessing", ".Trash"}
MAX_CHECK_BYTES = 80_000_000


@dataclass
class Attachment:
    key: str
    filename: str
    md5: str
    parent: str
    title: str
    doi: str

    def path(self, storage: Path) -> Path:
        return storage / self.key / self.filename


def plain(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(text).lower())


def md5_of(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


SNAPSHOTS: list[tuple[sqlite3.Connection, Path]] = []


def snapshot(database: Path) -> sqlite3.Connection:
    """A private copy of the library database, with its write-ahead log, so a running Zotero is never touched and
    recent changes are still seen. The copy is deleted on exit."""
    if not database.exists():
        raise SystemExit(f"no Zotero database at {database}; pass --data with the Zotero data folder")
    folder = Path(tempfile.mkdtemp(prefix="rr-papers-"))
    for suffix in ("", "-wal"):
        source = Path(f"{database}{suffix}")
        if source.exists():
            shutil.copy2(source, folder / f"zotero.sqlite{suffix}")
    connection = sqlite3.connect(folder / "zotero.sqlite")
    SNAPSHOTS.append((connection, folder))
    return connection


@atexit.register
def drop_snapshots() -> None:
    for connection, folder in SNAPSHOTS:
        connection.close()
        shutil.rmtree(folder, ignore_errors=True)
    SNAPSHOTS.clear()


def field_value(db: sqlite3.Connection, item_id: int, name: str) -> str:
    row = db.execute("""SELECT v.value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID
        JOIN fields f ON f.fieldID = d.fieldID WHERE d.itemID = ? AND f.fieldName = ?""", (item_id, name)).fetchone()
    return str(row[0]) if row else ""


def attachments(db: sqlite3.Connection) -> list[Attachment]:
    """Every stored PDF in the library and the item it belongs to, leaving out the trash."""
    deleted = {row[0] for row in db.execute("SELECT itemID FROM deletedItems")}
    rows = db.execute("""SELECT i.itemID, i.key, a.path, a.storageHash, a.parentItemID, p.key FROM itemAttachments a
        JOIN items i ON i.itemID = a.itemID LEFT JOIN items p ON p.itemID = a.parentItemID
        WHERE a.contentType = 'application/pdf' AND a.path LIKE 'storage:%'""").fetchall()
    found = []
    for item_id, key, path, md5, parent_id, parent_key in rows:
        if item_id in deleted or parent_id in deleted:
            continue
        owner = parent_id or item_id
        found.append(Attachment(key, path[len("storage:"):], str(md5 or ""), str(parent_key or ""), field_value(db, owner, "title"),
                                field_value(db, owner, "DOI").strip().lower()))
    return found


def load_config(root: Path) -> dict[str, Any]:
    file = root / CONFIG_NAME
    return json.loads(file.read_text(encoding="utf-8")) if file.exists() else {}


def data_folder(args: argparse.Namespace) -> Path:
    if args.data:
        return Path(args.data).expanduser()
    configured = load_config(Path(args.root).expanduser()).get("zotero_data")
    return Path(configured) if configured else Path.home() / "Zotero"


def machine_name(args: argparse.Namespace) -> str:
    return str(load_config(Path(args.root).expanduser()).get("machine") or socket.gethostname().split(".")[0].lower())


def log_copy(root: Path, row: dict[str, Any]) -> None:
    folder = root / "papers"
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "placed.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **row}, ensure_ascii=False) + "\n")


def place(source: Path, target: Path, root: Path, why: str, execute: bool) -> str:
    """Copy one PDF into Zotero's storage. Never over an existing file, never moving or changing the source."""
    if target.exists():
        return "already there"
    if not execute:
        return "would copy"
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".rr-partial")
    shutil.copy2(source, partial)
    os.replace(partial, target)
    log_copy(root, {"source": str(source), "target": str(target), "why": why})
    return "copied"


# ---- status ----

def status(args: argparse.Namespace) -> dict[str, Any]:
    data = data_folder(args)
    db = snapshot(data / "zotero.sqlite")
    items = attachments(db)
    storage = data / "storage"
    present = [item for item in items if item.path(storage).exists()]
    missing = [item for item in items if not item.path(storage).exists()]
    result = {
        "machine": machine_name(args), "data_folder": str(data), "pdfs": len(items), "here": len(present), "missing": len(missing),
        "missing_on_zotero_server": sum(1 for item in missing if item.md5),
        "missing_never_uploaded": sum(1 for item in missing if not item.md5),
        "here_megabytes": round(sum(item.path(storage).stat().st_size for item in present) / 1e6, 1),
    }
    if args.list:
        result["missing_list"] = [{"key": item.key, "title": item.title, "doi": item.doi, "file": item.filename} for item in missing]
    return result


# ---- the shared folder ----

FOLDER_README = """# Zotero library PDFs

The PDFs in a Zotero library, kept here so each of its owner's machines can fill in the ones it lacks. Each file has the
name Zotero gave it. The `manifest-<machine>.json` files say which Zotero item each file belongs to, with its MD5.

`papers.py` from Reading Room for Zotero copies files in and out of this folder. It only adds files
and never deletes or changes one here. Please don't rename or edit these files: a changed file no longer matches its
MD5 and is skipped. Read them freely.
"""


def read_manifest(folder: Path) -> dict[str, Any]:
    """Every machine writes only its own manifest-<machine>.json, so two machines never edit one file at once."""
    merged: dict[str, Any] = {}
    for file in sorted(folder.glob("manifest*.json")):
        try:
            entries = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for key, entry in entries.items():
            merged.setdefault(key, entry)
    return merged


def shared_name(item: Attachment, folder: Path, taken: set[str]) -> str:
    """Zotero's own file name, so people can browse the folder, and the key added only when that name is taken."""
    if item.filename not in taken and not (folder / item.filename).exists():
        return item.filename
    stem, dot, suffix = item.filename.rpartition(".")
    return f"{stem} [{item.key}].{suffix}" if dot else f"{item.filename} [{item.key}]"


def share(args: argparse.Namespace) -> dict[str, Any]:
    """Each PDF this machine has goes into the folder, listed with its MD5 in this machine's manifest."""
    data, folder, root = data_folder(args), Path(args.to).expanduser(), Path(args.root).expanduser()
    db = snapshot(data / "zotero.sqlite")
    known = read_manifest(folder)
    own_file = folder / f"manifest-{machine_name(args)}.json"
    own = json.loads(own_file.read_text(encoding="utf-8")) if own_file.exists() else {}
    taken = {str(entry.get("file")) for entry in known.values()}
    counts: collections.Counter[str] = collections.Counter()
    for item in attachments(db):
        source = item.path(data / "storage")
        if not source.exists():
            continue
        digest = md5_of(source)
        entry = known.get(item.key)
        if entry and entry.get("md5") == digest:
            counts["already shared"] += 1
            continue
        if entry:
            counts["shared copy differs, left alone"] += 1
            continue
        counts["would share" if not args.execute else "shared"] += 1
        if args.execute:
            folder.mkdir(parents=True, exist_ok=True)
            name = shared_name(item, folder, taken)
            partial = folder / (name + ".rr-partial")
            shutil.copy2(source, partial)
            os.replace(partial, folder / name)
            taken.add(name)
            known[item.key] = own[item.key] = {"file": name, "md5": digest, "bytes": source.stat().st_size, "title": item.title,
                                               "doi": item.doi, "from": machine_name(args), "at": time.strftime("%Y-%m-%d")}
    if args.execute:
        folder.mkdir(parents=True, exist_ok=True)
        own_file.write_text(json.dumps(own, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        if not (folder / "README.md").exists():
            (folder / "README.md").write_text(FOLDER_README, encoding="utf-8")
        log_copy(root, {"shared_to": str(folder), **counts})
    return {"folder": str(folder), **counts}


def fetch(args: argparse.Namespace) -> dict[str, Any]:
    """Each PDF this machine lacks, out of the shared folder, when its MD5 matches the manifest and Zotero's own hash."""
    data, folder, root = data_folder(args), Path(getattr(args, "from")).expanduser(), Path(args.root).expanduser()
    db = snapshot(data / "zotero.sqlite")
    manifest = read_manifest(folder)
    counts: collections.Counter[str] = collections.Counter()
    for item in attachments(db):
        target = item.path(data / "storage")
        entry = manifest.get(item.key)
        if target.exists():
            continue
        if not entry:
            counts["not in the shared folder yet"] += 1
            continue
        source = folder / str(entry["file"])
        if folder.resolve() not in source.resolve().parents:
            counts["outside the shared folder, skipped"] += 1
            continue
        if not source.exists():
            counts["listed but not synced down yet"] += 1
            continue
        digest = md5_of(source)
        if digest != entry.get("md5") or (item.md5 and digest != item.md5):
            counts["hash does not match, skipped"] += 1
            continue
        counts[place(source, target, root, "shared folder", args.execute)] += 1
    return {"folder": str(folder), **counts}


def swap(args: argparse.Namespace) -> dict[str, Any]:
    """share, then fetch, through the folder setup recorded. What a timer runs."""
    folder = args.folder or load_config(Path(args.root).expanduser()).get("papers_folder")
    if not folder:
        raise SystemExit("no shared folder: run reading_room.py setup --papers-folder FOLDER, or pass --folder")
    base = {"root": args.root, "data": args.data, "execute": True}
    return {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "share": share(argparse.Namespace(**base, to=folder)),
            "fetch": fetch(argparse.Namespace(**{**base, "from": folder}))}


# ---- loose copies on this machine ----

def inflated(data: bytes) -> Iterable[bytes]:
    """The raw file, then each Flate stream decompressed: enough to find a DOI or title that a PDF stores as text."""
    yield data
    for match in re.finditer(rb"stream\r?\n", data):
        start = match.end()
        end = data.find(b"endstream", start)
        if end < 0:
            break
        try:
            yield zlib.decompress(data[start:end])
        except zlib.error:
            continue


def check(path: Path, item: Attachment) -> str:
    """Is this PDF the paper? 'doi' or 'title' when the file itself says so, else 'name only'."""
    try:
        if path.stat().st_size > MAX_CHECK_BYTES:
            return "name only"
        data = path.read_bytes()
    except OSError:
        return "unreadable"
    if not data.startswith(b"%PDF"):
        return "not a PDF"
    doi = item.doi.encode("ascii", "ignore")
    title = plain(item.title)[:40].encode()
    for chunk in inflated(data):
        lower = chunk.lower()
        if doi and doi in lower:
            return "doi"
        if len(title) >= 24 and title in re.sub(rb"[^a-z0-9]+", b"", lower):
            return "title"
    return "name only"


def index_pdfs(folders: list[Path]) -> tuple[dict[str, Path], list[tuple[str, Path]]]:
    by_name: dict[str, Path] = {}
    by_stem: list[tuple[str, Path]] = []
    for root in folders:
        for folder, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                if name.lower().endswith(".pdf"):
                    path = Path(folder) / name
                    by_name.setdefault(name.lower(), path)
                    by_stem.append((plain(path.stem), path))
    return by_name, by_stem


def candidates(item: Attachment, by_name: dict[str, Path], by_stem: list[tuple[str, Path]]) -> list[Path]:
    """The same file name first, then files whose name holds the start of the title."""
    found = [by_name[item.filename.lower()]] if item.filename.lower() in by_name else []
    title = plain(item.title)
    if len(title) >= 24:
        found += [path for stem, path in by_stem if len(stem) >= 24 and (title[:40] in stem or (len(stem) >= 30 and stem[:40] in title)) and path not in found]
    return found[:6]


def find(args: argparse.Namespace) -> dict[str, Any]:
    data, root = data_folder(args), Path(args.root).expanduser()
    db = snapshot(data / "zotero.sqlite")
    missing = [item for item in attachments(db) if not item.path(data / "storage").exists()]
    by_name, by_stem = index_pdfs([Path(folder).expanduser() for folder in args.into])
    plan, counts = [], collections.Counter()
    for item in missing:
        verdicts = [(path, check(path, item)) for path in candidates(item, by_name, by_stem)]
        best = next((pair for pair in verdicts if pair[1] in ("doi", "title")), None)
        if best is None and verdicts and args.include_name_only:
            best = next((pair for pair in verdicts if pair[1] == "name only"), None)
        if not verdicts:
            counts["no copy found"] += 1
            continue
        if best is None:
            counts["copy found, not confirmed"] += 1
            plan.append({"key": item.key, "title": item.title, "candidates": [[str(path), verdict] for path, verdict in verdicts], "action": "left alone"})
            continue
        path, verdict = best
        action = place(path, item.path(data / "storage"), root, f"loose copy, {verdict} inside", args.execute)
        counts[f"{action} ({'checked: ' + verdict if verdict != 'name only' else 'name only'})"] += 1
        plan.append({"key": item.key, "title": item.title, "source": str(path), "checked": verdict, "action": action})
    out = root / "papers" / "find-plan.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"missing": len(missing), **counts, "plan": str(out)}


# ---- organisation ----

def merge_groups(groups: Iterable[list[int]]) -> list[tuple[int, ...]]:
    """Groups that share an item become one group, so a paper found by DOI and by title is listed once."""
    merged: list[set[int]] = []
    for group in groups:
        joined = set(group)
        for other in [other for other in merged if other & joined]:
            joined |= other
            merged.remove(other)
        merged.append(joined)
    return sorted(tuple(sorted(group)) for group in merged)

def tidy(args: argparse.Namespace) -> dict[str, Any]:
    """A Markdown report on collections, duplicates, gaps and tags. It proposes and changes nothing."""
    data, root = data_folder(args), Path(args.root).expanduser()
    db = snapshot(data / "zotero.sqlite")
    deleted = {row[0] for row in db.execute("SELECT itemID FROM deletedItems")}
    regular = {item_id: key for item_id, key in db.execute("""SELECT i.itemID, i.key FROM items i JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
        WHERE t.typeName NOT IN ('attachment', 'note', 'annotation')""") if item_id not in deleted}
    titles = {item_id: field_value(db, item_id, "title") for item_id in regular}
    dois = {item_id: field_value(db, item_id, "DOI").strip().lower() for item_id in regular}
    collections_rows = db.execute("SELECT collectionID, collectionName, parentCollectionID FROM collections").fetchall()
    names = {cid: name for cid, name, _ in collections_rows}
    parents = {cid: parent for cid, _, parent in collections_rows}
    members = collections.defaultdict(set)
    for cid, item_id in db.execute("SELECT collectionID, itemID FROM collectionItems"):
        if item_id in regular:
            members[cid].add(item_id)

    def path(cid: int) -> str:
        parts = []
        while cid:
            parts.append(names[cid])
            cid = parents.get(cid)
        return " / ".join(reversed(parts))

    storage = data / "storage"
    pdfs = collections.defaultdict(list)
    for item in attachments(db):
        pdfs[item.parent].append(item.path(storage).exists())
    link = lambda item_id: f"[{titles[item_id][:90] or regular[item_id]}](zotero://select/library/items/{regular[item_id]})"
    groups = collections.defaultdict(list)
    for item_id in regular:
        if dois[item_id]:
            groups[f"doi:{dois[item_id]}"].append(item_id)
        if len(plain(titles[item_id])) >= 24:
            groups[f"title:{plain(titles[item_id])}"].append(item_id)
    duplicates = merge_groups(group for group in groups.values() if len(group) > 1)
    tag_counts = collections.Counter(name for (name,) in db.execute("SELECT t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID"))
    filed = set().union(*members.values()) if members else set()
    no_file = [item_id for item_id in regular if not any(pdfs.get(regular[item_id], []))]
    lines = [f"# How the library is organised ({machine_name(args)}, {time.strftime('%Y-%m-%d')})", "",
             f"{len(regular)} items, {len(names)} collections, {len(tag_counts)} tags. Nothing here was changed.", "",
             "## Collections", "", "| Collection | Items |", "|---|---|"]
    lines += [f"| {path(cid)} | {len(members[cid])} |" for cid in sorted(names, key=path)]
    empty = [path(cid) for cid in names if not members[cid] and not any(parents.get(other) == cid for other in names)]
    lines += ["", f"Not in any collection: {len(set(regular) - filed)}. Empty collections with no subcollections: {', '.join(empty) or 'none'}."]
    lines += ["", f"## Possible duplicates ({len(duplicates)})", "", "Same DOI or same long title. Zotero's Duplicate Items view can merge them, keeping notes and annotations.", ""]
    for group in sorted(duplicates):
        lines.append("- " + " and ".join(link(item_id) for item_id in group))
    lines += ["", "## Files", "",
              f"- Items with a PDF on this machine: {sum(1 for item_id in regular if any(pdfs.get(regular[item_id], [])))}",
              f"- Items whose PDF is on another machine only: {sum(1 for item_id in regular if pdfs.get(regular[item_id]) and not any(pdfs[regular[item_id]]))}",
              f"- Items with no PDF anywhere: {sum(1 for item_id in regular if not pdfs.get(regular[item_id]))}",
              f"- Items with no DOI: {sum(1 for item_id in regular if not dois[item_id])}", "",
              "## Tags", "", f"{len(tag_counts)} tags, {sum(1 for count in tag_counts.values() if count == 1)} used once.", "",
              "| Tag | Items |", "|---|---|", *[f"| {name} | {count} |" for name, count in tag_counts.most_common(25)]]
    out = root / "papers" / "library-report.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"report": str(out), "items": len(regular), "collections": len(names), "empty_collections": empty, "duplicate_groups": len(duplicates),
            "tags": len(tag_counts), "tags_used_once": sum(1 for count in tag_counts.values() if count == 1), "no_pdf_here": len(no_file)}


# ---- DOIs ----

DOI_PATTERN = re.compile(r"10\.\d{4,9}/[^\s\"'<>]+", re.I)


class OutForNow(RuntimeError):
    """A service that asks to wait more than a minute, such as OpenAlex once its free daily allowance is spent."""
USER_AGENT = "reading-room-for-zotero/0.2 (papers.py dois)"


@dataclass
class Article:
    key: str
    title: str
    year: int | None
    surname: str
    hidden_doi: str
    holds: str  # what the item carries that a person made or added: a PDF, notes, annotations


def articles_without_doi(db: sqlite3.Connection) -> list[Article]:
    """Journal articles outside the trash with an empty DOI field."""
    deleted = {row[0] for row in db.execute("SELECT itemID FROM deletedItems")}
    pdfs = {row[0] for row in db.execute("SELECT parentItemID FROM itemAttachments WHERE contentType = 'application/pdf'")}
    notes = {row[0] for row in db.execute("SELECT parentItemID FROM itemNotes WHERE parentItemID IS NOT NULL")}
    marked = {row[0] for row in db.execute("SELECT a.parentItemID FROM itemAnnotations n JOIN itemAttachments a ON a.itemID = n.parentItemID")}
    found = []
    for item_id, key in db.execute("""SELECT i.itemID, i.key FROM items i JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
            WHERE t.typeName = 'journalArticle'""").fetchall():
        if item_id in deleted or field_value(db, item_id, "DOI").strip():
            continue
        year = re.search(r"\b(1[89]\d\d|20\d\d)\b", field_value(db, item_id, "date"))
        first = db.execute("""SELECT c.lastName FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
            WHERE ic.itemID = ? ORDER BY ic.orderIndex LIMIT 1""", (item_id,)).fetchone()
        hidden = DOI_PATTERN.search(field_value(db, item_id, "extra") + " " + field_value(db, item_id, "url"))
        holds = [name for name, ids in (("PDF", pdfs), ("notes", notes), ("annotations", marked)) if item_id in ids]
        found.append(Article(key, field_value(db, item_id, "title"), int(year.group(1)) if year else None, str(first[0] if first else "").strip(),
                             hidden.group(0).rstrip(".,;)") if hidden else "", ", ".join(holds)))
    return found


def get_json(url: str, tries: int = 4) -> Any:
    """A busy service answers 429, and an overloaded one 502, 503 or 504. Wait and ask again, and let the caller hear
    about a refusal that lasts."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=30) as reply:
                return json.loads(reply.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            busy = error.code in (429, 502, 503, 504)
            wait = int(error.headers.get("Retry-After") or 0) if busy and str(error.headers.get("Retry-After") or "").isdigit() else 0
            if busy and wait > 60:  # a daily allowance that is spent will not come back soon
                raise OutForNow(f"{urllib.parse.urlparse(url).netloc} asks to wait {wait} s") from error
            if not busy or attempt == tries - 1:
                raise
            time.sleep(max(wait, 4 * (attempt + 1)))
    raise RuntimeError("unreachable")


def fold(name: str) -> str:
    """A surname as letters only, with accents dropped and ae, oe, ue read as a, o, u, so Göing and Goeing agree."""
    text = unicodedata.normalize("NFKD", str(name))
    text = plain("".join(c for c in text if not unicodedata.combining(c)))
    return text.replace("ae", "a").replace("oe", "o").replace("ue", "u")


def crossref(article: Article, fetch=get_json) -> list[dict[str, Any]]:
    """Two searches: title with first author, then title alone, since Crossref's ranking can bury the paper in either."""
    records, seen = [], set()
    for words in ({"query.bibliographic": f"{article.title} {article.surname}".strip(), "rows": 5}, {"query.title": article.title, "rows": 10}):
        reply = fetch(f"https://api.crossref.org/works?{urllib.parse.urlencode({**words, 'select': 'DOI,title,issued,author,type'})}")
        for record in (reply.get("message") or {}).get("items") or []:
            if record.get("DOI") not in seen:
                seen.add(record.get("DOI"))
                records.append(record)
        time.sleep(1.1)  # one request a second
    found = []
    for record in records:
        year = ((record.get("issued") or {}).get("date-parts") or [[None]])[0][0]
        found.append({"doi": record.get("DOI", ""), "title": " ".join(record.get("title") or []), "year": year, "type": record.get("type", ""),
                      "surnames": [a.get("family", "") for a in record.get("author") or []], "source": "Crossref"})
    return found


def openalex(article: Article, fetch=get_json) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"search": article.title, "per-page": 5, "select": "doi,display_name,publication_year,authorships"})
    reply = fetch(f"https://api.openalex.org/works?{query}")
    return [{"doi": str(record.get("doi") or "").replace("https://doi.org/", ""), "title": record.get("display_name") or "", "year": record.get("publication_year"),
             "surnames": [str((a.get("author") or {}).get("display_name") or "").split()[-1:][0] if (a.get("author") or {}).get("display_name") else "" for a in record.get("authorships") or []],
             "source": "OpenAlex"} for record in reply.get("results") or [] if record.get("doi")]


def datacite(article: Article, fetch=get_json) -> list[dict[str, Any]]:
    """DataCite holds DOIs that Crossref does not, such as many university theses."""
    words = re.sub(r"[^\w\s-]", " ", article.title)
    query = urllib.parse.urlencode({"query": f'titles.title:"{words.strip()}"', "page[size]": 5})
    reply = fetch(f"https://api.datacite.org/dois?{query}")
    found = []
    for record in reply.get("data") or []:
        attributes = record.get("attributes") or {}
        found.append({"doi": attributes.get("doi", ""), "title": " ".join(t.get("title", "") for t in (attributes.get("titles") or [])[:1]),
                      "year": attributes.get("publicationYear"), "surnames": [c.get("familyName", "") for c in attributes.get("creators") or []], "source": "DataCite"})
    return found


def same_paper(article: Article, candidate: dict[str, Any]) -> str:
    """Why a candidate is this paper, or "" when it is not.

    - The same title (letters and digits only) and the same first author: accepted when the years are at most 3 apart,
      because a conference version and its journal version are often dated differently.
    - The same title, and no author on the item to compare: accepted when the years are at most 2 apart.
    - A nearly equal title (93 percent alike, or one title inside the other, such as "Review: ..."): accepted only with
      the same first author and years at most 1 apart.
    Anything else is refused, and a candidate whose authors do not include the item's first author always is."""
    mine, theirs = plain(article.title), plain(candidate.get("title", ""))
    if len(mine) < 20 or not theirs or not candidate.get("doi"):
        return ""
    year = candidate.get("year")
    gap = abs(int(year) - article.year) if article.year and year else None
    names = [fold(name) for name in candidate.get("surnames") or [] if fold(name)]
    me = fold(article.surname)
    # Short surnames such as Li or Lu must match exactly; longer ones may sit inside a garbled one ("Christoph¨ottl").
    author = bool(me and names and any(me == name or (len(me) >= 3 and len(name) >= 3 and (me in name or name in me)) for name in names[:3]))
    if me and names and not author:
        return ""
    if mine == theirs:
        if author and (gap is None or gap <= 3):
            return "same title, same first author" + (f", years {gap} apart" if gap else "")
        if not me and (gap is None or gap <= 2):
            return "same title" + (f", years {gap} apart" if gap else "")
        return ""
    shorter = min(len(mine), len(theirs))
    inside = shorter >= 30 and (mine in theirs or theirs in mine)
    close = difflib.SequenceMatcher(None, mine, theirs).ratio()
    if (close >= 0.93 or inside) and author and gap is not None and gap <= 1:
        return ("one title inside the other" if inside else f"title {close:.0%} alike") + ", same first author and year"
    return ""


def dois(args: argparse.Namespace, fetch=get_json, pause: float = 1.1) -> dict[str, Any]:
    """For each journal article with no DOI: a DOI already in its link, or one found by title. What has none goes to
    the trash, unless it holds a PDF, notes or annotations, which are held for a person to decide."""
    data, root = data_folder(args), Path(args.root).expanduser()
    db = snapshot(data / "zotero.sqlite")
    rows = []
    down: dict[str, str] = {}  # a service that refused for the day is not asked again in this run
    for article in articles_without_doi(db):
        doi, source, why = "", "", ""
        failed = []
        if article.hidden_doi:
            doi, source, why = article.hidden_doi, "the item's own link", "in the item's URL or Extra field"
        else:
            for search in (crossref, openalex, datacite):
                if search.__name__ in down:
                    failed.append(f"{search.__name__}: {down[search.__name__]}")
                    continue
                try:
                    candidates = search(article, fetch)
                except Exception as error:  # one service down must not stop the others
                    candidates = []
                    failed.append(f"{search.__name__}: {error}")
                    if isinstance(error, OutForNow):  # a brief refusal is retried; only a long one skips the service
                        down[search.__name__] = str(error)
                hits = [(c, reason) for c in candidates if (reason := same_paper(article, c))]
                # A conference paper and its journal version can both pass. Take the one dated closest to the item, and on
                # a tie the journal article, since these items are journal articles.
                def closeness(pair: tuple[dict[str, Any], str]) -> tuple[int, int]:
                    candidate = pair[0]
                    gap = abs(int(candidate["year"]) - article.year) if article.year and candidate.get("year") else 99
                    return gap, 0 if candidate.get("type") in ("", None, "journal-article") else 1
                hit = min(hits, key=closeness, default=None)
                if hit:
                    doi, source, why = hit[0]["doi"].lower(), hit[0]["source"], hit[1]
                    break
                time.sleep(pause)  # Crossref's public pool allows one request a second
        if doi:
            action = "set doi"
        elif failed:  # a search that did not answer is not a search that found nothing
            action, why = "hold", "lookup incomplete, run again later: " + "; ".join(failed)
        elif article.holds:
            action, why = "hold", f"no match in Crossref, OpenAlex or DataCite, but it holds your {article.holds}"
        else:
            action, why = "trash", "no match in Crossref, OpenAlex or DataCite"
        rows.append({"key": article.key, "title": article.title, "year": article.year or "", "first author": article.surname, "doi": doi,
                     "found in": source, "why": why, "holds": article.holds, "action": action})
    out = root / "papers" / "doi-lookup.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["key", "title", "year", "first author", "doi", "found in", "why", "holds", "action"])
        writer.writeheader()
        writer.writerows(rows)
    counts = collections.Counter(row["action"] for row in rows)
    return {"articles": len(rows), **counts, "found_in": collections.Counter(row["found in"] for row in rows if row["doi"]), "csv": str(out)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=str(Path.home() / "ReadingRoom"))
    parser.add_argument("--data", default="", help="The Zotero data folder, if setup did not record it")
    commands = parser.add_subparsers(dest="command", required=True)
    show = commands.add_parser("status")
    show.add_argument("--list", action="store_true", help="Also list each missing PDF")
    give = commands.add_parser("share")
    give.add_argument("--to", required=True, help="A folder every machine syncs, such as iCloud Drive/Zotero PDFs")
    give.add_argument("--execute", action="store_true")
    take = commands.add_parser("fetch")
    take.add_argument("--from", required=True, help="The same shared folder")
    take.add_argument("--execute", action="store_true")
    both = commands.add_parser("swap", help="share, then fetch, for real, through the folder setup recorded")
    both.add_argument("--folder", default="", help="The shared folder, if setup did not record one")
    look = commands.add_parser("find")
    look.add_argument("--in", dest="into", action="append", required=True, help="A folder to search; repeat for more")
    look.add_argument("--include-name-only", action="store_true", help="Also place copies matched by name that the PDF does not confirm")
    look.add_argument("--execute", action="store_true")
    commands.add_parser("tidy")
    commands.add_parser("dois", help="look up DOIs for journal articles with none; writes <root>/papers/doi-lookup.csv")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    result = {"status": status, "share": share, "fetch": fetch, "swap": swap, "find": find, "tidy": tidy, "dois": dois}[args.command](args)
    print(json.dumps(result, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
