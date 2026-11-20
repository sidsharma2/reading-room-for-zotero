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
  assert.deepEqual(plain(slim), { id: "W12", doi: "10.1000/ab", title: "Soot in flames", year: 2014, cites: 7, authors: ["Person 1", "Person 2", "Person 3"], more: true, venue: "Combust. Flame", oa: "https://example.org/a.pdf", refs: ["W1"], abstract: "" });
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

test("a work keeps its abstract, cut to a size that stays small offline", () => {
  const slim = C.slim({ id: "W1", display_name: "T", abstract_inverted_index: { Soot: [0], forms: [1], "<b>late</b>": [2] } });
  assert.equal(slim.abstract, "Soot forms late");
  const long = C.slim({ id: "W1", display_name: "T", abstract_inverted_index: Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`w${i}`, [i]])) });
  assert.ok(long.abstract.length <= C.ABSTRACT_CHARS);
});

test("a kept answer is used while fresh, asked again when old, and used however old when the network fails", async () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  let asked = 0;
  const ask = async () => { asked++; return { retrieved_at: now, sections: "new" }; };
  const fail = async () => { throw new Error("offline"); };
  assert.equal((await C.keptOr({ retrieved_at: now, sections: "kept" }, ask)).sections, "kept");
  assert.equal(asked, 0);
  assert.equal((await C.keptOr({ retrieved_at: old, sections: "kept" }, ask)).sections, "new");
  assert.equal((await C.keptOr({ retrieved_at: now, sections: "kept" }, ask, true)).sections, "new");
  const stale = await C.keptOr({ retrieved_at: old, sections: "kept" }, fail);
  assert.equal(stale.sections, "kept");
  assert.equal(stale.stale, true);
  assert.match(C.offlineNote(stale), /^Offline: showing what OpenAlex said on \d{4}-\d{2}-\d{2}\.$/);
  await assert.rejects(C.keptOr(null, fail), /offline/);
});

test("warm-up takes papers never fetched first, then the oldest, and skips fresh ones and ones it cannot place", () => {
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const rows = [
    { key: "FRESH001", doi: "10.1/a", added: "2024-01-01" },
    { key: "OLD00001", doi: "10.1/b", added: "2024-01-01" },
    { key: "NEVER001", doi: "10.1/c", added: "2020-01-01" },
    { key: "NEVER002", doi: "10.1/d", added: "2023-01-01" },
    { key: "NOIDEA01", doi: "", title: "short", added: "2025-01-01" },
  ];
  const queue = C.warmQueue(rows, { FRESH001: recent, OLD00001: old });
  assert.deepEqual(plain(queue.map((row) => row.key)), ["NEVER002", "NEVER001", "OLD00001"]);
  assert.equal(C.warmQueue(rows, {}, 1).length, 1);
});

test("a saved paper keeps only plain, checked fields, and is saved once", () => {
  const entry = C.laterEntry({ wid: "W9", doi: "https://doi.org/10.1000/X", title: "<b>Soot</b> paper", authors: ["A", "B", "C", "D"], year: 2021,
    oa: "javascript:alert(1)", abstract: "text", cites: "12", junk: "dropped" }, { key: "ABCD1234", title: "From here" }, "2026-11-18T00:00:00Z");
  assert.deepEqual(plain(entry), { id: "W9", wid: "W9", doi: "10.1000/x", title: "Soot paper", authors: ["A", "B", "C"], more: false, year: 2021, venue: "", cites: 12,
    oa: "", abstract: "text", from: { key: "ABCD1234", title: "From here" }, saved_at: "2026-11-18T00:00:00Z" });
  const byDOI = C.laterEntry({ doi: "10.2000/y", title: "No OpenAlex id" }, { key: "bad key" });
  assert.equal(byDOI.id, "doi:10.2000/y");
  assert.equal(byDOI.from.key, "");
  let list = C.laterAdd([], entry);
  list = C.laterAdd(list, entry);
  list = C.laterAdd(list, C.laterEntry({ wid: "W10", doi: "10.1000/x", title: "Same DOI" }));
  assert.equal(list.length, 1);
  assert.equal(C.laterAdd(list, C.laterEntry({ wid: "W11" })).length, 1); // no title, not saved
  assert.equal(C.laterRemove(C.laterAdd(list, byDOI), "W9").length, 1);
});

test("saved papers show as a web marked against the library, and other webs mark what is saved", () => {
  const library = C.makeLibrary([{ key: "HAVE0001", title: "A paper already held in the library here", doi: "10.1000/held", have: true }]);
  const list = [C.laterEntry({ wid: "W1", doi: "10.1000/held", title: "A paper already held in the library here" }), C.laterEntry({ doi: "10.1000/new", title: "New one", year: 2020 }, { title: "Focal" })];
  const web = C.laterWeb(list, library);
  assert.equal(web.mode, "later");
  assert.equal(web.laterCount, 2);
  assert.deepEqual(plain(web.nodes.map((node) => [node.id, node.mark, node.saved])), [["W1", "have", true], ["doi:10.1000/new", "new", true]]);
  assert.match(web.nodes[1].note, /^Found from Focal, saved \d{4}-\d{2}-\d{2}$/);
  const other = C.markSaved({ nodes: [{ id: "W1", wid: "W1", doi: "" }, { id: "W5", wid: "W5", doi: "10.1000/new" }, { id: "W6", wid: "W6", doi: "" }] }, list);
  assert.deepEqual(plain(other.nodes.map((node) => node.saved)), [true, true, false]);
});

test("a message ends as a sentence before the next one starts", () => {
  assert.equal(C.sentence("Zotero is offline"), "Zotero is offline.");
  assert.equal(C.sentence("Done."), "Done.");
});

test("a paper OpenAlex could not match counts as tried, so warm-up moves on to others", () => {
  const now = new Date().toISOString();
  const rows = ["NOMATCH1", "NOMATCH2", "FRESHNEW"].map((key, i) => ({ key, doi: `10.1000/${i}`, added: "2024-01-01" }));
  const items = { NOMATCH1: { at: now, work: null }, NOMATCH2: { at: now, work: null }, FRESHNEW: { at: now, work: { id: "W1" } } };
  const tried = C.warmTried({}, items);
  assert.deepEqual(plain(C.warmQueue(rows, tried).map((row) => row.key)), ["FRESHNEW"]);
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  assert.equal(C.warmTried({ NOMATCH1: now }, { NOMATCH1: { at: old, work: null } }).NOMATCH1, now);
  assert.deepEqual(plain(C.warmQueue(rows.slice(0, 1), C.warmTried({}, { NOMATCH1: { at: old, work: null } })).map((row) => row.key)), ["NOMATCH1"]);
});

test("papers that reached the library some other way leave the Check later list", () => {
  const library = C.makeLibrary([{ key: "HAVE0001", title: "Held", doi: "10.1000/held", have: true }]);
  const list = [C.laterEntry({ doi: "10.1000/held", title: "Held" }), C.laterEntry({ doi: "10.1000/new", title: "Still to check" })];
  const { list: left, owned } = C.laterReconcile(list, library);
  assert.deepEqual(plain(left.map((entry) => entry.doi)), ["10.1000/new"]);
  assert.deepEqual(plain(owned.map((entry) => entry.doi)), ["10.1000/held"]);
});
