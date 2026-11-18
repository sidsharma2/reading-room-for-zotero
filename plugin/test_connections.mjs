// The plain functions in connections.js. Run with: node --test plugin/test_connections.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const context = {};
vm.runInNewContext(readFileSync(new URL("./connections.js", import.meta.url), "utf8"), context);
const C = context.RRConnections;
const plain = (value) => JSON.parse(JSON.stringify(value));

const work = (id, title, extra = {}) => ({ id, doi: "", title, year: 2020, cites: 10, authors: ["A. Author"], more: false, venue: "", oa: "", refs: [], ...extra });

test("DOIs are found in the field, in Extra and in a doi.org link, and lower-cased", () => {
  assert.equal(C.doiFrom({ DOI: "10.1016/J.CombustFlame.2014.09.025" }), "10.1016/j.combustflame.2014.09.025");
  assert.equal(C.doiFrom({ extra: "tex.ids: x\nDOI: 10.1234/ABC.5." }), "10.1234/abc.5");
  assert.equal(C.doiFrom({ url: "https://doi.org/10.5555/xyz)" }), "10.5555/xyz");
  assert.equal(C.doiFrom({ url: "https://example.com/10.5555/xyz" }), "");
});

test("an OpenAlex record becomes a small work with W ids", () => {
  const slim = C.slim({
    id: "https://openalex.org/W12", doi: "https://doi.org/10.1000/AB", display_name: "Soot <i>in</i>  flames", publication_year: 2014, cited_by_count: 7,
    authorships: [1, 2, 3, 4].map((n) => ({ author: { display_name: `Person ${n}` } })), primary_location: { source: { display_name: "Combust. Flame" } },
    open_access: { oa_url: "https://example.org/a.pdf" }, referenced_works: ["https://openalex.org/W1", "junk"],
  });
  assert.deepEqual(plain(slim), { id: "W12", doi: "10.1000/ab", title: "Soot in flames", year: 2014, cites: 7, authors: ["Person 1", "Person 2", "Person 3"], more: true, venue: "Combust. Flame", oa: "https://example.org/a.pdf", refs: ["W1"] });
});

test("the abstract is rebuilt from OpenAlex's word index", () => {
  assert.equal(C.abstract({ soot: [1], Ethylene: [0], forms: [2] }), "Ethylene soot forms");
  assert.equal(C.abstract(null), "");
});

test("library matching goes by work id, then DOI, then a long exact title, never a near one", () => {
  const rows = [
    { key: "AAAAAAAA", title: "A long enough title about soot inception", doi: "10.1/a", have: true },
    { key: "BBBBBBBB", title: "Short", doi: "", have: false, wid: "W9" },
    { key: "CCCCCCCC", title: "Twin title that appears twice in this library", doi: "", have: true },
    { key: "DDDDDDDD", title: "Twin title that appears twice in this library", doi: "", have: true },
  ];
  const library = C.makeLibrary(rows);
  assert.equal(C.find(library, work("W1", "x", { doi: "10.1/a" })).key, "AAAAAAAA");
  assert.equal(C.find(library, work("W9", "anything")).key, "BBBBBBBB");
  assert.equal(C.find(library, work("W2", "A LONG enough title, about soot inception")).key, "AAAAAAAA");
  assert.equal(C.find(library, work("W3", "Short")), null);
  assert.equal(C.find(library, work("W4", "Twin title that appears twice in this library")), null);
  assert.deepEqual([rows[0], rows[1], null].map((row) => C.mark(row)), ["have", "wanted", "new"]);
});

test("similar in the library needs shared rare words and leaves out the paper itself", () => {
  const rows = [
    { key: "F", title: "Soot inception by aromatic dimerization in ethylene flames", abstract: "PAH dimers", tags: ["soot"] },
    { key: "G", title: "Aromatic dimerization and soot inception rates", abstract: "PAH dimers nucleate soot", tags: ["soot"] },
    { key: "H", title: "Wind tunnel blockage corrections", abstract: "wall interference", tags: [] },
    { key: "I", title: "Ethylene flame temperature measurements", abstract: "thermocouple", tags: [] },
  ];
  const found = C.similarInLibrary(rows[0], rows).map(({ row }) => row.key);
  assert.equal(found[0], "G");
  assert.ok(!found.includes("F") && !found.includes("H"));
});

test("the paper web links the paper to its groups and papers to each other", () => {
  const library = C.makeLibrary([{ key: "KEYAAAAA", title: "Focal paper about soot", doi: "10.1/f", have: true, wid: "W100" }, { key: "KEYBBBBB", title: "A cited paper that I hold already here", doi: "10.1/r1", have: false }]);
  const focal = work("W100", "Focal paper about soot", { doi: "10.1/f" });
  const sections = {
    references: [work("W1", "A cited paper that I hold already here", { doi: "10.1/r1" }), work("W2", "Another cited paper")],
    citing: [work("W3", "A citing paper", { refs: ["W100", "W2"] })],
    related: [work("W2", "Another cited paper")],
  };
  const web = C.paperWeb(focal, library.byKey.get("KEYAAAAA"), sections, library, []);
  const byId = Object.fromEntries(web.nodes.map((node) => [node.id, node]));
  assert.equal(web.focal, "W100");
  assert.equal(byId.W100.mark, "have");
  assert.equal(byId.W1.mark, "wanted");
  assert.equal(byId.W1.key, "KEYBBBBB");
  assert.deepEqual(plain(byId.W2.groups), ["references", "related"]);
  const edges = web.edges.map((edge) => `${edge.source}>${edge.target}:${edge.kind}`);
  assert.ok(edges.includes("W100>W1:cites") && edges.includes("W3>W100:cites") && edges.includes("W3>W2:cites") && edges.includes("W100>W2:cites"));
  assert.ok(!edges.includes("W100>W2:similar"), "one line per pair, and citing wins");
  assert.equal(new Set(edges.map((edge) => edge.split(":")[0])).size, edges.length, "no edge twice");
  assert.ok(web.nodes.every((node) => !("refs" in node)));
});

test("a paper OpenAlex does not know still gets its library neighbours", () => {
  const rows = [{ key: "KEYAAAAA", title: "Soot inception by dimerization", doi: "", have: true }, { key: "KEYBBBBB", title: "Dimerization of PAH and soot inception", doi: "", have: true, creators: ["Smith"] }];
  const library = C.makeLibrary(rows);
  const local = C.similarInLibrary(rows[0], rows);
  const web = C.paperWeb({ id: "", title: rows[0].title, refs: [] }, rows[0], {}, library, local);
  assert.equal(web.focal, "zotero:KEYAAAAA");
  assert.equal(web.nodes[1].id, "zotero:KEYBBBBB");
  assert.equal(web.edges[0].kind, "words");
});

test("the library map counts how many of your papers cite each outside paper", () => {
  const mine = [work("W1", "Mine one", { refs: ["W2", "W50", "W51"] }), work("W2", "Mine two", { refs: ["W50", "W51"] }), work("W3", "Mine three", { refs: ["W50"] })];
  const ids = new Set(mine.map((item) => item.id));
  assert.deepEqual(plain(C.mostCited(mine, ids)), [["W50", 3], ["W51", 2]]);
  const library = C.makeLibrary([]);
  const web = C.libraryWeb(mine, library, [{ work: work("W50", "Classic"), count: 3 }], [{ work: work("W60", "Newer", { refs: ["W1", "W3"] }), count: 2 }]);
  const edges = web.edges.map((edge) => `${edge.source}>${edge.target}`);
  assert.ok(edges.includes("W1>W2") && edges.includes("W3>W50") && edges.includes("W60>W1"));
  assert.equal(web.nodes.find((node) => node.id === "W50").note, "cited by 3 of your papers");
});

test("the chat's copy keeps the sections and the library marks", () => {
  const library = C.makeLibrary([{ key: "KEYAAAAA", title: "Focal", doi: "10.1/f", have: true }]);
  const web = C.paperWeb(work("W100", "Focal", { doi: "10.1/f" }), library.byKey.get("KEYAAAAA"), { references: [work("W1", "Cited one", { doi: "10.1/c" })] }, library, []);
  const entry = C.agentEntry(web, library.byKey.get("KEYAAAAA"));
  assert.deepEqual(plain(entry.sections.references.works), [{ title: "Cited one", doi: "10.1/c", year: 2020, mark: "new", zotero_key: "" }]);
  assert.equal(entry.focal.zotero_key, "KEYAAAAA");
});

test("requests are split into groups of at most 100 ids", () => {
  assert.deepEqual(plain(C.chunks([1, 2, 3, 4, 5], 2)), [[1, 2], [3, 4], [5]]);
});
