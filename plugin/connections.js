/* Reading Room Tools: the connections web.
 *
 * For one paper: what it cites, what cites it, what OpenAlex calls similar, and what in your own library uses the same
 * words, with lines where those papers cite each other. For the whole library, or one collection: how those papers cite
 * each other, the papers several of them cite, and the later papers that cite several of them.
 *
 * Metadata comes from OpenAlex. Nothing is downloaded but titles, abstracts, years, counts and identifiers, and
 * nothing is added to the library unless you click Add. Every answer is kept, and asked again after 30 days, because
 * OpenAlex allows about 1,000 requests a day without a key. Offline, a kept answer is used however old it is, so every
 * web you have seen still opens. The same results go to <profile>/reading-room/ for the chat's source list.
 *
 * While Zotero is open and online, warmUp fills the cache for your library a few papers at a time, and Check later
 * keeps papers you want to look at on this machine until you add them.
 */
/* global Zotero, PathUtils, IOUtils */
var RRConnections = {
  API: "https://api.openalex.org/works",
  FIELDS: "id,doi,display_name,publication_year,cited_by_count,authorships,primary_location,open_access,referenced_works,abstract_inverted_index",
  MAX_AGE_DAYS: 30,
  ABSTRACT_CHARS: 1200, // enough to judge a paper offline, small enough that a cached web stays a few hundred kB
  WARM_PAPERS: 25, // per run, about 5 requests each
  WARM_RESERVE: 250, // requests left for your own clicks before warm-up stops for the day
  WARM_PAUSE_MS: 2000,
  CITING: 50,
  MAX_REFERENCES: 200,
  LOCAL_SIMILAR: 8,
  MIN_TITLE_KEY: 24, // shorter titles collide, the same floor the hub uses
  STOP: new Set(("about above after again also among and any are around based because been before being between both but "
    + "can could did does doing down during each few for from further had has have having here how into its itself just "
    + "more most much must not now off once only other our out over own same should some such than that the their them "
    + "then there these they this those through too under until upon very was were what when where which while who whom "
    + "why will with would you your using used use via study studies paper results result new two three one analysis "
    + "effect effects data model models method methods approach case").split(" ")),

  budget: { remaining: null, limit: null },
  rowsCache: null,
  warming: false,

  // ---- plain functions, tested in plugin/test_connections.mjs ----

  normalDOI(value) {
    const match = String(value || "").trim().match(/10\.\d{4,9}\/\S+/i);
    return match ? match[0].replace(/[.,;)\]}>"']+$/, "").toLowerCase() : "";
  },

  doiFrom({ DOI = "", extra = "", url = "" } = {}) {
    const inExtra = String(extra).match(/^\s*DOI:\s*(\S+)/im);
    return this.normalDOI(DOI) || this.normalDOI(inExtra?.[1]) || (/doi\.org\//i.test(url) ? this.normalDOI(url) : "");
  },

  titleKey(title) {
    const key = String(title || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "");
    return key.length >= this.MIN_TITLE_KEY ? key : "";
  },

  wid(value) {
    const id = String(value || "").split("/").pop();
    return /^W\d+$/.test(id) ? id : "";
  },

  clean(text) {
    return String(text || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  },

  slim(record) {
    const authors = (record.authorships || []).map((entry) => entry?.author?.display_name).filter(Boolean);
    return {
      id: this.wid(record.id), doi: this.normalDOI(record.doi), title: this.clean(record.display_name || record.title),
      year: record.publication_year ?? null, cites: record.cited_by_count ?? 0, authors: authors.slice(0, 3), more: authors.length > 3,
      venue: this.clean(record.primary_location?.source?.display_name), oa: String(record.open_access?.oa_url || ""),
      refs: (record.referenced_works || []).map((item) => this.wid(item)).filter(Boolean),
      abstract: this.clean(this.abstract(record.abstract_inverted_index)).slice(0, this.ABSTRACT_CHARS),
    };
  },

  /** A kept answer while it is fresh; else a new one; else, when the network fails, the kept one however old. */
  async keptOr(kept, ask, refresh = false) {
    if (kept && !refresh && this.fresh(kept.retrieved_at)) {
      return kept;
    }
    try {
      return await ask();
    }
    catch (error) {
      if (kept) {
        return { ...kept, stale: true };
      }
      throw error;
    }
  },

  /** When each paper was last tried: its kept web, or, for a paper OpenAlex could not match, the lookup in items.json.
   * Without the second, unmatched papers came first in every warm-up and could take all of its turns. */
  warmTried(webs, items) {
    const tried = { ...webs };
    for (const [key, entry] of Object.entries(items || {})) {
      if (entry && !entry.work && entry.at && !(tried[key] && Date.parse(tried[key]) >= Date.parse(entry.at))) {
        tried[key] = entry.at;
      }
    }
    return tried;
  },

  /** Library papers whose web is not kept yet, or is older than 30 days: never-seen ones first, newest added first. */
  warmQueue(rows, kept, limit = this.WARM_PAPERS) {
    const age = (row) => (kept[row.key] ? Date.parse(kept[row.key]) || 0 : -1);
    return rows.filter((row) => (row.doi || this.titleKey(row.title)) && !(kept[row.key] && this.fresh(kept[row.key])))
      .sort((a, b) => age(a) - age(b) || String(b.added || "").localeCompare(String(a.added || ""))).slice(0, limit);
  },

  // ---- Check later: papers kept on this machine, with what you need to judge them offline ----

  laterId(work) {
    return work.wid || work.id && /^W\d+$/.test(work.id) && work.id || (work.doi ? `doi:${work.doi}` : "");
  },

  laterEntry(work, from = {}, now = new Date().toISOString()) {
    const text = (value, size) => this.clean(value).slice(0, size);
    const oa = /^https:\/\/\S+$/.test(String(work.oa || "")) ? String(work.oa) : "";
    const wid = this.wid(work.wid || work.id);
    return {
      id: this.laterId({ wid, doi: this.normalDOI(work.doi) }), wid, doi: this.normalDOI(work.doi), title: text(work.title, 400),
      authors: (Array.isArray(work.authors) ? work.authors : []).slice(0, 3).map((name) => text(name, 80)), more: !!work.more,
      year: Number.isInteger(work.year) ? work.year : null, venue: text(work.venue, 200), cites: Number(work.cites) || 0, oa,
      abstract: text(work.abstract, this.ABSTRACT_CHARS), from: { key: /^[A-Z0-9]{8}$/.test(String(from.key || "")) ? from.key : "", title: text(from.title, 300) },
      saved_at: now,
    };
  },

  laterAdd(list, entry) {
    if (!entry.id || !entry.title || list.some((item) => item.id === entry.id || (entry.doi && item.doi === entry.doi))) {
      return list;
    }
    return [entry, ...list];
  },

  /** Splits the list into papers still to check and papers that reached the library some other way (Zotero itself,
   * the browser connector, sync). Those last would otherwise sit in the list as owned, with nothing left to do. */
  laterReconcile(list, library) {
    const owned = (entry) => !!this.find(library, { id: entry.wid, doi: entry.doi, title: entry.title });
    return { list: list.filter((entry) => !owned(entry)), owned: list.filter(owned) };
  },

  laterRemove(list, id) {
    return list.filter((item) => item.id !== id);
  },

  /** The saved papers as a web with no lines, so the same window can show them, marked against the library. */
  laterWeb(list, library) {
    const nodes = list.map((entry) => {
      const made = this.node({ ...entry, id: entry.wid, refs: [] }, this.find(library, { id: entry.wid, doi: entry.doi, title: entry.title }), "saved");
      made.id = entry.id;
      made.saved = true;
      made.note = [entry.from?.title ? `Found from ${entry.from.title}` : "", `saved ${String(entry.saved_at).slice(0, 10)}`].filter(Boolean).join(", ");
      return made;
    });
    return { mode: "later", focal: "", nodes, edges: [], laterCount: list.length };
  },

  markSaved(web, list) {
    const ids = new Set(list.map((entry) => entry.id));
    const dois = new Set(list.map((entry) => entry.doi).filter(Boolean));
    for (const node of web.nodes) {
      node.saved = ids.has(this.laterId(node)) || (!!node.doi && dois.has(node.doi));
    }
    web.laterCount = list.length;
    return web;
  },

  abstract(inverted) {
    const words = [];
    for (const [word, places] of Object.entries(inverted || {})) {
      for (const place of places) {
        words[place] = word;
      }
    }
    return words.filter(Boolean).join(" ");
  },

  makeLibrary(rows) {
    const library = { rows, byKey: new Map(), byDOI: new Map(), byTitle: new Map(), byWid: new Map() };
    for (const row of rows) {
      library.byKey.set(row.key, row);
      if (row.doi) {
        library.byDOI.set(row.doi, row);
      }
      if (row.wid) {
        library.byWid.set(row.wid, row);
      }
      const key = this.titleKey(row.title);
      if (key) {
        library.byTitle.set(key, library.byTitle.has(key) ? null : row); // two items with one title match neither
      }
    }
    return library;
  },

  find(library, work) {
    return (work.id && library.byWid.get(work.id)) || (work.doi && library.byDOI.get(work.doi)) || library.byTitle.get(this.titleKey(work.title)) || null;
  },

  mark(row) {
    return row ? (row.have ? "have" : "wanted") : "new";
  },

  words(text) {
    return (String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((word) => !this.STOP.has(word));
  },

  /** Library items that use the same rare words as this one: title twice, abstract and tags. No network. */
  similarInLibrary(focal, rows, limit = this.LOCAL_SIMILAR) {
    const docs = rows.map((row) => this.words(`${row.title} ${row.title} ${row.abstract || ""} ${(row.tags || []).join(" ")}`));
    const frequency = new Map();
    for (const doc of docs) {
      for (const word of new Set(doc)) {
        frequency.set(word, (frequency.get(word) || 0) + 1);
      }
    }
    const vector = (doc) => {
      const counts = new Map();
      for (const word of doc) {
        counts.set(word, (counts.get(word) || 0) + 1);
      }
      let norm = 0;
      for (const [word, count] of counts) {
        const weight = (1 + Math.log(count)) * Math.log(1 + docs.length / (frequency.get(word) || 1));
        counts.set(word, weight);
        norm += weight * weight;
      }
      return { counts, norm: Math.sqrt(norm) || 1 };
    };
    const target = vector(this.words(`${focal.title} ${focal.title} ${focal.abstract || ""} ${(focal.tags || []).join(" ")}`));
    const scored = [];
    rows.forEach((row, index) => {
      if (row.key === focal.key) {
        return;
      }
      const other = vector(docs[index]);
      let dot = 0;
      for (const [word, weight] of target.counts) {
        dot += weight * (other.counts.get(word) || 0);
      }
      const score = dot / (target.norm * other.norm);
      if (score >= 0.08) {
        scored.push({ row, score });
      }
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  },

  node(work, row, group) {
    return {
      id: work.id || `zotero:${row?.key}`, wid: work.id || row?.wid || "", doi: work.doi || row?.doi || "",
      title: work.title || row?.title || "", year: work.year ?? row?.year ?? null, cites: work.cites ?? 0,
      authors: work.authors || row?.creators || [], more: !!work.more, venue: work.venue || "", oa: work.oa || "",
      abstract: work.abstract || row?.abstract || "",
      key: row?.key || "", mark: this.mark(row), groups: [group], refs: work.refs || [], note: "",
    };
  },

  /** The web around one paper. Sections hold slim OpenAlex works; local holds library rows with scores. */
  paperWeb(focal, focalRow, sections, library, local = []) {
    const nodes = new Map();
    const edges = [];
    const seen = new Set();
    const link = (source, target, kind) => {
      const id = `${source}>${target}`;
      if (source !== target && !seen.has(id)) {
        seen.add(id);
        edges.push({ source, target, kind });
      }
    };
    const add = (work, group) => {
      const row = this.find(library, work) || null;
      const made = this.node(work, row, group);
      const old = nodes.get(made.id);
      if (old) {
        old.groups.includes(group) || old.groups.push(group);
        return old;
      }
      nodes.set(made.id, made);
      return made;
    };
    const centre = this.node(focal, focalRow, "focal");
    nodes.set(centre.id, centre);
    for (const work of sections.references || []) {
      link(centre.id, add(work, "references").id, "cites");
    }
    for (const work of sections.citing || []) {
      link(add(work, "citing").id, centre.id, "cites");
    }
    for (const work of sections.related || []) {
      link(centre.id, add(work, "related").id, "similar");
    }
    for (const { row, score } of local) {
      const work = { id: row.wid || "", doi: row.doi, title: row.title, year: row.year, authors: row.creators || [] };
      const made = add(work, "library");
      made.note = made.note || `${Math.round(score * 100)}% word match`;
      link(centre.id, made.id, "words");
    }
    for (const item of nodes.values()) {
      for (const ref of item.refs) {
        if (nodes.has(ref)) {
          link(item.id, ref, "cites");
        }
      }
    }
    for (const item of nodes.values()) {
      delete item.refs;
    }
    return { mode: "paper", focal: centre.id, nodes: [...nodes.values()], edges };
  },

  /** Your papers, or one collection's, and their citations of each other, with the papers they cite or that cite them most. */
  libraryWeb(records, library, earlier, later, collection = null) {
    const nodes = new Map();
    const edges = [];
    const whose = collection ? "the papers here" : "your papers";
    const outside = (key) => (collection && key && !collection.keys.has(key) ? ". In your library, outside this collection" : "");
    for (const work of records) {
      const made = this.node(work, this.find(library, work), "mine");
      nodes.set(made.id, made);
    }
    const ids = new Set(nodes.keys());
    for (const work of records) {
      for (const ref of work.refs) {
        if (ids.has(ref) && ref !== work.id) {
          edges.push({ source: work.id, target: ref, kind: "cites" });
        }
      }
    }
    for (const { work, count } of earlier) {
      const made = this.node(work, this.find(library, work), "earlier");
      made.note = `cited by ${count} of ${whose}${outside(made.key)}`;
      nodes.set(made.id, made);
      for (const mine of records) {
        if (mine.refs.includes(work.id)) {
          edges.push({ source: mine.id, target: work.id, kind: "cites" });
        }
      }
    }
    for (const { work, count } of later) {
      const made = this.node(work, this.find(library, work), "later");
      made.note = `cites ${count} of ${whose}${outside(made.key)}`;
      nodes.set(made.id, made);
      for (const ref of work.refs) {
        if (ids.has(ref)) {
          edges.push({ source: work.id, target: ref, kind: "cites" });
        }
      }
    }
    for (const item of nodes.values()) {
      delete item.refs;
    }
    return { mode: collection ? "collection" : "library", focal: "", nodes: [...nodes.values()], edges };
  },

  /** Works referenced by at least `least` of your papers, most referenced first. */
  mostCited(records, ids, least = 2, limit = 25) {
    const counts = new Map();
    for (const work of records) {
      for (const ref of new Set(work.refs)) {
        if (!ids.has(ref)) {
          counts.set(ref, (counts.get(ref) || 0) + 1);
        }
      }
    }
    return [...counts].filter(([, count]) => count >= least).sort((a, b) => b[1] - a[1]).slice(0, limit);
  },

  /** What the chat's source list reads: the same sections the hub's cache has, with the library marks filled in. */
  agentEntry(web, focalRow) {
    const works = (group) => web.nodes.filter((item) => item.groups.includes(group)).map((item) => ({
      title: item.title, doi: item.doi, year: item.year, mark: item.mark, zotero_key: item.key,
    }));
    return {
      schema_version: 1, made_by: "reading-room-tools", retrieved_at: new Date().toISOString(),
      focal: { title: focalRow?.title || "", doi: focalRow?.doi || "", zotero_key: focalRow?.key || "" },
      sections: { references: { works: works("references") }, citing: { works: works("citing") }, related: { works: works("related") }, library: { works: works("library") } },
    };
  },

  chunks(list, size) {
    const out = [];
    for (let start = 0; start < list.length; start += size) {
      out.push(list.slice(start, start + size));
    }
    return out;
  },

  // ---- Zotero and network ----

  folder(...parts) {
    return PathUtils.join(Zotero.Profile.dir, "reading-room", ...parts);
  },

  async readJSON(path, fallback) {
    try {
      return await IOUtils.readJSON(path);
    }
    catch {
      return fallback;
    }
  },

  async writeJSON(path, value) {
    await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
    await IOUtils.writeJSON(path, value);
  },

  fresh(stamp) {
    return stamp && Date.now() - Date.parse(stamp) < this.MAX_AGE_DAYS * 86400000;
  },

  async getJSON(url) {
    const headers = { Accept: "application/json" };
    const key = Zotero.Prefs.get("extensions.rrtools.openalexKey", true);
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const reply = await Zotero.HTTP.request("GET", url, { headers, responseType: "json", timeout: 30000, successCodes: [200, 404, 429] });
    const remaining = reply.getResponseHeader("X-RateLimit-Remaining");
    if (remaining !== null) {
      this.budget = { remaining: Number(remaining), limit: Number(reply.getResponseHeader("X-RateLimit-Limit")) || null };
    }
    if (reply.status === 429) {
      throw new Error("OpenAlex's free daily budget is used up. Cached papers still work. It resets within a day, or add a free OpenAlex key from Tools > Reading Room.");
    }
    return reply.status === 404 ? null : reply.response;
  },

  async byIds(ids, fields = this.FIELDS) {
    const works = [];
    for (const part of this.chunks(ids.filter((id) => /^W\d+$/.test(id)), 100)) {
      const reply = await this.getJSON(`${this.API}?filter=openalex:${part.join("|")}&per-page=${part.length}&select=${fields}`);
      works.push(...(reply?.results || []).map((record) => this.slim(record)));
    }
    return works;
  },

  /** The OpenAlex record for a library item: by DOI, else by an exact title. Never a near match. */
  async recordFor(row) {
    const fields = `${this.FIELDS},related_works`;
    if (row.doi) {
      const doi = encodeURIComponent(row.doi).replace(/%2F/gi, "/");
      return this.getJSON(`${this.API}/doi:${doi}?select=${fields}`);
    }
    const key = this.titleKey(row.title);
    if (!key) {
      return null;
    }
    const reply = await this.getJSON(`${this.API}?search=${encodeURIComponent(row.title)}&per-page=5&select=${fields}`);
    const exact = (reply?.results || []).filter((record) => this.titleKey(record.display_name) === key
      && (!row.year || !record.publication_year || Math.abs(record.publication_year - row.year) <= 1));
    return exact.length === 1 ? exact[0] : null;
  },

  /** References, citing papers and similar papers for one work, kept with the work itself. Offline, the kept ones. */
  async sectionsFor(focal, record, refresh = false) {
    const path = this.folder("openalex", `${focal.id}.json`);
    return this.keptOr(await this.readJSON(path, null), async () => {
      const references = (await this.byIds(focal.refs.slice(0, this.MAX_REFERENCES))).sort((a, b) => (a.year || 0) - (b.year || 0));
      const citing = (await this.getJSON(`${this.API}?filter=cites:${focal.id}&sort=cited_by_count:desc&per-page=${this.CITING}&select=${this.FIELDS}`))?.results || [];
      const related = await this.byIds((record?.related_works || []).map((item) => this.wid(item)));
      const entry = { retrieved_at: new Date().toISOString(), focal, sections: { references, citing: citing.map((item) => this.slim(item)), related } };
      await this.writeJSON(path, entry);
      return entry;
    }, refresh);
  },

  async focalWork(row, refresh = false) {
    const known = await this.readJSON(this.folder("items.json"), {});
    const stored = known[row.key];
    const kept = stored ? { ...stored, retrieved_at: stored.at } : null;
    const found = await this.keptOr(kept, async () => {
      const record = await this.recordFor(row);
      const entry = { at: new Date().toISOString(), work: record ? this.slim(record) : null, related: (record?.related_works || []).map((item) => this.wid(item)).filter(Boolean) };
      known[row.key] = entry;
      await this.writeJSON(this.folder("items.json"), known);
      return { ...entry, retrieved_at: entry.at };
    }, refresh);
    return found.work ? { work: found.work, related: found.related || [], stale: !!found.stale } : null;
  },

  sentence(text) {
    const clean = String(text || "").trim();
    return /[.!?]$/.test(clean) ? clean : `${clean}.`;
  },

  offlineNote(entry) {
    return entry?.stale ? `Offline: showing what OpenAlex said on ${String(entry.retrieved_at).slice(0, 10)}.` : "";
  },

  // ---- Check later, kept in <profile>/reading-room/check-later.json ----

  async laterList() {
    return (await this.readJSON(this.folder("check-later.json"), { items: [] })).items || [];
  },

  async laterSave(list) {
    await this.writeJSON(this.folder("check-later.json"), { written_at: new Date().toISOString(), items: list });
    return list;
  },

  async laterShow(libraryID = Zotero.Libraries.userLibraryID) {
    const library = this.makeLibrary(await this.libraryRows(libraryID));
    const { list, owned } = this.laterReconcile(await this.laterList(), library);
    if (owned.length) {
      await this.laterSave(list);
    }
    const web = this.laterWeb(list, library);
    web.cleared = owned.length;
    web.budget = this.budget;
    return web;
  },

  /** Every saved paper with a DOI that is not in the library yet goes in, one at a time. Each one added leaves the list. */
  async laterAddAll(libraryID = Zotero.Libraries.userLibraryID) {
    let list = await this.laterList();
    const library = this.makeLibrary(await this.libraryRows(libraryID));
    const result = { added: 0, already: 0, noDOI: 0, failed: 0, problem: "" };
    for (const entry of [...list]) {
      if (this.find(library, { id: entry.wid, doi: entry.doi, title: entry.title })) {
        result.already++;
        list = this.laterRemove(list, entry.id);
        continue;
      }
      if (!entry.doi) {
        result.noDOI++;
        continue;
      }
      try {
        if (await this.addByDOI(entry.doi)) {
          result.added++;
          list = this.laterRemove(list, entry.id);
        }
        else {
          result.failed++;
        }
      }
      catch (error) {
        result.failed++;
        result.problem = String(error.message || error);
      }
      await this.laterSave(list);
    }
    await this.laterSave(list);
    return result;
  },

  /** Fills the cache for papers in the library while Zotero is open and online, so their webs open offline later.
   * It stops at the first network failure, and leaves WARM_RESERVE of the day's OpenAlex requests for your own clicks. */
  async warmUp(libraryID = Zotero.Libraries.userLibraryID) {
    if (this.warming || Zotero.Prefs.get("extensions.rrtools.warmup", true) === false) {
      return 0;
    }
    this.warming = true;
    let done = 0;
    try {
      await this.getJSON(`${this.API}?per-page=1&select=id`); // offline or over budget: stop here, quietly
      const rows = await this.libraryRows(libraryID);
      const kept = {};
      for (const row of rows) {
        const entry = await this.readJSON(this.folder("connections", `${row.key}.json`), null);
        if (entry?.retrieved_at) {
          kept[row.key] = entry.retrieved_at;
        }
      }
      for (const row of this.warmQueue(rows, this.warmTried(kept, await this.readJSON(this.folder("items.json"), {})))) {
        if (this.budget.remaining !== null && this.budget.remaining < this.WARM_RESERVE) {
          break;
        }
        const item = Zotero.Items.getByLibraryAndKey(libraryID, row.key);
        const web = item ? await this.webForItem(item) : null;
        if (web?.offline) {
          break;
        }
        done++;
        await Zotero.Promise.delay(this.WARM_PAUSE_MS);
      }
    }
    catch (error) {
      Zotero.debug(`Reading Room Tools: warm-up stopped after ${done}: ${error}`);
    }
    finally {
      this.warming = false;
    }
    Zotero.debug(`Reading Room Tools: warm-up kept ${done} webs`);
    return done;
  },

  async libraryRows(libraryID = Zotero.Libraries.userLibraryID) {
    if (this.rowsCache && this.rowsCache.libraryID === libraryID && Date.now() - this.rowsCache.at < 60000) {
      return this.rowsCache.rows;
    }
    const known = await this.readJSON(this.folder("items.json"), {});
    const rows = [];
    for (const item of await Zotero.Items.getAll(libraryID, true)) {
      if (!item.isRegularItem()) {
        continue;
      }
      const field = (name) => {
        try {
          return item.getField(name) || "";
        }
        catch {
          return "";
        }
      };
      let pdf = null;
      for (const attachment of Zotero.Items.get(item.getAttachments())) {
        if (attachment.isPDFAttachment?.() && await attachment.fileExists()) {
          pdf = attachment;
          break;
        }
      }
      rows.push({
        id: item.id, key: item.key, title: item.getDisplayTitle(), year: parseInt(field("date") && item.getField("date", true, true), 10) || null,
        doi: this.doiFrom({ DOI: field("DOI"), extra: field("extra"), url: field("url") }), abstract: field("abstractNote").slice(0, 2000),
        tags: item.getTags().map((tag) => tag.tag), creators: item.getCreators().slice(0, 3).map((person) => person.lastName || person.name).filter(Boolean),
        have: !!pdf, pdf: pdf?.id ?? null, wid: known[item.key]?.work?.id || "", added: item.dateAdded || "",
      });
    }
    this.rowsCache = { libraryID, at: Date.now(), rows };
    return rows;
  },

  /** The web for one library item. Works offline too, with only the library's own word matches. */
  async webForItem(item, refresh = false) {
    const rows = await this.libraryRows(item.libraryID);
    const library = this.makeLibrary(rows);
    const focalRow = library.byKey.get(item.key);
    const local = this.similarInLibrary(focalRow, rows);
    let found = null;
    let problem = "";
    let offline = "";
    try {
      found = await this.focalWork(focalRow, refresh);
      if (!found) {
        problem = focalRow.doi ? "OpenAlex does not know this DOI." : "This item has no DOI, and OpenAlex has no exact title match, so only your library is shown.";
      }
    }
    catch (error) {
      problem = `${this.sentence(error.message || error)} Only your own library is shown, because this paper's web was never fetched online.`;
      offline = problem;
    }
    let kept = null;
    if (found) {
      try {
        kept = await this.sectionsFor(found.work, { related_works: found.related }, refresh);
        offline = this.offlineNote(kept);
      }
      catch (error) {
        problem = String(error.message || error);
        offline = problem;
      }
    }
    const focal = found?.work || { id: "", doi: focalRow.doi, title: focalRow.title, year: focalRow.year, authors: focalRow.creators, refs: [] };
    const web = this.paperWeb(focal, focalRow, kept?.sections || {}, library, local);
    web.problem = problem;
    web.offline = offline;
    web.budget = this.budget;
    if (kept && !kept.stale) {
      await this.writeJSON(this.folder("connections", `${focalRow.key}.json`), this.agentEntry(web, focalRow));
    }
    return this.markSaved(web, await this.laterList());
  },

  /** The web around any OpenAlex work, for Expand and for a paper that is not in the library. Offline, the kept one. */
  async webForWork(wid, refresh = false) {
    const library = this.makeLibrary(await this.libraryRows());
    const kept = await this.readJSON(this.folder("openalex", `${wid}.json`), null);
    const entry = await this.keptOr(kept?.focal ? kept : null, async () => {
      const record = await this.getJSON(`${this.API}/${wid}?select=${this.FIELDS},related_works`);
      if (!record) {
        throw new Error("OpenAlex has no record for this paper.");
      }
      return this.sectionsFor(this.slim(record), record, true);
    }, refresh);
    const web = this.paperWeb(entry.focal, this.find(library, entry.focal), entry.sections, library, []);
    web.offline = this.offlineNote(entry);
    web.budget = this.budget;
    return this.markSaved(web, await this.laterList());
  },

  /** Asks OpenAlex for the DOIs it has not been asked for lately, and keeps the answers. */
  async askWorks(rows, stored, path, refresh) {
    const missing = rows.filter((row) => row.doi && (refresh || !(stored[row.doi] && this.fresh(stored[row.doi].at))));
    for (const part of this.chunks(missing.map((row) => row.doi), 50)) {
      const reply = await this.getJSON(`${this.API}?filter=doi:${part.map((doi) => encodeURIComponent(doi)).join("|")}&per-page=50&select=${this.FIELDS}`);
      const now = new Date().toISOString();
      const got = new Map((reply?.results || []).map((record) => [this.normalDOI(record.doi), this.slim(record)]));
      for (const doi of part) {
        stored[doi] = { at: now, work: got.get(doi) || null };
      }
    }
    if (missing.length) {
      await this.writeJSON(path, stored);
    }
  },

  /** The works these papers cite most, and the later works that cite most of them. */
  async around(records, ids, least) {
    const earlierIds = this.mostCited(records, ids, least);
    const earlierWorks = new Map((await this.byIds(earlierIds.map(([id]) => id))).map((work) => [work.id, work]));
    const earlier = earlierIds.filter(([id]) => earlierWorks.has(id)).map(([id, count]) => ({ work: earlierWorks.get(id), count }));
    const laterCounts = new Map();
    for (const part of this.chunks([...ids], 50)) {
      const reply = await this.getJSON(`${this.API}?filter=cites:${part.join("|")}&sort=cited_by_count:desc&per-page=200&select=${this.FIELDS}`);
      for (const record of reply?.results || []) {
        const work = this.slim(record);
        if (!ids.has(work.id)) {
          const entry = laterCounts.get(work.id) || { work, count: 0 };
          entry.count = new Set(work.refs.filter((ref) => ids.has(ref))).size;
          laterCounts.set(work.id, entry);
        }
      }
    }
    const later = [...laterCounts.values()].filter((entry) => entry.count >= least).sort((a, b) => b.count - a.count || b.work.cites - a.work.cites).slice(0, 25);
    return { earlier, later };
  },

  /** The map of the whole library, or of one collection and the collections inside it. Offline, the kept one. */
  async libraryMap(libraryID = Zotero.Libraries.userLibraryID, refresh = false, collection = null) {
    const all = await this.libraryRows(libraryID);
    const library = this.makeLibrary(all);
    const members = collection ? new Set(collection.getDescendents(false, "item").map((entry) => entry.id)) : null;
    const rows = members ? all.filter((row) => members.has(row.id)) : all;
    const worksPath = this.folder("library-works.json");
    const stored = await this.readJSON(worksPath, {});
    let failure = null;
    try {
      await this.askWorks(rows, stored, worksPath, refresh);
    }
    catch (error) {
      failure = error;
    }
    // A paper with no DOI is placed when its own web has found it by its exact title.
    const known = await this.readJSON(this.folder("items.json"), {});
    const placed = new Map();
    for (const row of rows) {
      const work = (row.doi && stored[row.doi]?.work) || known[row.key]?.work;
      if (work?.id) {
        placed.set(work.id, work);
      }
    }
    const records = [...placed.values()];
    const path = this.folder("maps", `${collection?.key || "library"}.json`);
    let kept = null;
    if (!failure) {
      try {
        kept = { retrieved_at: new Date().toISOString(), ...await this.around(records, new Set(placed.keys()), records.length < 4 ? 1 : 2) };
        await this.writeJSON(path, kept);
      }
      catch (error) {
        failure = error;
      }
    }
    if (failure) {
      kept = await this.readJSON(path, null);
      if (!kept) {
        throw failure;
      }
    }
    const named = collection ? { keys: new Set(rows.map((row) => row.key)) } : null;
    const web = this.libraryWeb(records, library, kept.earlier, kept.later, named);
    web.withoutDOI = rows.length - records.length;
    web.offline = failure ? `${this.sentence(failure.message || failure)} Showing the map from ${String(kept.retrieved_at).slice(0, 10)}.` : "";
    web.budget = this.budget;
    return this.markSaved(web, await this.laterList());
  },

  async abstractOf(wid) {
    const record = await this.getJSON(`${this.API}/${wid}?select=abstract_inverted_index`);
    return this.abstract(record?.abstract_inverted_index);
  },

  /** Adds a paper by DOI to My Library, as Add Item by Identifier does, and to a collection. Only ever runs on a click. */
  async addByDOI(doi, collection = null) {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: doi });
    const translators = await translate.getTranslators();
    if (!translators.length) {
      throw new Error("Zotero found no way to look up this DOI.");
    }
    translate.setTranslator(translators);
    const libraryID = collection?.libraryID ?? Zotero.Libraries.userLibraryID;
    const items = await translate.translate({ libraryID, saveAttachments: true, ...(collection ? { collections: [collection.id] } : {}) });
    this.rowsCache = null;
    return items?.[0] ?? null;
  },

  /** Your library's titles, abstracts and tags, for the chat's source list on machines with no wiki copy. */
  async exportLibrary() {
    const rows = await this.libraryRows();
    const slimRows = rows.map(({ key, title, year, doi, abstract, tags, creators, have }) => ({ key, title, year, doi, abstract, tags, creators, have }));
    await this.writeJSON(this.folder("library.json"), { written_at: new Date().toISOString(), items: slimRows });
    return slimRows.length;
  },

  /** Fetch a paper's web when it is opened, so the chat has it by the time a question comes. Errors stay quiet. */
  async prefetch(item) {
    const parent = item?.isAttachment?.() ? item.parentItem : item;
    if (!parent?.isRegularItem?.() || Zotero.Prefs.get("extensions.rrtools.prefetch", true) === false) {
      return;
    }
    const entry = await this.readJSON(this.folder("connections", `${parent.key}.json`), null);
    if (entry && this.fresh(entry.retrieved_at)) {
      return;
    }
    try {
      await this.webForItem(parent);
    }
    catch (error) {
      Zotero.debug(`Reading Room Tools: no web for ${parent.key}: ${error}`);
    }
  },
};
