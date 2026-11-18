// The plain functions in organise.js. Run with: node --test plugin/test_organise.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const context = {};
vm.runInNewContext(readFileSync(new URL("./organise.js", import.meta.url), "utf8"), context);
const O = context.RROrganise;
const plain = (value) => JSON.parse(JSON.stringify(value));

const CSV = "﻿key,title,proposed topic,retire collection\r\n"
  + "AAAAAAAA,\"Soot, and more \"\"soot\"\"\",Soot formation and combustion chemistry,\r\n"
  + "BBBBBBBB,\"A title\nover two lines\",Full-scale Turbofans,\r\n"
  + "CCCCCCCC,Unsorted,To sort by hand,\r\n"
  + "DDDDDDDD,Gone,Soot formation and combustion chemistry,\r\n"
  + "EEEEEEEE,Filed already,Soot formation and combustion chemistry,\r\n"
  + ",,,Old import\r\n"
  + ",,,Projects / Rigs & fuels\r\n"
  + ",,,No such collection\r\n";

const COLLECTIONS = [
  { id: 1, path: "Full-scale Turbofans", items: [] },
  { id: 2, path: "Old import", items: [] },
  { id: 3, path: "Old import / library", items: ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"] },
  { id: 4, path: "Projects", items: [] },
  { id: 5, path: "Projects / Rigs & fuels", items: [] },
  { id: 6, path: "Topics", items: [] },
  { id: 7, path: "Topics / Soot formation and combustion chemistry", items: ["EEEEEEEE"] },
];
const KEYS = new Set(["AAAAAAAA", "BBBBBBBB", "CCCCCCCC", "EEEEEEEE"]);

test("the CSV keeps commas, quotes and line breaks inside a field, and drops the byte-order mark", () => {
  const rows = O.parseCSV(CSV);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].key, "AAAAAAAA");
  assert.equal(rows[0].title, 'Soot, and more "soot"');
  assert.equal(rows[1].title, "A title\nover two lines");
});

test("the plan files each item once, uses an existing top-level collection, and skips what it cannot place", () => {
  const plan = O.plan(O.parseCSV(CSV), COLLECTIONS, KEYS);
  assert.deepEqual(plain(plan.create), []);
  assert.deepEqual(plain(plan.adds), [
    { path: "Topics / Soot formation and combustion chemistry", keys: ["AAAAAAAA"] },
    { path: "Full-scale Turbofans", keys: ["BBBBBBBB"] },
  ]);
  assert.deepEqual(plain(plan.missing), ["DDDDDDDD"]);
  assert.equal(plan.total, 2, "the unsorted row and the item already filed are left alone");
});

test("new topic collections are made under Topics, which is made first", () => {
  const plan = O.plan(O.parseCSV(CSV), COLLECTIONS.filter((c) => !c.path.startsWith("Topics")), KEYS);
  assert.deepEqual(plain(plan.create), ["Topics", "Topics / Soot formation and combustion chemistry"]);
});

test("collections named in the retire column go to the trash, with what is inside them; unknown names are ignored", () => {
  const plan = O.plan(O.parseCSV(CSV), COLLECTIONS, KEYS);
  assert.deepEqual(plain(plan.trash), [
    { path: "Old import", id: 2, items: 0, inside: ["Old import / library (3)"] },
    { path: "Projects / Rigs & fuels", id: 5, items: 0, inside: [] },
  ]);
  assert.deepEqual(plain(O.plan(O.parseCSV(CSV), COLLECTIONS, KEYS, { retire: false }).trash), []);
});

test("only tags used just on papers are deleted; a tag on a note, or a coloured tag, stays", () => {
  const uses = [
    { tagID: 1, name: "Soot", itemKey: "AAAAAAAA", onPaper: true, type: 0 },
    { tagID: 2, name: "soot", itemKey: "BBBBBBBB", onPaper: true, type: 1 },
    { tagID: 3, name: "reading-room", itemKey: "NOTE0001", onPaper: false, type: 0 },
    { tagID: 4, name: "thesis", itemKey: "AAAAAAAA", onPaper: true, type: 0 },
    { tagID: 1, name: "Soot", itemKey: "CCCCCCCC", onPaper: true, type: 0 },
  ];
  const plan = O.keywordTags(uses, new Set(["thesis"]));
  assert.deepEqual(plain(plan.remove.map((entry) => entry.name)), ["soot", "Soot"]);
  assert.deepEqual(plain(plan.keep), ["reading-room", "thesis"]);
  assert.equal(plan.uses, 3);
  assert.deepEqual(plain(plan.remove.find((entry) => entry.name === "Soot").papers), [{ key: "AAAAAAAA", type: 0 }, { key: "CCCCCCCC", type: 0 }]);
  assert.match(O.describeTags(plan), /Delete 2 tags that are used only on papers, 3 uses in all/);
});

test("merges group by the kept copy, and pairs of different types or missing items are refused", () => {
  const items = {
    KEEP0001: { key: "KEEP0001", type: "journalArticle", title: "A paper", deleted: false },
    COPY0001: { key: "COPY0001", type: "journalArticle", title: "A paper", deleted: false },
    COPY0002: { key: "COPY0002", type: "journalArticle", title: "A paper", deleted: false },
    KEEP0002: { key: "KEEP0002", type: "journalArticle", title: "Another", deleted: false },
    CONF0001: { key: "CONF0001", type: "conferencePaper", title: "Another", deleted: false },
  };
  const rows = [
    { key: "COPY0001", "merge into": "KEEP0001" }, { key: "COPY0002", "merge into": "KEEP0001" },
    { key: "CONF0001", "merge into": "KEEP0002" }, { key: "GONE0001", "merge into": "KEEP0003" }, { key: "KEEP0001", "merge into": "" },
  ];
  const plan = O.mergePlan(rows, (key) => items[key] ?? null);
  assert.deepEqual(plain(plan.merges.map((m) => [m.keep.key, m.merge.map((item) => item.key)])), [["KEEP0001", ["COPY0001", "COPY0002"]]]);
  assert.equal(plan.problems.length, 2);
  assert.match(O.describeMerges(plan), /Merge 2 copies into "A paper"/);
});

test("a copy of another type merges only when its row says to change its type", () => {
  const items = {
    KEEP0001: { key: "KEEP0001", type: "bookSection", title: "A chapter", deleted: false },
    COPY0001: { key: "COPY0001", type: "conferencePaper", title: "A chapter", deleted: false },
    COPY0002: { key: "COPY0002", type: "journalArticle", title: "A chapter", deleted: false },
  };
  const lookup = (key) => items[key] ?? null;
  const refused = O.mergePlan([{ key: "COPY0001", "merge into": "KEEP0001" }, { key: "COPY0002", "merge into": "KEEP0001", "change type": "yes" }], lookup);
  assert.equal(refused.merges.length, 0, "one copy is not marked, so the whole group is left alone");
  const plan = O.mergePlan([{ key: "COPY0001", "merge into": "KEEP0001", "change type": "yes" }, { key: "COPY0002", "merge into": "KEEP0001", "change type": "yes" }], lookup);
  assert.deepEqual(plain(plan.merges[0].retype), [{ key: "COPY0001", from: "conferencePaper", to: "bookSection" }, { key: "COPY0002", from: "journalArticle", to: "bookSection" }]);
  assert.match(O.describeMerges(plan), /First change COPY0001 from conferencePaper, COPY0002 from journalArticle to bookSection/);
});

test("item changes set a DOI only into an empty field, trash what is listed, and leave holds alone", () => {
  const items = {
    AAAAAAAA: { key: "AAAAAAAA", title: "Found", doi: "", deleted: false, canHaveDOI: true },
    BBBBBBBB: { key: "BBBBBBBB", title: "Already has one", doi: "10.1/old", deleted: false, canHaveDOI: true },
    CCCCCCCC: { key: "CCCCCCCC", title: "A report", doi: "", deleted: false, canHaveDOI: false },
    DDDDDDDD: { key: "DDDDDDDD", title: "Not found", doi: "", deleted: false, canHaveDOI: true },
    EEEEEEEE: { key: "EEEEEEEE", title: "Has my notes", doi: "", deleted: false, canHaveDOI: true },
  };
  const rows = [
    { key: "AAAAAAAA", doi: "10.5555/ABC", action: "set doi" }, { key: "BBBBBBBB", doi: "10.5555/new", action: "set doi" },
    { key: "CCCCCCCC", doi: "10.5555/x", action: "set doi" }, { key: "DDDDDDDD", doi: "", action: "trash" },
    { key: "EEEEEEEE", doi: "", action: "hold" }, { key: "FFFFFFFF", doi: "not a doi", action: "set doi" },
  ];
  const plan = O.itemChangePlan(rows, (key) => items[key] ?? null);
  assert.deepEqual(plain(plan.setDOI), [{ key: "AAAAAAAA", title: "Found", doi: "10.5555/abc" }]);
  assert.deepEqual(plain(plan.trash), [{ key: "DDDDDDDD", title: "Not found" }]);
  assert.equal(plan.skipped.length, 3, "the item with a DOI, the report with no DOI field, and the key not in the library");
  const text = O.describeItemChanges(plan, 30);
  assert.match(text, /Set the DOI on 1 item\./);
  assert.match(text, /Move 1 item to the trash, where you can restore them\. Zotero empties its trash after 30 days\./);
});

test("the description says what changes and that no item is deleted", () => {
  const text = O.describe(O.plan(O.parseCSV(CSV), COLLECTIONS, KEYS));
  assert.match(text, /Add 2 items to 2 topic collections/);
  assert.match(text, /Move to the trash: Old import \(0 items, with Old import \/ library \(3\)\)/);
  assert.match(text, /1 rows name items that are not in the library/);
  assert.match(text, /No item is deleted/);
});
