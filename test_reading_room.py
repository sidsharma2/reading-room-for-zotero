"""The kit on a machine with no ResearchOS: folders, Zotero lookup, and a record reaching the hub through git."""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kit = load("reading_room")
qa = load("qa_capture")


def setup_args(root: Path, kind: str = "lmstudio", model: str = "qwen/qwen3.5-9b", remote: str = "") -> argparse.Namespace:
    return argparse.Namespace(root=str(root), local=kind, model=model, machine="mac", capture_remote=remote)


def transcript(folder: Path, cwd: str, model: str = "claude-sonnet-5-5") -> None:
    path = folder / ".claude" / "projects" / qa.claude_project_folder(cwd) / "s1.jsonl"
    path.parent.mkdir(parents=True)
    context = '<zotero-context>\nReading: "A" · item JATNR3TM · PDF attachment PNXMSVXL · on p.4\n</zotero-context>'
    rows = [
        {"type": "user", "cwd": cwd, "version": "2", "timestamp": "2026-11-07T01:10:30.000Z", "message": {"role": "user", "content": f"{context}\n\nWhy $k_f$?"}},
        {"type": "assistant", "timestamp": "2026-11-07T01:10:32.000Z", "message": {"model": model, "stop_reason": "end_turn", "content": [{"type": "text", "text": "Because."}]}},
    ]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "home"
    folder.mkdir()
    monkeypatch.setenv("HOME", str(folder))
    monkeypatch.setenv("USERPROFILE", str(folder))
    monkeypatch.setenv("APPDATA", str(folder / "AppData"))
    monkeypatch.setattr(kit, "claude_ai_servers", lambda _folder: [])
    return folder


@pytest.mark.parametrize(("kind", "url"), [("lmstudio", "http://127.0.0.1:1234"), ("ollama", "http://127.0.0.1:11434")])
def test_setup_makes_a_cloud_folder_and_a_local_folder(home: Path, kind: str, url: str) -> None:
    root = home / "ReadingRoom"
    kit.setup(setup_args(root, kind, "m"))
    assert "env" not in json.loads((root / "chat" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    env = json.loads((root / "chat-local" / ".claude" / "settings.json").read_text(encoding="utf-8"))["env"]
    assert env["ANTHROPIC_BASE_URL"] == url and env["ANTHROPIC_DEFAULT_SONNET_MODEL"] == "m"
    assert "ANTHROPIC_API_KEY" not in env
    assert (root / "capture" / "mac" / "vault" / "templates" / "research_annotation.md").exists()


def test_template_has_the_hub_headings(home: Path) -> None:
    root = home / "ReadingRoom"
    kit.setup(setup_args(root))
    template = qa.Template(root / "capture" / "mac" / "vault")
    assert template.headings == ["Note", "Math", "Source link", "Agent follow-up"]
    assert {"page_type", "author_type", "cloud_safe", "created_at"} <= set(template.keys)


@pytest.mark.parametrize(("platform", "parts"), [("darwin", ("Library", "Application Support", "Zotero")), ("linux", (".zotero", "zotero"))])
def test_profile_and_data_folder_are_found(home: Path, monkeypatch: pytest.MonkeyPatch, platform: str, parts: tuple[str, ...]) -> None:
    monkeypatch.setattr(kit.sys, "platform", platform)
    base = home.joinpath(*parts)
    profile = base / "Profiles" / "abc.default"
    profile.mkdir(parents=True)
    (base / "profiles.ini").write_text("[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default\nDefault=1\n", encoding="utf-8")
    (profile / "prefs.js").write_text('user_pref("extensions.lastAppVersion", "7.0.15");\nuser_pref("extensions.zotero.dataDir", "/Volumes/D/Zotero");\n', encoding="utf-8")
    assert kit.find_profile() == profile
    assert kit.find_data_folder(profile) == Path("/Volumes/D/Zotero")
    rows = kit.check_zotero({"profile": str(profile)})
    assert rows[0][0] is False and "7.0.15" in rows[0][2]
    assert not any(good for good, name, _ in rows if name == "Agent bridge")


def test_data_folder_defaults_to_the_home_folder(home: Path) -> None:
    assert kit.find_data_folder(None) == Path.home() / "Zotero"


@pytest.mark.parametrize(("kind", "reply", "names"), [
    ("ollama", {"models": [{"name": "qwen3.5:4b"}]}, ["qwen3.5:4b"]),
    ("lmstudio", {"data": [{"id": "qwen/qwen3.5-9b"}]}, ["qwen/qwen3.5-9b"]),
])
def test_model_names_from_either_server(kind: str, reply: dict, names: list[str]) -> None:
    assert kit.model_names(kind, reply) == names


def test_a_small_context_is_flagged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kit, "fetch_json", lambda url, seconds=5.0: {"models": [{"name": "m", "context_length": 16384}]})
    rows = kit.check_local({"local": {"kind": "ollama", "model": "m"}})
    assert [good for good, name, _ in rows if name == "Context length"] == [False]


def test_a_record_reaches_the_hub_through_git(home: Path, tmp_path: Path) -> None:
    bare = tmp_path / "inbox.git"
    subprocess.run(["git", "init", "--bare", "-q", str(bare)], check=True)
    root = home / "ReadingRoom"
    kit.setup(setup_args(root, remote=str(bare)))
    for words in (("config", "user.email", "test@example.invalid"), ("config", "user.name", "test")):
        subprocess.run(["git", "-C", str(root / "capture"), *words], check=True)
    transcript(home, str(root / "chat-local"), model="qwen/qwen3.5-9b")
    args = argparse.Namespace(root=str(root))
    assert kit.sync(args) == 0
    assert kit.sync(args) == 0

    pulled = tmp_path / "hub-clone"
    subprocess.run(["git", "clone", "-q", str(bare), str(pulled)], check=True)
    vault = tmp_path / "hub-vault"
    (vault / "templates").mkdir(parents=True)
    (vault / "templates" / "research_annotation.md").write_text((HERE / "research_annotation.md").read_text(encoding="utf-8"), encoding="utf-8")
    hub = qa.Settings(vault, tmp_path / "hub-workspace", [], [], Path(), Path(), None)
    result = qa.run_import(hub, pulled, False)
    assert result["ok"] and result["machines"][0]["imported"] == 1, result
    assert qa.run_verify(hub)["ok"]
    answer = next((vault / "wiki" / "annotations" / "zotero-JATNR3TM").glob("*-a-*.md")).read_text(encoding="utf-8")
    assert 'author_type: "local_agent"' in answer and "Because." in answer


def desktop(home: Path, version: str) -> Path:
    path = home / "AppData" / "Claude" / "claude-code" / version / "abc123" / "claude.exe"
    path.parent.mkdir(parents=True)
    path.write_bytes(version.encode())
    return path


def test_link_uses_the_newest_desktop_cli(home: Path) -> None:
    desktop(home, "2.1.9")
    newest = desktop(home, "2.1.317")
    assert kit.desktop_claude() == newest
    kit.link_claude(argparse.Namespace())
    assert kit.link_target().read_bytes() == b"2.1.317"


def test_link_never_replaces_a_real_install(home: Path) -> None:
    desktop(home, "2.1.317")
    target = kit.link_target()
    target.parent.mkdir(parents=True)
    target.write_bytes(b"real")
    with pytest.raises(SystemExit):
        kit.link_claude(argparse.Namespace())
    assert target.read_bytes() == b"real"


def test_an_old_link_is_flagged_and_can_be_refreshed(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kit.shutil, "which", lambda tool: str(kit.link_target()))
    desktop(home, "2.1.9")
    kit.link_claude(argparse.Namespace())
    assert not any(name == "claude link" for _, name, _ in kit.check_tools())
    desktop(home, "2.1.317")
    assert [good for good, name, _ in kit.check_tools() if name == "claude link"] == [False]
    kit.link_claude(argparse.Namespace())
    assert not any(name == "claude link" for _, name, _ in kit.check_tools())


def test_the_placeholder_goes_to_zotero_and_nowhere_else(home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    started = {}
    monkeypatch.setattr(kit.subprocess, "Popen", lambda command, env, **_: started.update(command=command, env=env))
    app = tmp_path / "zotero.exe"
    app.write_bytes(b"")
    kit.start_zotero(argparse.Namespace(app=str(app)))
    assert started["env"]["ANTHROPIC_AUTH_TOKEN"] == "local" and started["command"] == [str(app)]
    assert kit.os.environ.get("ANTHROPIC_AUTH_TOKEN") != "local"


def test_zotero_not_found_says_so(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kit, "find_zotero_app", lambda: None)
    with pytest.raises(SystemExit):
        kit.start_zotero(argparse.Namespace(app=""))


def test_both_folders_get_the_source_hook_and_only_local_stays_offline(home: Path) -> None:
    root = home / "ReadingRoom"
    args = setup_args(root)
    args.vault = str(home / "wiki-copy")
    args.auto_read = True
    kit.setup(args)
    cloud = json.loads((root / "chat" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    local = json.loads((root / "chat-local" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    cloud_hook = cloud["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    local_hook = local["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert "related_sources.py" in cloud_hook and "--hook" in cloud_hook and "--offline" not in cloud_hook
    assert local_hook.endswith("--offline")
    assert "--pre-tool" in cloud["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    assert "Bash" in cloud["hooks"]["PreToolUse"][0]["matcher"] and "permissions" not in cloud
    assert "wiki-copy" in (root / "chat" / "CLAUDE.md").read_text(encoding="utf-8")


def test_codex_guide_keeps_the_panels_block(home: Path) -> None:
    folder = home / "chat"
    folder.mkdir()
    (folder / "AGENTS.md").write_text("<!-- BEGIN zotero-cli skill -->\npanel text\n<!-- END zotero-cli skill -->\n", encoding="utf-8")
    kit.write_codex_guide(folder, kit.codex_guide(home))
    kit.write_codex_guide(folder, kit.codex_guide(home))
    text = (folder / "AGENTS.md").read_text(encoding="utf-8")
    assert "panel text" in text and text.count(kit.AGENTS_BEGIN) == 1 and "related_sources.py" in text


def test_auto_approval_is_off_unless_asked_for(home: Path) -> None:
    root = home / "ReadingRoom"
    kit.setup(setup_args(root))
    for name in ("chat", "chat-local"):
        settings = json.loads((root / name / ".claude" / "settings.json").read_text(encoding="utf-8"))
        assert list(settings["hooks"]) == ["UserPromptSubmit"] and "allow" not in settings.get("permissions", {})


def test_codex_may_reach_zotero_from_the_cloud_folders_only(home: Path) -> None:
    (home / ".codex").mkdir()
    (home / ".codex" / "config.toml").write_text('model = "m"\n', encoding="utf-8")
    root = home / "ReadingRoom"
    kit.setup(setup_args(root))
    kit.setup(setup_args(root))
    assert "network_access = true" in (root / "chat" / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert not (root / "chat-local" / ".codex").exists()
    user = (home / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert user.startswith('model = "m"') and user.count(f'[projects."{(root / "chat").resolve().as_posix()}"]') == 1


@pytest.mark.skipif(sys.platform == "win32", reason="the fake claude is a shell script")
def test_claude_ai_connectors_are_read_from_the_first_event(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = tmp_path / "claude"
    init = {"type": "system", "subtype": "init", "tools": ["Read", "mcp__claude_ai_Gmail__send", "mcp__claude_ai_Gmail__read", "mcp__claude_ai_alphaXiv__find", "mcp__wiki__x"]}
    fake.write_text(f"#!/bin/sh\necho 'not json'\necho '{json.dumps(init)}'\nsleep 30\n", encoding="utf-8")
    fake.chmod(0o755)
    monkeypatch.setattr(kit.shutil, "which", lambda name: str(fake) if name == "claude" else None)
    assert kit.claude_ai_servers(tmp_path) == ["mcp__claude_ai_Gmail", "mcp__claude_ai_alphaXiv"]


@pytest.mark.skipif(sys.platform == "win32", reason="the fake claude is a shell script")
def test_a_stalled_claude_cannot_hang_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = tmp_path / "claude"
    fake.write_text("#!/bin/sh\nprintf '{\"type\": \"sys'\nsleep 30\n", encoding="utf-8")  # half a line, then nothing
    fake.chmod(0o755)
    monkeypatch.setattr(kit.shutil, "which", lambda name: str(fake) if name == "claude" else None)
    start = kit.time.monotonic()
    assert kit.claude_ai_servers(tmp_path, seconds=1) == []
    assert kit.time.monotonic() - start < 10


def test_setup_denies_the_connectors_in_the_local_folder_only(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kit, "claude_ai_servers", lambda _folder: ["mcp__claude_ai_Gmail"])
    root = home / "ReadingRoom"
    kit.setup(setup_args(root))
    local = json.loads((root / "chat-local" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert {"mcp__claude_ai_Gmail", "Write", "Edit"} <= set(local["permissions"]["deny"])
    assert "permissions" not in json.loads((root / "chat" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert 'model_reasoning_effort = "medium"' in (root / "chat" / ".codex" / "config.toml").read_text(encoding="utf-8")


def test_local_ready_loads_only_when_the_context_is_short(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = home / "ReadingRoom"
    kit.setup(setup_args(root, "lmstudio", "gemma"))
    calls: list[list[str]] = []
    monkeypatch.setattr(kit, "lms_path", lambda: "lms")
    monkeypatch.setattr(kit.subprocess, "run", lambda words, **_: calls.append(words) or subprocess.CompletedProcess(words, 0, "", ""))
    args = argparse.Namespace(root=str(root))
    monkeypatch.setattr(kit, "loaded_context", lambda *_: 32768)
    kit.local_ready(args)
    assert [c[1] for c in calls] == ["server"]
    calls.clear()
    contexts = iter([4096, 32768])
    monkeypatch.setattr(kit, "loaded_context", lambda *_: next(contexts))
    kit.local_ready(args)
    assert [c[1] for c in calls] == ["server", "unload", "load"] and "32768" in calls[-1]


def test_the_autoload_job_runs_local_ready_at_login(tmp_path: Path) -> None:
    agent = kit.autoload_agent(tmp_path)
    assert agent["RunAtLoad"] and "StartInterval" not in agent and agent["ProgramArguments"][-1] == "local-ready"


def test_only_the_local_folder_trims_its_prompt(home: Path) -> None:
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text(json.dumps({"enabledPlugins": {"a@m": True, "b@m": False}}), encoding="utf-8")
    (home / ".claude.json").write_text(json.dumps({"mcpServers": {"wiki": {}}}), encoding="utf-8")
    root = home / "ReadingRoom"
    kit.setup(setup_args(root))
    cloud = json.loads((root / "chat" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    local = json.loads((root / "chat-local" / ".claude" / "settings.json").read_text(encoding="utf-8"))
    assert "permissions" not in cloud and "enabledPlugins" not in cloud
    assert {"Skill", "mcp__wiki"} <= set(local["permissions"]["deny"]) and not {"Read", "Grep", "Glob", "Bash"} & set(local["permissions"]["deny"])
    assert local["enabledPlugins"] == {"a@m": False}
    assert kit.LOCAL_GUIDE in (root / "chat-local" / "CLAUDE.md").read_text(encoding="utf-8")
    assert kit.LOCAL_GUIDE not in (root / "chat" / "CLAUDE.md").read_text(encoding="utf-8")


def test_the_panels_default_folder_is_set_up_once_and_captured(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (home / "Documents").mkdir()
    root = home / "ReadingRoom"
    args = setup_args(root)
    args.also_folder = [str(home / "Documents" / "Zotero-Agent")]
    kit.setup(args)
    panel = home / "Documents" / "Zotero-Agent"
    config = json.loads((root / "reading_room.json").read_text(encoding="utf-8"))
    assert config["chat_folders"] == [str(root / "chat"), str(root / "chat-local"), str(panel)]
    assert "UserPromptSubmit" in json.loads((panel / ".claude" / "settings.json").read_text(encoding="utf-8"))["hooks"]
    seen = {}
    monkeypatch.setattr(kit.subprocess, "run", lambda command, **_: seen.setdefault("command", command) and argparse.Namespace(returncode=1, stderr="stop", stdout=""))
    with pytest.raises(SystemExit):
        kit.run_capture(config)
    folders = [seen["command"][i + 1] for i, word in enumerate(seen["command"]) if word == "--chat-folder"]
    assert folders == config["chat_folders"]


def test_no_panel_folder_leaves_it_alone(home: Path) -> None:
    root = home / "ReadingRoom"
    args = setup_args(root)
    args.no_panel_folder = True
    kit.setup(args)
    assert not (home / "Zotero-Agent").exists() and len(json.loads((root / "reading_room.json").read_text(encoding="utf-8"))["chat_folders"]) == 2


class Reply:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def __enter__(self) -> "Reply":
        return self

    def __exit__(self, *_: object) -> None:
        pass

    def read(self) -> bytes:
        return self.data


def test_a_plugin_with_the_wrong_hash_is_never_saved(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    good = b"plugin bytes"
    digest = kit.hashlib.sha256(good).hexdigest()
    monkeypatch.setattr(kit.urllib.request, "urlopen", lambda url, timeout: Reply(b"tampered"))
    with pytest.raises(SystemExit):
        kit.download("https://example.invalid/p.xpi", digest, tmp_path / "p.xpi")
    assert not (tmp_path / "p.xpi").exists()
    monkeypatch.setattr(kit.urllib.request, "urlopen", lambda url, timeout: Reply(good))
    assert kit.download("https://example.invalid/p.xpi", digest, tmp_path / "p.xpi") == "downloaded, hash checked"
    assert kit.download("https://example.invalid/p.xpi", digest, tmp_path / "p.xpi") == "already here, hash checked"


def test_the_pinned_plugins_are_the_audited_releases() -> None:
    assert {name: url.split("/download/")[1] for name, (url, _) in kit.THIRD_PARTY.items()} == {
        "zotero-agent.xpi": "v0.15.2/zotero-agent.xpi", "zotero-annotation-markdown.xpi": "v0.16.4/zotero-annotation-markdown.xpi"}


def test_the_papers_only_job_runs_the_swap_every_thirty_minutes(tmp_path: Path) -> None:
    job = kit.launch_agent(tmp_path, papers_only=True)
    assert job["StartInterval"] == 1800 and job["ProgramArguments"][-1] == "swap" and job["ProgramArguments"][2].endswith("papers.py")
    assert job["Label"] != kit.launch_agent(tmp_path)["Label"], "the two jobs can live side by side"


def test_the_mac_job_runs_sync_every_ten_minutes(tmp_path: Path) -> None:
    job = kit.launch_agent(tmp_path)
    assert job["StartInterval"] == 600 and job["ProgramArguments"][-1] == "sync" and str(tmp_path) in job["ProgramArguments"]
    assert kit.plistlib.loads(kit.plistlib.dumps(job)) == job


def test_the_mac_job_finds_homebrew_git(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """launchd gives a job only the system folders, so the job carries the terminal's PATH and Homebrew's."""
    monkeypatch.setenv("PATH", kit.os.pathsep.join(["/Users/me/.pyenv/shims", "/usr/bin"]))
    path = kit.launch_agent(tmp_path)["EnvironmentVariables"]["PATH"].split(kit.os.pathsep)
    assert path[0] == "/Users/me/.pyenv/shims" and "/opt/homebrew/bin" in path and "/usr/local/bin" in path
    assert path.count("/usr/bin") == 1


@pytest.mark.parametrize(("platform", "tool", "hint"), [("darwin", "node", "brew install node"), ("darwin", "claude", "curl -fsSL https://claude.ai/install.sh | bash"), ("win32", "uv", "winget install astral-sh.uv")])
def test_missing_tools_get_a_fix_for_this_machine(home: Path, monkeypatch: pytest.MonkeyPatch, platform: str, tool: str, hint: str) -> None:
    monkeypatch.setattr(kit.sys, "platform", platform)
    assert kit.install_hint(tool) == hint


def test_sync_swaps_pdfs_only_when_a_papers_folder_is_set(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    monkeypatch.setattr(kit.subprocess, "run", lambda command, **_: calls.append(command) or argparse.Namespace(returncode=0, stdout='{"copied": 1}', stderr=""))
    assert kit.swap_papers({"root": str(home), "papers_folder": ""}) == [] and not calls
    lines = kit.swap_papers({"root": str(home), "papers_folder": str(home / "iCloud" / "Zotero PDFs")})
    assert [command[5:8] for command in calls] == [["share", "--to", str(home / "iCloud" / "Zotero PDFs")], ["fetch", "--from", str(home / "iCloud" / "Zotero PDFs")]]
    assert all(command[-1] == "--execute" and command[1] == "-I" for command in calls) and lines[1] == 'papers fetch: {"copied": 1}'


def test_setup_records_the_papers_folder(home: Path) -> None:
    root = home / "ReadingRoom"
    args = setup_args(root)
    args.papers_folder = str(home / "iCloud" / "Zotero PDFs")
    kit.setup(args)
    assert json.loads((root / "reading_room.json").read_text(encoding="utf-8"))["papers_folder"] == str(home / "iCloud" / "Zotero PDFs")
