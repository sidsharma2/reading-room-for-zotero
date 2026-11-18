/* Reading Room Tools: apply a library plan made by papers.py (reorganisation-plan.csv).
 *
 * Adds each item to its topic collection and moves named collections to Zotero's trash, where they can be restored.
 * It never deletes or changes an item. It backs up zotero.sqlite first, shows every change before writing, and logs
 * what it did in <profile>/reading-room/ so it can be undone.
 */
/* global Zotero, PathUtils, IOUtils, ChromeUtils */
var RROrganise = {
  PARENT: "Topics",
  SKIP: new Set(["", "To sort by hand"]),

  // ---- plain functions, tested in plugin/test_organise.mjs ----

  /** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, and a byte-order mark. */
  parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const source = String(text).replace(/^﻿/, "");
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (quoted) {
        if (c === '"' && source[i + 1] === '"') {
          field += '"';
          i++;
        }
        else if (c === '"') {
          quoted = false;
        }
        else {
          field += c;
        }
      }
      else if (c === '"') {
        quoted = true;
      }
      else if (c === ",") {
        row.push(field);
        field = "";
      }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && source[i + 1] === "\n") {
          i++;
        }
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
      else {
        field += c;
      }
    }
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim()));
    return body.map((cells) => Object.fromEntries(header.map((name, index) => [name.trim(), (cells[index] ?? "").trim()])));
  },

  /** What applying would do. collections: [{id, path, items: [keys], children}], keys: the library's item keys.
   * A row with a "retire collection" names a collection, such as an old import folder, to move to Zotero's trash. */
  plan(rows, collections, keys, { retire = true } = {}) {
    const byPath = new Map(collections.map((c) => [c.path, c]));
    const retired = [...new Set(rows.map((row) => row["retire collection"] || "").filter(Boolean))];
    const topLevel = new Set(collections.filter((c) => !c.path.includes(" / ")).map((c) => c.path));
    const targets = new Map();
    const missing = [];
    for (const row of rows) {
      const topic = row["proposed topic"] || "";
      if (this.SKIP.has(topic) || !row.key) {
        continue;
      }
      if (!keys.has(row.key)) {
        missing.push(row.key);
        continue;
      }
      const path = topLevel.has(topic) ? topic : `${this.PARENT} / ${topic}`;
      if (!targets.has(path)) {
        targets.set(path, []);
      }
      const already = byPath.get(path)?.items ?? [];
      if (!already.includes(row.key)) {
        targets.get(path).push(row.key);
      }
    }
    const create = [...targets.keys()].filter((path) => !byPath.has(path));
    if (create.some((path) => path.startsWith(`${this.PARENT} / `)) && !byPath.has(this.PARENT)) {
      create.unshift(this.PARENT);
    }
    const trash = !retire ? [] : retired.map((path) => byPath.get(path)).filter(Boolean).map((c) => ({
      path: c.path, id: c.id, items: c.items.length,
      inside: collections.filter((other) => other.path.startsWith(`${c.path} / `)).map((other) => `${other.path} (${other.items.length})`),
    }));
    const adds = [...targets].map(([path, list]) => ({ path, keys: list })).filter((entry) => entry.keys.length);
    return { create, adds, trash, missing, total: adds.reduce((sum, entry) => sum + entry.keys.length, 0) };
  },

  /** The plan in words, for the confirmation dialog and the log. */
  describe(plan) {
    const lines = [
      `Create ${plan.create.length} collection${plan.create.length === 1 ? "" : "s"}: ${plan.create.join(", ") || "none"}.`,
      `Add ${plan.total} items to ${plan.adds.length} topic collections. Items stay in their other collections.`,
    ];
    for (const entry of plan.trash) {
      lines.push(`Move to the trash: ${entry.path} (${entry.items} items${entry.inside.length ? `, with ${entry.inside.join(", ")}` : ""}). The items stay in the library.`);
    }
    if (plan.missing.length) {
      lines.push(`${plan.missing.length} rows name items that are not in the library, and are left out.`);
    }
    lines.push("No item is deleted or changed. zotero.sqlite is backed up first.");
    return lines.join("\n");
  },

  /** Tags to delete: those used only on papers. A tag on a note or annotation, or one with a colour, was made by
   * hand and stays. uses: [{tagID, name, itemKey, onPaper, type}]. */
  keywordTags(uses, colored = new Set()) {
    const byName = new Map();
    for (const use of uses) {
      const entry = byName.get(use.name) ?? { name: use.name, tagIDs: new Set(), papers: [], elsewhere: 0 };
      entry.tagIDs.add(use.tagID);
      if (use.onPaper) {
        entry.papers.push({ key: use.itemKey, type: use.type });
      }
      else {
        entry.elsewhere++;
      }
      byName.set(use.name, entry);
    }
    const remove = [];
    const keep = [];
    for (const entry of byName.values()) {
      if (entry.elsewhere || colored.has(entry.name)) {
        keep.push(entry.name);
      }
      else {
        remove.push({ name: entry.name, tagIDs: [...entry.tagIDs], papers: entry.papers });
      }
    }
    remove.sort((a, b) => a.name.localeCompare(b.name));
    return { remove, keep: keep.sort(), uses: remove.reduce((sum, entry) => sum + entry.papers.length, 0) };
  },

  describeTags(plan) {
    const examples = plan.remove.slice(0, 8).map((entry) => entry.name).join(", ");
    return [
      `Delete ${plan.remove.length} tags that are used only on papers, ${plan.uses} uses in all. For example: ${examples}.`,
      `Keep ${plan.keep.length}: ${plan.keep.join(", ") || "none"}. These are on notes or annotations, or have a colour.`,
      "No item is deleted or changed, apart from losing these tags. zotero.sqlite is backed up first, and the log lists every tag with its papers.",
    ].join("\n");
  },

  /** Merges from rows with "key" and "merge into". Zotero merges only items of one type, so other pairs are refused.
   * lookup(key) gives {key, type, title, deleted} or null. */
  mergePlan(rows, lookup) {
    const groups = new Map();
    const problems = [];
    const retype = new Set();
    for (const row of rows) {
      const into = row["merge into"];
      if (!into) {
        continue;
      }
      if (!groups.has(into)) {
        groups.set(into, []);
      }
      groups.get(into).push(row.key);
      if (/^(yes|y|true|1)$/i.test(String(row["change type"] || "").trim())) {
        retype.add(row.key); // a copy named here may take the kept item's type, since Zotero merges only one type
      }
    }
    const merges = [];
    for (const [keepKey, others] of groups) {
      const keep = lookup(keepKey);
      const found = others.map((key) => lookup(key));
      const bad = [keep, ...found].some((item) => !item || item.deleted);
      const mismatched = bad ? [] : found.filter((item) => item.type !== keep.type);
      if (bad) {
        problems.push(`${keepKey}: an item is missing or already in the trash`);
      }
      else if (mismatched.some((item) => !retype.has(item.key))) {
        problems.push(`${keepKey}: the items are of different types (${[keep, ...found].map((item) => item.type).join(", ")})`);
      }
      else {
        merges.push({ keep, merge: found, retype: mismatched.map((item) => ({ key: item.key, from: item.type, to: keep.type })) });
      }
    }
    return { merges, problems };
  },

  describeMerges(plan) {
    const lines = plan.merges.map((m) => `Merge ${m.merge.length} cop${m.merge.length === 1 ? "y" : "ies"} into "${m.keep.title.slice(0, 70)}" (${m.keep.key}).`
      + (m.retype?.length ? ` First change ${m.retype.map((r) => `${r.key} from ${r.from}`).join(", ")} to ${m.keep.type}; a field that type lacks is dropped from the copy only.` : ""));
    if (plan.problems.length) {
      lines.push(`Left alone: ${plan.problems.join("; ")}.`);
    }
    lines.push("Zotero's own merge moves files, notes and collections to the kept copy and puts the other copies in the trash. zotero.sqlite is backed up first.");
    return lines.join("\n");
  },

  /** Rows with "key", "doi" and "action" (set doi, trash or hold), such as papers.py dois writes. A DOI goes only into
   * an empty DOI field of an item type that has one; "hold" and anything else is left alone.
   * lookup(key) gives {key, title, doi, deleted, canHaveDOI} or null. */
  itemChangePlan(rows, lookup) {
    const setDOI = [];
    const trash = [];
    const skipped = [];
    for (const row of rows) {
      const action = String(row.action || "").trim().toLowerCase();
      if (action !== "set doi" && action !== "trash") {
        continue;
      }
      const item = lookup(row.key);
      if (!item || item.deleted) {
        skipped.push(`${row.key}: not in the library, or already in the trash`);
      }
      else if (action === "trash") {
        trash.push({ key: item.key, title: item.title });
      }
      else {
        const doi = String(row.doi || "").trim().toLowerCase();
        if (!/^10\.\d{4,9}\/\S+$/.test(doi)) {
          skipped.push(`${row.key}: "${doi}" is not a DOI`);
        }
        else if (item.doi) {
          skipped.push(`${row.key}: already has the DOI ${item.doi}`);
        }
        else if (!item.canHaveDOI) {
          skipped.push(`${row.key}: this item type has no DOI field`);
        }
        else {
          setDOI.push({ key: item.key, title: item.title, doi });
        }
      }
    }
    return { setDOI, trash, skipped };
  },

  describeItemChanges(plan, trashDays = 30) {
    const lines = [`Set the DOI on ${plan.setDOI.length} item${plan.setDOI.length === 1 ? "" : "s"}.`];
    if (plan.trash.length) {
      const days = trashDays > 0 ? `Zotero empties its trash after ${trashDays} days.` : "Zotero keeps them in the trash until you empty it.";
      lines.push(`Move ${plan.trash.length} item${plan.trash.length === 1 ? "" : "s"} to the trash, where you can restore them. ${days}`);
      lines.push(...plan.trash.slice(0, 12).map((item) => `  - ${item.title.slice(0, 80)}`));
      if (plan.trash.length > 12) {
        lines.push(`  - and ${plan.trash.length - 12} more, all listed in the log`);
      }
    }
    if (plan.skipped.length) {
      lines.push(`Left alone: ${plan.skipped.length} (${plan.skipped.slice(0, 3).join("; ")}${plan.skipped.length > 3 ? "; ..." : ""}).`);
    }
    lines.push("zotero.sqlite is backed up first, and the log lists every change.");
    return lines.join("\n");
  },

  // ---- Zotero ----

  async previewItemChanges(csvText, libraryID = Zotero.Libraries.userLibraryID) {
    const doiField = Zotero.ItemFields.getID("DOI");
    const lookup = (key) => {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
      if (!item) {
        return null;
      }
      const canHaveDOI = Zotero.ItemFields.isValidForType(doiField, item.itemTypeID);
      return { key, title: item.getDisplayTitle(), doi: canHaveDOI ? item.getField("DOI") : "", deleted: item.deleted, canHaveDOI };
    };
    return this.itemChangePlan(this.parseCSV(csvText), lookup);
  },

  async applyItemChanges(plan, libraryID = Zotero.Libraries.userLibraryID) {
    const log = { at: new Date().toISOString(), plan: this.describeItemChanges(plan), setDOI: [], trashed: [] };
    log.backup = await Zotero.DB.backUpDatabase({ suffix: "before-reading-room-items", force: true });
    for (const { key, doi } of plan.setDOI) {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
      item.setField("DOI", doi);
      await item.saveTx();
      log.setDOI.push({ key, doi });
    }
    const ids = plan.trash.map(({ key }) => Zotero.Items.getIDFromLibraryAndKey(libraryID, key)).filter(Boolean);
    if (ids.length) {
      await Zotero.Items.trashTx(ids);
      log.trashed = plan.trash;
    }
    log.file = await this.writeLog("items-changed", log);
    return log;
  },

  async writeLog(name, log) {
    const file = PathUtils.join(Zotero.Profile.dir, "reading-room", `${name}-${log.at.replace(/[:.]/g, "-")}.json`);
    await IOUtils.makeDirectory(PathUtils.parent(file), { ignoreExisting: true });
    await IOUtils.writeJSON(file, log);
    return file;
  },

  async previewTags(libraryID = Zotero.Libraries.userLibraryID) {
    const rows = await Zotero.DB.queryAsync("SELECT IT.tagID AS tagID, T.name AS name, IT.itemID AS itemID, IT.type AS type FROM itemTags IT "
      + "JOIN tags T USING (tagID) JOIN items I USING (itemID) WHERE I.libraryID = ?", [libraryID]);
    const uses = rows.map((row) => {
      const item = Zotero.Items.get(row.itemID);
      return { tagID: row.tagID, name: row.name, itemKey: item.key, onPaper: item.isRegularItem(), type: row.type };
    });
    return this.keywordTags(uses, new Set(Zotero.Tags.getColors(libraryID).keys()));
  },

  async deleteTags(plan, libraryID = Zotero.Libraries.userLibraryID) {
    const log = { at: new Date().toISOString(), plan: this.describeTags(plan), removed: plan.remove.map(({ name, papers }) => ({ name, papers })) };
    log.backup = await Zotero.DB.backUpDatabase({ suffix: "before-reading-room-tags", force: true });
    await Zotero.Tags.removeFromLibrary(libraryID, plan.remove.flatMap((entry) => entry.tagIDs));
    log.file = await this.writeLog("tags-removed", log);
    return log;
  },

  async previewMerges(csvText, libraryID = Zotero.Libraries.userLibraryID) {
    const lookup = (key) => {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
      return item ? { key, type: item.itemType, title: item.getDisplayTitle(), deleted: item.deleted } : null;
    };
    return this.mergePlan(this.parseCSV(csvText), lookup);
  },

  async applyMerges(plan, libraryID = Zotero.Libraries.userLibraryID) {
    const { mergeItems } = ChromeUtils.importESModule("chrome://zotero/content/mergeItems.mjs");
    const log = { at: new Date().toISOString(), plan: this.describeMerges(plan), merged: [] };
    log.backup = await Zotero.DB.backUpDatabase({ suffix: "before-reading-room-merge", force: true });
    for (const { keep, merge, retype = [] } of plan.merges) {
      const master = Zotero.Items.getByLibraryAndKey(libraryID, keep.key);
      for (const change of retype) {
        const copy = Zotero.Items.getByLibraryAndKey(libraryID, change.key);
        copy.setType(Zotero.ItemTypes.getID(change.to));
        await copy.saveTx();
      }
      const others = merge.map((item) => Zotero.Items.getByLibraryAndKey(libraryID, item.key));
      await mergeItems(master, others);
      log.merged.push({ keep: keep.key, merged: merge.map((item) => item.key), retyped: retype });
    }
    log.file = await this.writeLog("merged", log);
    return log;
  },

  snapshot(libraryID) {
    const all = Zotero.Collections.getByLibrary(libraryID, true).filter((c) => !c.deleted);
    const path = (c) => (c.parentID ? `${path(Zotero.Collections.get(c.parentID))} / ${c.name}` : c.name);
    return all.map((c) => ({ id: c.id, path: path(c), items: Zotero.Items.get(c.getChildItems(true)).map((item) => item.key) }));
  },

  async libraryKeys(libraryID) {
    return new Set((await Zotero.Items.getAll(libraryID, true)).filter((item) => item.isRegularItem() && !item.deleted).map((item) => item.key));
  },

  async preview(csvText, libraryID = Zotero.Libraries.userLibraryID, options = {}) {
    return this.plan(this.parseCSV(csvText), this.snapshot(libraryID), await this.libraryKeys(libraryID), options);
  },

  async apply(plan, libraryID = Zotero.Libraries.userLibraryID) {
    const log = { at: new Date().toISOString(), created: [], added: [], trashed: [], plan: this.describe(plan) };
    log.backup = await Zotero.DB.backUpDatabase({ suffix: "before-reading-room-plan", force: true });
    const ids = new Map(this.snapshot(libraryID).map((c) => [c.path, c.id]));
    for (const path of plan.create) {
      const parentPath = path.includes(" / ") ? path.slice(0, path.lastIndexOf(" / ")) : "";
      const collection = new Zotero.Collection();
      collection.libraryID = libraryID;
      collection.name = parentPath ? path.slice(parentPath.length + 3) : path;
      if (parentPath) {
        collection.parentID = ids.get(parentPath);
      }
      await collection.saveTx();
      ids.set(path, collection.id);
      log.created.push({ path, key: collection.key });
    }
    for (const { path, keys } of plan.adds) {
      const collection = Zotero.Collections.get(ids.get(path));
      const itemIDs = keys.map((key) => Zotero.Items.getIDFromLibraryAndKey(libraryID, key)).filter(Boolean);
      await Zotero.DB.executeTransaction(async () => {
        await collection.addItems(itemIDs);
      });
      log.added.push({ path, collection: collection.key, items: keys });
    }
    for (const entry of plan.trash) {
      const collection = Zotero.Collections.get(entry.id);
      if (collection && !collection.deleted) {
        collection.deleted = true;
        await collection.saveTx();
        log.trashed.push({ path: entry.path, key: collection.key });
      }
    }
    log.file = await this.writeLog("plan-applied", log);
    return log;
  },
};
