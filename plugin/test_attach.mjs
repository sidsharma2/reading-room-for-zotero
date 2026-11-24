// The plain functions in attach.js, and what it does with a drop or a paste. Run with: node --test plugin/test_attach.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function load(extra = {}) {
  const context = { ...extra };
  vm.runInNewContext(readFileSync(new URL("./attach.js", import.meta.url), "utf8"), context);
  return context.RRAttach;
}
const attach = load();

test("pictures, documents and the rest are told apart by extension", () => {
  for (const name of ["a.png", "B.JPG", "c.webp"]) {
    assert.equal(attach.kind(name), "picture");
  }
  for (const name of ["a.pdf", "B.DOCX", "slides.pptx", "data.csv", "refs.bib", "script.py"]) {
    assert.equal(attach.kind(name), "document");
  }
  for (const name of ["setup.exe", "run.bat", "macro.docm", "old.doc", "archive.zip", "folder", "", ".pdf.exe"]) {
    assert.equal(attach.kind(name), "");
  }
});

test("a file name needs no quoting and cannot leave the folder", () => {
  assert.equal(attach.safeName("Paper (local full version).pdf"), "Paper-local-full-version.pdf");
  assert.equal(attach.safeName("Étude de la suie.PDF"), "Etude-de-la-suie.pdf");
  assert.equal(attach.safeName("../../etc/passwd.txt"), "etc-passwd.txt");
  assert.equal(attach.safeName("C:\\Users\\me\\x.pdf"), "C-Users-me-x.pdf");
  assert.equal(attach.safeName("-rf.txt"), "rf.txt");
  assert.equal(attach.safeName("论文.pdf"), "file.pdf");
  assert.equal(attach.safeName("CON.txt"), "file-CON.txt");
  assert.equal(attach.safeName("a$(whoami)`x`;b.pdf"), "a-whoami-x-b.pdf");
  assert.equal(attach.safeName("under_score v1.2.pdf"), "under_score-v1.2.pdf");
  assert.ok(attach.safeName(`${"x".repeat(300)}.pdf`).length <= 84);
  for (const name of ["a\nb.pdf", "x\u202Efdp.pdf", "  spaced  .pdf", "...hidden.pdf"]) {
    assert.match(attach.safeName(name), /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  }
});

test("PDF pages are marked, and a scan has no text", () => {
  assert.deepEqual({ ...attach.markPages("one\ftwo\f") }, { body: "[p.1]\n\none\n\n[p.2]\n\ntwo", pages: 2 });
  assert.deepEqual({ ...attach.markPages("one\f \fthree\f") }, { body: "[p.1]\n\none\n\n[p.2]\n\n(no text on this page: a scan or a picture)\n\n[p.3]\n\nthree", pages: 3 });
  assert.deepEqual({ ...attach.markPages("\f\f") }, { body: "", pages: 2 });
});

test("Word text keeps paragraphs, tabs and breaks, and leaves out deleted text and tab stops", () => {
  const xml = "<w:document><w:body><w:p><w:pPr><w:tabs><w:tab w:val=\"left\"/></w:tabs></w:pPr><w:r><w:t>Soot &amp; NO</w:t></w:r><w:r><w:t xml:space=\"preserve\">x </w:t><w:tab/><w:t>a&lt;b</w:t></w:r></w:p>"
    + "<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p><w:p></w:p></w:body></w:document>";
  assert.equal(attach.officeText("docx", { "word/document.xml": xml }), "Soot & NOx \ta<b\n\none\ntwo");
});

test("Word footnotes and endnotes follow the text, where reference lists often are", () => {
  const part = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const text = attach.officeText("docx", { "word/endnotes.xml": part("[1] A paper"), "word/document.xml": part("Body") });
  assert.equal(text, "Body\n\n[endnotes]\n\n[1] A paper");
});

test("slides come in number order", () => {
  const slide = (text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
  const text = attach.officeText("pptx", { "ppt/slides/slide10.xml": slide("ten"), "ppt/slides/slide2.xml": slide("two"), "ppt/slides/slide1.xml": "" });
  assert.equal(text, "[slide 1]\n\n(no text on this slide)\n\n[slide 2]\n\ntwo\n\n[slide 10]\n\nten");
});

test("only the parts with text are read from an Office file", () => {
  assert.ok(attach.partsWanted("docx").test("word/document.xml"));
  assert.ok(!attach.partsWanted("docx").test("word/vbaProject.bin"));
  assert.ok(!attach.partsWanted("docx").test("../word/document.xml"));
  assert.ok(attach.partsWanted("pptx").test("ppt/slides/slide12.xml"));
  assert.ok(!attach.partsWanted("pptx").test("ppt/slides/_rels/slide1.xml.rels"));
});

test("odd character references do not break the text", () => {
  assert.equal(attach.entities("&#956;m &#x3C7; &#0; &#x110000; &nbsp; &amp;lt;"), "μm χ &#0; &#x110000; &nbsp; &lt;");
});

test("the line says what the agent needs", () => {
  assert.equal(attach.line("Paper.pdf"), "Attached: uploads/Paper.pdf");
  assert.equal(attach.line("Paper.pdf", { pages: 15, text: true }), "Attached: uploads/Paper.pdf (15 pages, text in Paper.pdf.txt)");
  assert.equal(attach.line("Scan.pdf", { pages: 1, scan: true }), "Attached: uploads/Scan.pdf (1 page, no text layer)");
  assert.equal(attach.line("a.docx", { pages: 0, text: true }), "Attached: uploads/a.docx (text in a.docx.txt)");
});

test("lines go below the question, one under another", () => {
  const one = attach.withLine("", "Attached: uploads/a.pdf");
  assert.equal(one, "\n\nAttached: uploads/a.pdf");
  assert.equal(attach.withLine(one, "Attached: uploads/b.pdf"), "\n\nAttached: uploads/a.pdf\nAttached: uploads/b.pdf");
  assert.equal(attach.withLine("What is this?  ", "Attached: uploads/a.pdf"), "What is this?\n\nAttached: uploads/a.pdf");
});

test("a name that starts like another is a different file", () => {
  const value = "Attached: uploads/a.json\nAttached: uploads/b.pdf (3 pages)";
  assert.ok(!attach.hasFile(value, "a.js"));
  assert.ok(attach.hasFile(value, "a.json"));
  assert.ok(attach.hasFile(value, "b.pdf"));
  assert.equal(attach.lineAt(value, "Attached: uploads/a.js"), -1);
  assert.equal(attach.lineAt("x\nAttached: uploads/b.pdf", "Attached: uploads/b.pdf"), 2);
});

test("the tiles show the files that the box names, and only those", () => {
  const value = "What is this?\n\nAttached: uploads/a.pdf (15 pages, text in a.pdf.txt)\nAttached: uploads/b.csv\nsee Attached: uploads/c.pdf\nAttached: uploads/../d.pdf";
  assert.deepEqual([...attach.filesIn(value)].map((file) => `${file.name}|${file.pages}`), ["a.pdf|15 pages", "b.csv|"]);
  assert.deepEqual([...attach.filesIn("")], []);
});

test("leaving a file out takes its line and nothing else", () => {
  const value = "What is this?\n\nAttached: uploads/a.json\nAttached: uploads/a.js (1 page)";
  assert.equal(attach.withoutFile(value, "a.js"), "What is this?\n\nAttached: uploads/a.json");
  assert.equal(attach.withoutFile(attach.withoutFile(value, "a.js"), "a.json"), "What is this?");
  assert.equal(attach.withoutFile("\n\nAttached: uploads/a.pdf", "a.pdf"), "");
  assert.equal(attach.withoutFile(value, "missing.pdf"), value);
});

test("a drag that starts in Zotero stays the panel's own", () => {
  const files = [{ name: "a.pdf" }];
  assert.equal(attach.filesOf({ types: ["Files"], files }).length, 1);
  assert.equal(attach.filesOf({ types: ["application/x-moz-file", "Files"], files }).length, 1);
  assert.equal(attach.filesOf({ types: ["zotero/item", "Files"], files }).length, 0);
  assert.equal(attach.filesOf({ types: ["text/plain"], files: [] }).length, 0);
  assert.equal(attach.filesOf(null).length, 0);
});

function host() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (type, handler) => (handlers[type] = handler),
    removeEventListener: (type) => delete handlers[type],
  };
}

function event(data, path = []) {
  return { dataTransfer: data, clipboardData: data, prevented: false, preventDefault() { this.prevented = true; }, composedPath: () => path };
}

test("a drop on the message box leaves its pictures to the panel, and a drop elsewhere does not", () => {
  const own = load();
  const calls = [];
  own.take = (win, files, options) => calls.push([files.map((file) => file.name), options.pictures]);
  const shown = [];
  own.showDrop = (win, on) => shown.push(on);
  let copies = 0;
  own.asCopy = () => copies++;
  const target = host();
  const stop = own.watch(target, {});
  const data = { types: ["Files"], files: [{ name: "a.png" }, { name: "b.pdf" }] };
  const onBox = event(data, [{ classList: { contains: (name) => name === "composer" } }]);
  target.handlers.drop(onBox);
  const onFeed = event(data, [{ classList: { contains: () => false } }, {}]);
  target.handlers.drop(onFeed);
  assert.deepEqual(calls.map(([names, pictures]) => [names.join(), pictures]), [["a.png,b.pdf", false], ["a.png,b.pdf", true]]);
  assert.ok(onBox.prevented && onFeed.prevented);
  assert.equal(copies, 2, "the source must not be told that its file was moved");
  shown.length = 0;
  const over = event({ types: ["Files"], files: [] }); // while dragging, the files themselves are not listed
  target.handlers.dragover(over);
  target.handlers.dragleave();
  const words = event({ types: ["text/plain"], files: [] });
  target.handlers.dragover(words);
  assert.deepEqual([shown.join(), over.prevented, words.prevented], ["true,false", true, false]);
  stop();
  assert.deepEqual(Object.keys(target.handlers), []);
});

test("a paste with a document is taken, and pictures and text are left to the panel", () => {
  const own = load();
  const calls = [];
  own.take = (win, files) => calls.push(files.map((file) => file.name).join());
  const target = host();
  own.watch(target, {});
  const document_ = event({ types: ["Files"], files: [{ name: "b.pdf" }] });
  const picture = event({ types: ["Files"], files: [{ name: "image.png" }] });
  const text = event({ types: ["text/plain"], files: [] });
  [document_, picture, text].forEach((each) => target.handlers.paste(each));
  assert.deepEqual(calls, ["b.pdf"]);
  assert.deepEqual([document_, picture, text].map((each) => each.prevented), [true, false, false]);
});

test("the chat folder is the panel's setting, else its default", () => {
  const services = (forced) => ({ Services: { env: { get: () => forced } } });
  const zotero = (value) => ({ Zotero: { Prefs: { get: () => value } } });
  assert.equal(load({ ...zotero('{"chatFolder":"/rr/chat"}'), ...services("") }).chatFolder(), "/rr/chat");
  assert.equal(load({ ...zotero("not json"), ...services("/test") }).chatFolder(), "/test");
});

test("what cannot be attached is refused with a reason, and the rest still goes in", async () => {
  const notes = [];
  const own = load({ RRTools: { notify: (win, title, body) => notes.push(body), panelRoot: () => ({ querySelector: () => ({ value: "" }) }) }, Zotero: { debug() {} } });
  own.copyIn = async (file) => file.name;
  own.writeText = async () => ({});
  own.setBox = () => {};
  own.tiles = () => {};
  own.chatFolder = () => "/rr";
  Object.assign(own, { box: () => ({ value: "" }) });
  const context = { PathUtils: { join: (...parts) => parts.join("/") }, IOUtils: { makeDirectory: async () => {} } };
  const withFiles = load({ ...context, RRTools: { notify: (win, title, body) => notes.push(body) }, Zotero: { debug() {} } });
  Object.assign(withFiles, { copyIn: own.copyIn, writeText: own.writeText, setBox: own.setBox, tiles: own.tiles, flash: own.tiles, chatFolder: own.chatFolder, box: own.box });
  const files = [{ name: "a.pdf", size: 10 }, { name: "run.exe", size: 10 }, { name: "big.pdf", size: 200 * 1024 * 1024 }];
  const done = await withFiles.take({}, files, { pictures: false });
  assert.deepEqual([...done.attached].map((each) => each.name), ["a.pdf"]);
  assert.equal(done.refused.length, 2);
  assert.match(notes.join(), /run\.exe: the chat takes PDF/);
  assert.match(notes.join(), /big\.pdf: larger than 100 MB/);
});
