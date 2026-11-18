// The text handling in tools.js. Run with: node --test plugin/test_tools.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const context = { URL, encodeURIComponent };
vm.runInNewContext(readFileSync(new URL("./tools.js", import.meta.url), "utf8"), context);
const tools = context.RRTools;

test("inline math becomes a note math span", () => {
  assert.equal(tools.mathInText("rate $k_f$ here"), 'rate <span class="math">$k_f$</span> here');
});

test("display math in a line stays in the line, set in display style", () => {
  assert.equal(tools.mathInText("a $$x^2$$ b"), 'a <span class="math" data-display="1">$\\displaystyle x^2$</span> b');
});

test("prices and escaped dollars are not math", () => {
  for (const text of ["costs $5 and $6", "\\$5 and \\$6", "just $ one"]) {
    assert.equal(tools.mathInText(text), text);
  }
});

test("HTML in text is escaped before math is found", () => {
  assert.equal(tools.mathInText(tools.escape("$a<b$ & c")), '<span class="math">$a&lt;b$</span> &amp; c');
});

test("answers keep paragraphs, lists, code, headings and links", () => {
  const html = tools.markdownHTML("# Title\n\nA **bold** and *soft* `code` line.\n\n- one\n- two\n\n1. first\n2. second\n\n[Paper](zotero://select/library/items/ABCD1234)");
  assert.equal(html, '<h3>Title</h3><p>A <strong>bold</strong> and <em>soft</em> <code>code</code> line.</p><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol><p><a href="zotero://select/library/items/ABCD1234">Paper</a></p>');
});

test("a display equation alone becomes a math block", () => {
  assert.equal(tools.markdownHTML("$$a + b$$"), '<pre class="math">$$a + b$$</pre>');
});

test("a code block is kept as it is", () => {
  assert.equal(tools.markdownHTML("```python\nx = 1 < 2\n```"), "<pre>x = 1 &lt; 2</pre>");
});

test("a link with an unknown scheme stays as text", () => {
  assert.ok(!tools.markdownHTML("[bad](javascript:alert(1))").includes("<a "));
});

test("wiki links become Obsidian links in a note", () => {
  const html = tools.markdownHTML("[Soot](zotero://rr-wiki/open?path=D%3A%5CWiki%5CSoot.md)");
  assert.equal(html, '<p><a href="obsidian://open?path=D%3A%5CWiki%5CSoot.md">Soot</a></p>');
});

test("only Markdown pages open from a wiki link", () => {
  assert.equal(tools.wikiURL("zotero://rr-wiki/open?path=D%3A%5CWiki%5CSoot.md"), "obsidian://open?path=D%3A%5CWiki%5CSoot.md");
  assert.equal(tools.wikiURL("zotero://rr-wiki/open?path=C%3A%5Cevil.exe"), null);
  assert.equal(tools.wikiURL("zotero://rr-wiki/open"), null);
});

test("each saved answer is marked as unchecked", () => {
  const html = tools.turnsHTML([{ question: "Why $x$?", page: "12", answer: "Because." }]);
  assert.ok(html.includes("Question (p.12):") && html.includes('<span class="math">$x$</span>'));
  assert.ok(html.includes("Agent answer, not checked."));
});

test("no turns adds nothing", () => {
  assert.equal(tools.turnsHTML([]), "");
});
