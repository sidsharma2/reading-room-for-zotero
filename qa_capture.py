"""Save Claude Code and Codex reading sessions as verbatim Q&A records in the wiki.

Reading Room plan, section 11. A chat beside a paper runs in a known folder, and the agent CLI
writes every turn to its own transcript with no click. This script turns those transcripts into
linked records:

    wiki/annotations/<citekey>/<date>-<time>-q-<id>.md   the question, the human's words
    wiki/annotations/<citekey>/<date>-<time>-a-<id>.md   the answer, a separate linked record

It is deterministic: no model runs here, and transcript text is only ever treated as data.

Rules that must hold, because these records can be submitted with a thesis:

* Question and answer text are copied byte for byte. The humanizer and every other prose pass are
  forbidden on them (``verbatim: true`` in the frontmatter). Derived notes go through the pipeline.
* An existing record is never rewritten. A turn already in the ledger is skipped.
* The ledger is append-only and hash-chained, so ``verify`` shows any later edit.

    py scripts/qa_capture.py capture                 one pass over the configured chat folders
    py scripts/qa_capture.py capture --dry-run       say what would be written
    py scripts/qa_capture.py watch --interval 30     keep capturing, for a logon task
    py scripts/qa_capture.py verify                  recheck every record and the ledger chain
    py scripts/qa_capture.py import --inbox DIR      bring in records saved on another machine

This file also runs by itself on a laptop with no ResearchOS checkout: copy it anywhere and pass
--vault and --workspace. It then needs only the Python standard library.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

try:
    import yaml
except ImportError:
    yaml = None

try:
    from _bootstrap import ROOT  # noqa: F401
    from research_os.config import load_config, safe_generated_path
    from research_os.storage import atomic_write_json, atomic_write_text, canonical_json, utc_now
except ImportError:
    # A copy on another laptop. These match research_os.storage, so a ledger made here verifies on the hub.
    ROOT = Path(__file__).resolve().parent
    load_config = safe_generated_path = None

    def utc_now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    def canonical_json(value: Any) -> bytes:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

    def atomic_write_text(path: Path, value: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    def atomic_write_json(path: Path, value: Any) -> None:
        atomic_write_text(path, json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")

SCHEMA_VERSION = 1
LEDGER_NAME = "qa_capture_ledger.jsonl"
TEMPLATE_RELATIVE = "templates/research_annotation.md"
SYSTEM_MESSAGE_PREFIXES = ("# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<permissions instructions>")
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
BACKEND_LABEL = {"claude-code": "Claude Code", "codex": "Codex"}

CONTEXT_END = "</zotero-context>"
BRIEF_END = "</zotero-panel-brief>"
RE_ITEM = re.compile(r"\bitem ([A-Z0-9]{8})\b")
RE_ATTACHMENT = re.compile(r"\bPDF attachment ([A-Z0-9]{8})\b")
RE_PAGE = re.compile(r"\bon p\.([^\s,;]+)")
RE_STILL_PAGE = re.compile(r"Still open, unchanged: reading .*? p\.([^\s.,;]+)")
RE_DOI = re.compile(r"\bDOI (10\.\S+)")
RE_SELECTION = re.compile(r'selected text \(p\.([^)]+)\): "(.*?)"\s*$', re.M)
RE_AREA = re.compile(r"selected area on p\.([^\s,;]+) \(annotation ([A-Z0-9]{8})\)")
RE_MATH = re.compile(r"\$\$.+?\$\$|\\\[.+?\\\]|(?<![\\$])\$(?![\s$])[^$\n]+?(?<!\s)\$(?![\d$])", re.S)
RE_HEADING = re.compile(r"^## (.+?)\s*$", re.M)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def claude_project_folder(cwd: str) -> str:
    """The folder name Claude Code gives a working directory under ~/.claude/projects."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def safe_citekey(key: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "-", key).strip(".-")
    return cleaned or "_unlinked"


def parse_time(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass
class Image:
    media_type: str
    data: bytes


@dataclass
class Turn:
    backend: str
    session_id: str
    index: int
    transcript: Path
    first_line: int
    raw_user: str
    started_at: str
    images: list[Image] = field(default_factory=list)
    answers: list[str] = field(default_factory=list)
    tools: list[dict[str, Any]] = field(default_factory=list)
    model: str = ""
    cli_version: str = ""
    originator: str = ""
    cwd: str = ""
    complete: bool = False
    finished_at: str = ""
    raw_lines: list[bytes] = field(default_factory=list)

    @property
    def answer(self) -> str:
        return "\n\n".join(self.answers)

    @property
    def transcript_sha256(self) -> str:
        return sha256_bytes(b"\n".join(self.raw_lines))


def author_of(turn: Turn) -> str:
    """cloud_agent or local_agent, the two agent authors the annotation schema allows.

    On the plan, Claude Code names only claude-* models and Codex only OpenAI's, so any other name came through a
    local endpoint. gpt-oss is an open-weight model run locally. An Ollama ":cloud" tag runs remotely.
    """
    model = turn.model.casefold()
    if not model or model.startswith("<") or "cloud" in model:
        return "cloud_agent"
    if turn.backend == "claude-code":
        return "cloud_agent" if model.startswith("claude-") else "local_agent"
    return "cloud_agent" if re.match(r"gpt-(?!oss)|o\d|codex", model) else "local_agent"


def read_lines(path: Path) -> Iterator[tuple[int, bytes, dict[str, Any]]]:
    with path.open("rb") as handle:
        for number, raw in enumerate(handle, 1):
            stripped = raw.rstrip(b"\r\n")
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError:
                continue  # a line still being written; the next pass sees it whole
            if isinstance(value, dict):
                yield number, stripped, value


def _claude_user_prompt(entry: dict[str, Any]) -> tuple[str, list[Image]] | None:
    """The text and images of a real prompt, or None for tool results and injected lines."""
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain") or entry.get("isCompactSummary"):
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list) or any(isinstance(p, dict) and p.get("type") == "tool_result" for p in content):
        return None
    texts: list[str] = []
    images: list[Image] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            texts.append(str(part.get("text", "")))
        elif part.get("type") == "image":
            image = _decode_claude_image(part.get("source") or {})
            if image:
                images.append(image)
    return ("\n\n".join(texts), images) if texts or images else None


def _decode_claude_image(source: dict[str, Any]) -> Image | None:
    media_type = str(source.get("media_type", ""))
    if source.get("type") != "base64" or media_type not in IMAGE_TYPES:
        return None
    try:
        return Image(media_type, base64.b64decode(str(source.get("data", "")), validate=True))
    except (binascii.Error, ValueError):
        return None


def read_claude_session(path: Path) -> list[Turn]:
    turns: list[Turn] = []
    current: Turn | None = None
    version = cwd = ""
    for number, raw, entry in read_lines(path):
        version = str(entry.get("version") or version)
        cwd = str(entry.get("cwd") or cwd)
        prompt = _claude_user_prompt(entry)
        if prompt is not None:
            if current:
                current.complete = current.complete or bool(current.answers)
            current = Turn("claude-code", path.stem, len(turns) + 1, path, number, prompt[0], str(entry.get("timestamp", "")), images=prompt[1], cli_version=version, originator=str(entry.get("entrypoint", "")), cwd=cwd)
            current.raw_lines.append(raw)
            turns.append(current)
            continue
        if current is None or entry.get("type") != "assistant" or entry.get("isSidechain"):
            continue
        message = entry.get("message") or {}
        current.raw_lines.append(raw)
        current.model = str(message.get("model") or current.model)
        current.finished_at = str(entry.get("timestamp", current.finished_at))
        for part in message.get("content") or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                current.answers.append(str(part.get("text", "")))
            elif part.get("type") == "tool_use":
                current.tools.append({"name": str(part.get("name", "")), "input_sha256": sha256_bytes(canonical_json(part.get("input") or {}))})
        if message.get("stop_reason") == "end_turn":
            current.complete = True
    return turns


def _decode_data_url(url: str) -> Image | None:
    match = re.match(r"data:(image/[a-z+.-]+);base64,(.*)$", url, re.S)
    if not match or match.group(1) not in IMAGE_TYPES:
        return None
    try:
        return Image(match.group(1), base64.b64decode(match.group(2), validate=True))
    except (binascii.Error, ValueError):
        return None


def read_codex_session(path: Path) -> list[Turn]:
    turns: list[Turn] = []
    current: Turn | None = None
    session_id, cwd, version, originator, model = path.stem, "", "", "", ""
    for number, raw, entry in read_lines(path):
        kind, payload = entry.get("type"), entry.get("payload") or {}
        if kind == "session_meta":
            session_id = str(payload.get("id") or session_id)
            cwd, version, originator = str(payload.get("cwd", "")), str(payload.get("cli_version", "")), str(payload.get("originator", ""))
        elif kind == "turn_context":
            model = str(payload.get("model") or model)
            if current:
                current.model = model
        elif kind == "event_msg" and payload.get("type") == "task_complete" and current:
            current.complete = bool(current.answers)
            current.finished_at = str(entry.get("timestamp", ""))
            current.raw_lines.append(raw)
        elif kind == "response_item" and payload.get("type") == "message":
            parts = [p for p in payload.get("content") or [] if isinstance(p, dict)]
            if payload.get("role") == "user":
                texts = [str(p.get("text", "")) for p in parts if p.get("type") == "input_text"]
                if not texts or texts[0].startswith(SYSTEM_MESSAGE_PREFIXES):
                    continue
                images = [i for i in (_decode_data_url(str(p.get("image_url", ""))) for p in parts if p.get("type") == "input_image") if i]
                current = Turn("codex", session_id, len(turns) + 1, path, number, "\n\n".join(texts), str(entry.get("timestamp", "")), images=images, cli_version=version, originator=originator, cwd=cwd, model=model)
                current.raw_lines.append(raw)
                turns.append(current)
            elif payload.get("role") == "assistant" and current:
                current.raw_lines.append(raw)
                current.answers.extend(str(p.get("text", "")) for p in parts if p.get("type") == "output_text")
        elif kind == "response_item" and payload.get("type") in {"function_call", "custom_tool_call", "local_shell_call"} and current:
            current.raw_lines.append(raw)
            current.tools.append({"name": str(payload.get("name") or payload.get("type")), "input_sha256": sha256_text(str(payload.get("arguments") or payload.get("input") or payload.get("action") or ""))})
    return turns


@dataclass
class Location:
    item: str = ""
    attachment: str = ""
    doi: str = ""
    page_label: str = ""
    pdf_page: int | None = None
    annotation: str = ""
    selected_text: str = ""

    @property
    def resolved(self) -> bool:
        return bool(self.item and (self.page_label or self.pdf_page or self.annotation))

    def link(self) -> str:
        if not self.attachment:
            return f"zotero://select/library/items/{self.item}" if self.item else ""
        if self.annotation:
            return f"zotero://open-pdf/library/items/{self.attachment}?annotation={self.annotation}"
        return f"zotero://open-pdf/library/items/{self.attachment}" + (f"?page={self.pdf_page}" if self.pdf_page else "")


def split_prompt(raw: str) -> tuple[str, str]:
    """(context block, the words the person typed). The question keeps its bytes exactly."""
    text = raw.split(BRIEF_END, 1)[-1] if BRIEF_END in raw else raw
    start = text.rfind("<zotero-context>")
    end = text.rfind(CONTEXT_END)
    if start < 0 or end < 0:
        return "", text.lstrip("\r\n") if BRIEF_END in raw else raw
    question = text[end + len(CONTEXT_END):]
    question = question[2:] if question.startswith("\n\n") else question.lstrip("\r\n")
    return text[start:end + len(CONTEXT_END)], question


def locate(context: str, carried: Location) -> Location:
    """What this turn points at. A later turn's context is a delta, so the item carries forward."""
    here = Location(item=carried.item, attachment=carried.attachment, doi=carried.doi)
    for regex, name in ((RE_ITEM, "item"), (RE_ATTACHMENT, "attachment"), (RE_DOI, "doi")):
        match = regex.search(context)
        if match:
            setattr(here, name, match.group(1).rstrip("."))
    page = RE_PAGE.search(context) or RE_STILL_PAGE.search(context)
    here.page_label = page.group(1).rstrip(".") if page else ""
    area, selection = RE_AREA.search(context), RE_SELECTION.search(context)
    if area:
        here.page_label, here.annotation = area.group(1), area.group(2)
    if selection:
        here.page_label = selection.group(1) if not area else here.page_label
        here.selected_text = selection.group(2)
    return here


def apply_chips(here: Location, chips: list[dict[str, Any]]) -> Location:
    """The panel's own record of the turn is exact: it holds page index, page label and keys."""
    order = {"area": 0, "selection": 1, "reader": 2, "item": 3}
    for chip in sorted(chips, key=lambda c: order.get(str(c.get("kind")), 9), reverse=True):
        ref = chip.get("ref") or {}
        here.item = str(ref.get("itemKey") or here.item)
        here.attachment = str(ref.get("attachmentKey") or here.attachment)
        if ref.get("pageIndex") is not None:
            here.pdf_page = int(ref["pageIndex"]) + 1
        if ref.get("pageLabel"):
            here.page_label = str(ref["pageLabel"])
        if chip.get("kind") == "area":
            here.annotation = str(ref.get("annotationKey") or here.annotation)
        if chip.get("kind") == "selection" and chip.get("text"):
            here.selected_text = str(chip["text"])
    return here


class PanelSessions:
    """The chat panel's history: per agent session, the chips sent with each message."""

    def __init__(self, folders: Iterable[Path]) -> None:
        self.by_session: dict[str, list[dict[str, Any]]] = {}
        for folder in folders:
            index = folder / "index.json"
            if not index.exists():
                continue
            try:
                sessions = json.loads(index.read_text(encoding="utf-8")).get("sessions", [])
            except (OSError, ValueError):
                continue
            for session in sessions:
                file = folder / f"{session.get('id')}.jsonl"
                agent_id = str(session.get("agentSessionId", ""))
                if agent_id and file.exists():
                    self.by_session[agent_id] = [v for _, _, v in read_lines(file) if v.get("t") == "user"]

    def chips(self, session_id: str, question: str) -> list[dict[str, Any]]:
        for event in self.by_session.get(session_id, []):
            if event.get("text") == question and not event.get("_used"):
                event["_used"] = True
                return list(event.get("chips") or [])
        return []


class CiteKeys:
    def __init__(self, vault: Path, zotero_sqlite: Path | None) -> None:
        self.by_key: dict[str, str] = {}
        self.by_doi: dict[str, str] = {}
        manifest = vault / "citations" / "works_manifest.jsonl"
        if manifest.exists():
            for _, _, row in read_lines(manifest):
                if row.get("bib_key"):
                    if row.get("zotero_key"):
                        self.by_key[str(row["zotero_key"])] = str(row["bib_key"])
                    if row.get("doi"):
                        self.by_doi[str(row["doi"]).casefold()] = str(row["bib_key"])
        self.database = zotero_sqlite

    def _from_zotero(self, item: str) -> str:
        if not self.database or not self.database.exists():
            return ""
        query = ("select v.value from items i join itemData d using(itemID) join fieldsCombined f using(fieldID) "
                 "join itemDataValues v using(valueID) where i.key=? and f.fieldName='citationKey'")
        try:
            connection = sqlite3.connect(f"file:{self.database.as_posix()}?mode=ro&immutable=1", uri=True)
            try:
                row = connection.execute(query, (item,)).fetchone()
            finally:
                connection.close()
        except sqlite3.Error:
            return ""
        return str(row[0]) if row and row[0] else ""

    def resolve(self, here: Location) -> str:
        return (self.by_key.get(here.item) or self.by_doi.get(here.doi.casefold(), "")
                or (self._from_zotero(here.item) if here.item else "")
                or (f"zotero-{here.item}" if here.item else ""))


class Template:
    """Section headings and frontmatter keys come from the wiki's template, so the two stay in step."""

    def __init__(self, vault: Path) -> None:
        text = (vault / TEMPLATE_RELATIVE).read_text(encoding="utf-8")
        parts = text.split("---", 2)
        keys = [line.split(":", 1)[0].strip() for line in parts[1].splitlines() if re.match(r"^[A-Za-z_]+:", line)]
        self.keys = keys
        self.headings = RE_HEADING.findall(parts[2])


def frontmatter(values: dict[str, Any], template: Template) -> str:
    ordered = {key: values[key] for key in template.keys if key in values}
    ordered.update(values)
    return "\n".join(["---", *[f"{name}: {json.dumps(value, ensure_ascii=False)}" for name, value in ordered.items()], "---"])


def verbatim_block(record_id: str, body: str) -> str:
    return f"<!-- verbatim:start {record_id} -->\n{body}\n<!-- verbatim:end {record_id} -->"


def extract_verbatim(record_id: str, text: str) -> str | None:
    start, end = f"<!-- verbatim:start {record_id} -->\n", f"\n<!-- verbatim:end {record_id} -->"
    first, last = text.find(start), text.rfind(end)
    return text[first + len(start):last] if first >= 0 and last >= first else None


def math_source(body: str) -> str:
    """The LaTeX as typed, beside the rendered Note: Perusall's raw source and rendered view."""
    blocks = list(dict.fromkeys(RE_MATH.findall(body)))
    if not blocks:
        return "None in this record."
    return "```latex\n" + "\n\n".join(blocks) + "\n```"


def source_lines(citekey: str, here: Location, source_page: str, turn: Turn, image_paths: list[str]) -> list[str]:
    quote = sha256_text(here.selected_text)[:16] if here.selected_text else ""
    lines = [
        f"- Paper/wiki page: {source_page}",
        f"- Zotero annotation key: {here.annotation or 'none'}",
        f"- DOI: {here.doi or 'not in this session'}",
        f"- PDF page: {here.pdf_page or 'not recorded'} (printed page {here.page_label or 'not recorded'})",
        f"- Selected quote hash or short quoted evidence: {quote or 'none'}",
        f"- Open in Zotero: {here.link() or 'not linked'}",
        f"- Session: {BACKEND_LABEL[turn.backend]} {turn.session_id}, turn {turn.index}",
    ]
    lines.extend(f"- Figure region sent: ![[{path}]]" for path in image_paths)
    return lines


def render(kind: str, record_id: str, partner_name: str, values: dict[str, Any], body: str, sections: list[str], template: Template, turn: Turn) -> str:
    text = [frontmatter(values, template), "", f"# {values['title']}", ""]
    for heading in template.headings:
        text.append(f"## {heading}")
        text.append("")
        if heading == template.headings[0]:
            if kind == "agent_answer":
                text.extend(["> [!warning]", f"> {BACKEND_LABEL[turn.backend]} answer ({turn.model}), kept word for word. Not primary evidence. Verify every claim against the paper before reuse.", ""])
            text.append(verbatim_block(record_id, body))
        elif heading.casefold() == "math":
            text.append(math_source(body))
        elif heading.casefold() == "source link":
            text.extend(sections)
        else:
            label = "Answer" if kind == "question" else "Asked in"
            text.extend([f"- {label}: [[{partner_name}]]", "- This record stays verbatim. Write any derived note as a new linked record."])
        text.append("")
    return "\n".join(text)


class Ledger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.entries: list[dict[str, Any]] = []
        if path.exists():
            self.entries = [v for _, _, v in read_lines(path)]
        self.seen = {str(e.get("turn_key")) for e in self.entries}

    @property
    def head(self) -> str:
        return str(self.entries[-1]["entry_sha256"]) if self.entries else ""

    def append(self, entry: dict[str, Any]) -> None:
        entry = {**entry, "prev_entry_sha256": self.head}
        entry["entry_sha256"] = sha256_bytes(canonical_json(entry))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(canonical_json(entry).decode("utf-8") + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.entries.append(entry)
        self.seen.add(str(entry["turn_key"]))


class LedgerLock:
    """One writer at a time: the watcher and a night import can both append to the ledger."""

    def __init__(self, ledger_path: Path, wait_seconds: float = 60.0, stale_seconds: float = 600.0) -> None:
        self.path = ledger_path.with_suffix(".lock")
        self.wait_seconds = wait_seconds
        self.stale_seconds = stale_seconds

    def __enter__(self) -> "LedgerLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + self.wait_seconds
        while True:
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                return self
            except (FileExistsError, PermissionError):
                with contextlib.suppress(OSError):
                    if time.time() - self.path.stat().st_mtime > self.stale_seconds:
                        self.path.unlink()
                        continue
                if time.time() > deadline:
                    raise SystemExit(f"ledger is locked: {self.path}") from None
                time.sleep(0.2)

    def __exit__(self, *_: object) -> None:
        with contextlib.suppress(OSError):
            self.path.unlink()


def ledger_lock(settings: "Settings", dry_run: bool) -> Any:
    return contextlib.nullcontext() if dry_run else LedgerLock(settings.workspace / LEDGER_NAME)


@dataclass
class Settings:
    vault: Path
    workspace: Path
    chat_folders: list[str]
    panel_sessions: list[Path]
    claude_projects: Path
    codex_sessions: Path
    zotero_sqlite: Path | None


def read_yaml(path: Path) -> dict[str, Any]:
    if yaml is None or not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def load_settings(args: argparse.Namespace) -> Settings:
    # A laptop with only --vault and --workspace needs no ResearchOS paths, so the config is read only when used.
    if args.vault and args.workspace:
        config: dict[str, Any] = {}
    elif load_config is None:
        raise SystemExit("this copy runs without ResearchOS: pass --vault and --workspace")
    else:
        config = load_config()
    options = read_yaml(Path(ROOT) / "cfg" / "qa_capture.yaml")
    works = read_yaml(Path(ROOT) / "cfg" / "works.yaml")
    home = Path.home()
    return Settings(
        vault=Path(args.vault or config["paths"]["vault_root"]).resolve(),
        workspace=Path(args.workspace) if args.workspace else safe_generated_path(config, "annotation_workspace"),
        chat_folders=list(getattr(args, "chat_folder", None) or options.get("chat_folders") or []),
        panel_sessions=[Path(p) for p in (getattr(args, "panel_sessions", None) or options.get("panel_sessions") or [])],
        claude_projects=Path(options.get("claude_projects") or home / ".claude" / "projects"),
        codex_sessions=Path(options.get("codex_sessions") or home / ".codex" / "sessions"),
        zotero_sqlite=Path(args.zotero_sqlite or works.get("zotero_sqlite") or "") if (args.zotero_sqlite or works.get("zotero_sqlite")) else None,
    )


def in_chat_folders(cwd: str, folders: list[str]) -> bool:
    normalized = cwd.rstrip("\\/").casefold()
    for folder in folders:
        target = folder.rstrip("\\/").casefold()
        if target.endswith("*"):
            if normalized.startswith(target[:-1]):
                return True
        elif normalized == target:
            return True
    return False


def codex_session_folder(path: Path) -> str | None:
    """The folder a Codex rollout ran in, from its first line, so that unrelated sessions are never read in full."""
    try:
        with path.open("rb") as handle:
            first = json.loads(handle.readline())
    except (OSError, ValueError):
        return None
    payload = first.get("payload") if isinstance(first, dict) else None
    return str(payload.get("cwd", "")) if first.get("type") == "session_meta" and isinstance(payload, dict) else None


def session_files(settings: Settings) -> Iterator[tuple[str, Path]]:
    names = [claude_project_folder(f.rstrip("\\/*")) for f in settings.chat_folders]
    if settings.claude_projects.exists():
        for folder in sorted(settings.claude_projects.iterdir()):
            if folder.is_dir() and any(folder.name == n or folder.name.startswith(n + "-") for n in names):
                for path in sorted(folder.glob("*.jsonl")):
                    yield "claude-code", path
    if settings.codex_sessions.exists():
        for path in sorted(settings.codex_sessions.rglob("rollout-*.jsonl")):
            folder = codex_session_folder(path)
            if folder is None or in_chat_folders(folder, settings.chat_folders):
                yield "codex", path


def capture_turn(turn: Turn, here: Location, question: str, context: str, citekey: str, settings: Settings, template: Template, ledger: Ledger, dry_run: bool) -> dict[str, Any]:
    linked = bool(citekey and here.resolved)
    folder_name = safe_citekey(citekey) if citekey else "_unlinked"
    folder = settings.vault / "wiki" / "annotations" / folder_name
    moment = parse_time(turn.started_at)
    stamp = moment.strftime("%Y-%m-%d-%H%M%S")
    turn_key = f"{turn.backend}:{turn.session_id}:{turn.index}"
    target = {"citekey": citekey, "zotero_item_key": here.item, "zotero_attachment_key": here.attachment, "zotero_annotation_key": here.annotation, "doi": here.doi, "pdf_page": here.pdf_page, "page_label": here.page_label, "selected_quote_hash": sha256_text(here.selected_text)[:16] if here.selected_text else ""}
    target = {k: v for k, v in target.items() if v not in ("", None)}
    question_sha, answer_sha = sha256_text(question), sha256_text(turn.answer)
    question_id = f"que-{sha256_bytes(canonical_json({'turn': turn_key, 'body': question_sha}))[:20]}"
    answer_id = f"age-{sha256_bytes(canonical_json({'turn': turn_key, 'body': answer_sha}))[:20]}"
    question_name, answer_name = f"{stamp}-q-{question_id[4:12]}", f"{stamp}-a-{answer_id[4:12]}"
    summary = {"turn_key": turn_key, "citekey": citekey or None, "linked": linked, "question_file": f"wiki/annotations/{folder_name}/{question_name}.md", "answer_file": f"wiki/annotations/{folder_name}/{answer_name}.md"}
    if dry_run:
        return summary

    folder.mkdir(parents=True, exist_ok=True)
    image_paths: list[str] = []
    image_rows: list[dict[str, Any]] = []
    for image in turn.images:
        digest = sha256_bytes(image.data)
        name = f"assets/{digest[:24]}{IMAGE_TYPES[image.media_type]}"
        path = folder / name
        if not path.exists():
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(image.data)
        image_paths.append(name)
        image_rows.append({"path": name, "sha256": digest, "media_type": image.media_type, "redistributable": False})

    page = settings.vault / "wiki" / "sources" / f"{citekey}.md"
    source_page = f"[[{citekey}]]" if citekey and page.exists() else (f"`{citekey}`" if citekey else "not linked")
    sections = source_lines(citekey, here, source_page, turn, image_paths)
    common = {
        "page_type": "research-annotation", "visibility": "local_only", "target": target, "cloud_safe": False,
        "created_at": turn.started_at, "verbatim": True, "humanizer": "exempt", "researchos_generated": True,
        "backend": turn.backend, "model": turn.model, "cli_version": turn.cli_version, "session_id": turn.session_id,
        "turn_index": turn.index, "transcript_sha256": turn.transcript_sha256, "link_status": "resolved" if linked else "unresolved",
    }
    author = author_of(turn)
    question_values = {**common, "title": f"Question - {folder_name} - {stamp}", "annotation_id": question_id, "annotation_kind": "question", "author_type": "human", "tags": ["reading-room", "qa-question"], "parent_id": None, "body_sha256": question_sha, "images": image_rows}
    answer_values = {**common, "title": f"Answer - {folder_name} - {stamp}", "annotation_id": answer_id, "annotation_kind": "agent_answer", "author_type": author, "tags": ["reading-room", "qa-answer"], "parent_id": question_id, "body_sha256": answer_sha, "finished_at": turn.finished_at, "tools": turn.tools}
    question_text = render("question", question_id, answer_name, question_values, question, sections, template, turn)
    if context:
        question_text += "\n## Context sent with this turn\n\n" + "```text\n" + context + "\n```\n"
    answer_text = render("agent_answer", answer_id, question_name, answer_values, turn.answer, sections, template, turn)

    records = settings.workspace / "records"
    written = []
    for name, text, record_id, kind, author, body, parent in (
        (question_name, question_text, question_id, "question", "human", question, None),
        (answer_name, answer_text, answer_id, "agent_answer", author, turn.answer, question_id),
    ):
        path = folder / f"{name}.md"
        if path.exists():
            # A run stopped between writing this file and its ledger line: finish it. Never replace a record that differs.
            if extract_verbatim(record_id, path.read_text(encoding="utf-8")) != body:
                raise SystemExit(f"refusing to overwrite a record that differs: {path}")
        else:
            atomic_write_text(path, text)
        atomic_write_json(records / f"{record_id}.json", {"schema_version": 1, "annotation_id": record_id, "kind": kind, "author": author, "visibility": "local_only", "target": target, "body": body, "latex": "", "tags": ["reading-room"], "parent_id": parent, "lineage": [turn_key], "review_status": "unreviewed", "created_at": turn.started_at})
        written.append({"id": record_id, "kind": kind, "file": path.relative_to(settings.vault).as_posix(), "body_sha256": sha256_text(body), "record_file_sha256": sha256_bytes(path.read_bytes())})
    ledger.append({"schema_version": SCHEMA_VERSION, "turn_key": turn_key, "captured_at": utc_now(), "backend": turn.backend, "model": turn.model, "author": author, "cli_version": turn.cli_version, "started_at": turn.started_at, "finished_at": turn.finished_at, "transcript": str(turn.transcript), "transcript_first_line": turn.first_line, "transcript_sha256": turn.transcript_sha256, "target": target, "records": written, "images": image_rows})
    return summary


def run_capture(settings: Settings, dry_run: bool, settle_seconds: float, now: float | None = None, settled: dict[Path, tuple[int, int]] | None = None) -> dict[str, Any]:
    """One pass. `settled` remembers finished transcripts between passes, so a watcher reads only what changed."""
    with ledger_lock(settings, dry_run):
        return _capture_pass(settings, dry_run, settle_seconds, now, settled)


def _capture_pass(settings: Settings, dry_run: bool, settle_seconds: float, now: float | None, settled: dict[Path, tuple[int, int]] | None = None) -> dict[str, Any]:
    template = Template(settings.vault)
    ledger = Ledger(settings.workspace / LEDGER_NAME)
    citekeys = CiteKeys(settings.vault, settings.zotero_sqlite)
    panels = PanelSessions(settings.panel_sessions)
    now = time.time() if now is None else now
    out: list[dict[str, Any]] = []
    skipped = waiting = 0
    for backend, path in session_files(settings):
        info = path.stat()
        stamp = (info.st_mtime_ns, info.st_size)
        if settled is not None and settled.get(path) == stamp:
            continue
        waiting_before = waiting
        turns = read_claude_session(path) if backend == "claude-code" else read_codex_session(path)
        carried = Location()
        for turn in turns:
            if not in_chat_folders(turn.cwd, settings.chat_folders):
                break
            context, question = split_prompt(turn.raw_user)
            here = apply_chips(locate(context, carried), panels.chips(turn.session_id, question))
            carried = here
            if not turn.complete and now - path.stat().st_mtime < settle_seconds:
                waiting += 1
                continue
            if not turn.answers:
                continue
            if f"{turn.backend}:{turn.session_id}:{turn.index}" in ledger.seen:
                skipped += 1
                continue
            out.append(capture_turn(turn, here, question, context, citekeys.resolve(here), settings, template, ledger, dry_run))
        if settled is not None and waiting == waiting_before:
            settled[path] = stamp
    return {"schema_version": SCHEMA_VERSION, "dry_run": dry_run, "captured": out, "already_in_ledger": skipped, "still_running": waiting}


def run_verify(settings: Settings) -> dict[str, Any]:
    ledger = Ledger(settings.workspace / LEDGER_NAME)
    problems: list[str] = []
    previous = ""
    for entry in ledger.entries:
        claimed = entry.get("entry_sha256")
        body = {k: v for k, v in entry.items() if k != "entry_sha256"}
        if entry.get("prev_entry_sha256") != previous or sha256_bytes(canonical_json(body)) != claimed:
            problems.append(f"ledger chain broken at {entry.get('turn_key')}")
        previous = str(claimed)
        for record in entry.get("records", []):
            path = settings.vault / record["file"]
            if not path.exists():
                problems.append(f"missing record {record['file']}")
                continue
            text = path.read_text(encoding="utf-8")
            body_text = extract_verbatim(record["id"], text)
            if body_text is None or sha256_text(body_text) != record["body_sha256"]:
                problems.append(f"verbatim text changed in {record['file']}")
            if sha256_bytes(path.read_bytes()) != record["record_file_sha256"]:
                problems.append(f"record file changed in {record['file']}")
        for image in entry.get("images", []):
            folder = Path(entry["records"][0]["file"]).parent
            path = settings.vault / folder / image["path"]
            if not path.exists() or sha256_bytes(path.read_bytes()) != image["sha256"]:
                problems.append(f"image changed: {folder}/{image['path']}")
    return {"schema_version": SCHEMA_VERSION, "turns": len(ledger.entries), "ok": not problems, "problems": problems}


class WatchLog:
    """A background task has no console, and a problem that repeats every pass is written once."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.last_problem = ""

    def write(self, line: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(f"{utc_now()} {line}\n")

    def problem(self, text: str) -> None:
        if text != self.last_problem:
            self.write(f"problem: {text}")
        self.last_problem = text


def watch_pass(settings: Settings, settle_seconds: float, settled: dict[Path, tuple[int, int]], log: WatchLog) -> None:
    """One pass of the watcher. A problem is logged and the next pass goes ahead, so the task keeps running."""
    try:
        result = run_capture(settings, False, settle_seconds, settled=settled)
    except (Exception, SystemExit) as error:
        log.problem(f"{type(error).__name__}: {error}")
        return
    log.last_problem = ""
    for turn in result["captured"]:
        log.write(f"captured {turn['turn_key']} {turn['question_file']}")


def entry_files(entry: dict[str, Any], there: Settings, here: Settings) -> list[tuple[Path, Path]]:
    """Every file one ledger entry owns, as (on the other machine, in this vault)."""
    pairs = [(there.vault / r["file"], here.vault / r["file"]) for r in entry.get("records", [])]
    folder = Path(entry["records"][0]["file"]).parent if entry.get("records") else Path()
    pairs += [(there.vault / folder / i["path"], here.vault / folder / i["path"]) for i in entry.get("images", [])]
    for record in entry.get("records", []):
        name = f"{record['id']}.json"
        if (there.workspace / "records" / name).exists():
            pairs.append((there.workspace / "records" / name, here.workspace / "records" / name))
    return pairs


def copy_exact(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    temporary.write_bytes(source.read_bytes())
    os.replace(temporary, target)


def import_machine(root: Path, settings: Settings, ledger: Ledger, dry_run: bool) -> dict[str, Any]:
    there = Settings(root / "vault", root / "workspace", [], [], Path(), Path(), None)
    report: dict[str, Any] = {"machine": root.name, "imported": 0, "already_here": 0, "refused": []}
    check = run_verify(there)
    if not check["ok"]:
        report["refused"] = check["problems"]
        return report
    for entry in Ledger(there.workspace / LEDGER_NAME).entries:
        if entry["turn_key"] in ledger.seen:
            report["already_here"] += 1
            continue
        pairs = entry_files(entry, there, settings)
        clashes = [target for source, target in pairs if target.exists() and target.read_bytes() != source.read_bytes()]
        if clashes:
            report["refused"].extend(f"differs here, not replaced: {path}" for path in clashes)
            continue
        report["imported"] += 1
        if dry_run:
            continue
        for source, target in pairs:
            if not target.exists():
                copy_exact(source, target)
        kept = {k: v for k, v in entry.items() if k not in ("entry_sha256", "prev_entry_sha256")}
        ledger.append({**kept, "origin_machine": root.name, "origin_entry_sha256": entry["entry_sha256"]})
    return report


def run_import(settings: Settings, inbox: Path, dry_run: bool) -> dict[str, Any]:
    """Bring in <inbox>/<machine>/vault and workspace. A machine that fails verify is refused whole."""
    with ledger_lock(settings, dry_run):
        ledger = Ledger(settings.workspace / LEDGER_NAME)
        machines = [import_machine(path.parent.parent, settings, ledger, dry_run) for path in sorted(inbox.glob(f"*/workspace/{LEDGER_NAME}"))]
    return {"schema_version": SCHEMA_VERSION, "dry_run": dry_run, "machines": machines, "ok": not any(m["refused"] for m in machines)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("capture", "watch", "verify", "import"))
    parser.add_argument("--vault", default="", help="Vault root (default: the configured wiki)")
    parser.add_argument("--workspace", default="", help="Ledger and record folder (default: generated/annotation_workspace)")
    parser.add_argument("--chat-folder", action="append", help="A folder chats run in; a trailing * matches any folder below it")
    parser.add_argument("--panel-sessions", action="append", help="A zotero-chat/sessions folder, for exact page and key")
    parser.add_argument("--zotero-sqlite", default="", help="zotero.sqlite to read citation keys from (read only)")
    parser.add_argument("--settle-seconds", type=float, default=20.0, help="Wait this long before closing a turn with no end marker")
    parser.add_argument("--interval", type=float, default=30.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--inbox", default="", help="For import: a folder of <machine>/vault and <machine>/workspace")
    args = parser.parse_args()
    settings = load_settings(args)
    if args.command == "import":
        if not args.inbox:
            raise SystemExit("import needs --inbox")
        result = run_import(settings, Path(args.inbox), args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if args.command == "verify":
        result = run_verify(settings)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if not settings.chat_folders:
        raise SystemExit("no chat folders: set chat_folders in cfg/qa_capture.yaml or pass --chat-folder")
    if args.command == "capture":
        print(json.dumps(run_capture(settings, args.dry_run, args.settle_seconds), ensure_ascii=False, indent=2))
        return 0
    log = WatchLog(settings.workspace / "qa_capture_watch.log")
    log.write(f"watching {len(settings.chat_folders)} chat folders every {args.interval:g} s")
    settled: dict[Path, tuple[int, int]] = {}
    while True:
        watch_pass(settings, args.settle_seconds, settled, log)
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
