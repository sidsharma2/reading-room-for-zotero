/* Reading Room Tools: the equation editor, "save as a note", and the connections web (connections.js).
 *
 * The equation editor writes plain LaTeX with dollar signs, because that is what Annotation Markdown renders and what
 * the agent reads. So nothing here depends on the editor: the text stays readable and exportable without this plugin.
 */
/* global Zotero, Services, PathUtils, IOUtils, ChromeUtils, RRConnections, RROrganise, RRAttach */
var RRTools = {
  id: "",
  rootURI: "",
  listeners: [],
  windows: new Map(),

  start(id, rootURI) {
    this.id = id;
    this.rootURI = rootURI;
    Zotero.RRTools = this;
    if (typeof RRConnections !== "undefined") {
      Zotero.RRConnections = RRConnections;
    }
    if (typeof RROrganise !== "undefined") {
      Zotero.RROrganise = RROrganise;
    }
    if (typeof RRAttach !== "undefined") {
      Zotero.RRAttach = RRAttach;
    }
    this.listen("renderToolbar", (event) => this.renderToolbar(event));
    this.listen("renderSidebarAnnotationHeader", (event) => this.renderAnnotationHeader(event));
    // The chat's source list reads a copy of the library, so keep it current when items change.
    this.observer = Zotero.Notifier.registerObserver({ notify: () => this.libraryChanged() }, ["item"], "rrtools");
    for (const win of Zotero.getMainWindows()) {
      this.addToWindow(win);
    }
  },

  stop() {
    for (const { type, handler } of this.listeners) {
      Zotero.Reader.unregisterEventListener(type, handler);
    }
    this.listeners = [];
    if (this.observer) {
      Zotero.Notifier.unregisterObserver(this.observer);
      this.observer = null;
    }
    Zotero.getMainWindow()?.clearTimeout(this.exportTimer);
    for (const win of [...this.windows.keys()]) {
      this.removeFromWindow(win);
    }
    delete Zotero.RRTools;
    delete Zotero.RRConnections;
    delete Zotero.RROrganise;
    delete Zotero.RRAttach;
  },

  listen(type, handler) {
    Zotero.Reader.registerEventListener(type, handler, this.id);
    this.listeners.push({ type, handler });
  },

  addToWindow(win) {
    if (this.windows.has(win)) {
      return;
    }
    const doc = win.document;
    const menu = doc.getElementById("menu_ToolsPopup");
    const items = [
      this.menuItem(doc, "rrtools-equation", "Insert Equation…", () => this.openEditor(win)),
      this.menuItem(doc, "rrtools-notes", "Save Annotations and Questions as a Note", () => this.saveCurrent(win)),
      this.menuItem(doc, "rrtools-web", "Connections Web for This Paper", () => this.openWeb(win)),
      this.menuItem(doc, "rrtools-map-collection", "Map This Collection", () => this.openCollection(win)),
      this.menuItem(doc, "rrtools-map", "Map My Library", () => this.openWeb(win, null, "library")),
      this.menuItem(doc, "rrtools-later", "Papers to Check Later", () => this.openWeb(win, null, "later")),
      this.menuItem(doc, "rrtools-openalex", "OpenAlex Key for Connections…", () => this.setOpenAlexKey(win)),
      this.menuItem(doc, "rrtools-plan", "Apply Library Plan…", () => this.applyPlan(win)),
      this.menuItem(doc, "rrtools-merge", "Merge Duplicates from a List…", () => this.mergeFromList(win)),
      this.menuItem(doc, "rrtools-tags", "Delete Imported Keyword Tags…", () => this.deleteKeywordTags(win)),
      this.menuItem(doc, "rrtools-items", "Apply Item Changes from a List…", () => this.applyItemChanges(win)),
    ];
    for (const item of items) {
      menu?.appendChild(item);
    }
    const context = this.menuItem(doc, "rrtools-web-item", "Show Connections Web", () => this.openWeb(win));
    doc.getElementById("zotero-itemmenu")?.appendChild(context);
    items.push(context);
    const collectionContext = this.menuItem(doc, "rrtools-map-menu", "Map This Collection", (event) => {
      event.stopPropagation();
      this.openCollection(win);
    });
    doc.getElementById("zotero-collectionmenu")?.appendChild(collectionContext);
    items.push(collectionContext);
    const button = this.webButton(win);
    if (button) {
      items.push(button);
    }
    if (!this.exported) {
      this.exported = true;
      win.setTimeout(() => this.exportLibrary(), 20000);
    }
    // Fill the connections cache while online, a few papers at a time, so the webs open offline later.
    const warm = () => typeof RRConnections !== "undefined" && RRConnections.warmUp();
    const warmFirst = win.setTimeout(warm, 3 * 60000);
    const warmTimer = win.setInterval(warm, 6 * 3600000);
    const onKey = (event) => {
      if (event.getModifierState("Accel") && event.shiftKey && event.code === "KeyM") {
        event.preventDefault();
        event.stopPropagation();
        this.openEditor(win);
      }
    };
    win.addEventListener("keydown", onKey, true);
    // The chat panel draws its own box and can redraw it, so look for it now and then.
    const timer = win.setInterval(() => this.addPanelButton(win), 2000);
    this.windows.set(win, { items, onKey, timer, warmFirst, warmTimer });
    this.addPanelButton(win);
  },

  removeFromWindow(win) {
    const state = this.windows.get(win);
    if (!state) {
      return;
    }
    state.items.forEach((item) => item.remove());
    win.removeEventListener("keydown", state.onKey, true);
    win.clearInterval(state.timer);
    win.clearTimeout(state.warmFirst);
    win.clearInterval(state.warmTimer);
    const root = this.panelRoot(win);
    root?.querySelectorAll(".rr-eq, .rr-attach, .rr-files").forEach((element) => element.remove());
    root?.removeEventListener("click", this.onPanelClick, true);
    state.unwatch?.();
    this.windows.delete(win);
  },

  menuItem(doc, id, label, command) {
    const item = doc.createXULElement("menuitem");
    item.id = id;
    item.setAttribute("label", label);
    item.addEventListener("command", command);
    return item;
  },

  panelRoot(win) {
    return win.document.getElementById("zmc-root")?.shadowRoot ?? null;
  },

  button(doc, label, title, onClick) {
    const button = doc.createElement("button");
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    // Keep the focus where it is, so the insertion point survives the click.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
    return button;
  },

  /** Wiki links reach the panel as zotero://rr-wiki links, because it only draws http and zotero links. */
  onPanelClick: (event) => {
    const link = event.target.closest?.('[data-href^="zotero://rr-wiki/"]');
    if (link) {
      event.preventDefault();
      event.stopPropagation();
      RRTools.openWiki(link.getAttribute("data-href"));
    }
  },

  wikiURL(href) {
    const path = new URL(href).searchParams.get("path") ?? "";
    return /\.md$/i.test(path) ? `obsidian://open?path=${encodeURIComponent(path)}` : null;
  },

  openWiki(href) {
    const url = this.wikiURL(href);
    if (url) {
      Zotero.launchURL(url);
    }
  },

  addPanelButton(win) {
    const root = this.panelRoot(win);
    const box = root?.querySelector("textarea.cin");
    if (root) {
      root.addEventListener("click", this.onPanelClick, true); // adding the same listener twice does nothing
      this.watchFiles(win, root.host);
    }
    if (!box) {
      return;
    }
    this.addAttachButton(win, root, box);
    if (typeof RRAttach !== "undefined") {
      RRAttach.tiles(win); // sending clears the box without an event
    }
    if (root.querySelector(".rr-eq")) {
      return;
    }
    const button = this.button(win.document, "Σ", "Insert equation", () => this.openEditor(win, { kind: "text", element: box }));
    button.className = "rr-eq";
    button.style.cssText = "position:absolute;right:6px;top:6px;z-index:5;width:24px;height:24px;padding:0;border:1px solid var(--line,#8886);"
      + "border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;opacity:.75";
    if (win.getComputedStyle(box.parentElement).position === "static") {
      box.parentElement.style.position = "relative";
    }
    box.parentElement.appendChild(button);
  },

  /** Files dropped or pasted anywhere on the chat. The panel can be replaced while Zotero runs, by its own update. */
  watchFiles(win, host) {
    const state = this.windows.get(win);
    if (typeof RRAttach === "undefined" || !state || state.watched === host) {
      return;
    }
    state.unwatch?.();
    state.unwatch = RRAttach.watch(host, win);
    state.watched = host;
  },

  /** A paperclip beside the panel's + button, or beside the box if that row is not there. */
  addAttachButton(win, root, box) {
    if (typeof RRAttach === "undefined" || root.querySelector(".rr-attach")) {
      return;
    }
    const button = this.button(win.document, "", "Attach pictures or documents", () => RRAttach.pick(win));
    const plus = root.querySelector(".composer .ctools > .iconbtn");
    button.appendChild(RRAttach.icon(win.document, "clip"));
    button.type = "button";
    if (plus) {
      button.className = "rr-attach iconbtn iconbtn--sm";
      plus.after(button);
      return;
    }
    button.className = "rr-attach";
    button.style.cssText = "position:absolute;right:36px;top:6px;z-index:5;width:24px;height:24px;padding:0;border:1px solid var(--line,#8886);"
      + "border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.75";
    box.parentElement.appendChild(button);
  },

  renderToolbar({ reader, doc, append }) {
    const equation = this.button(doc, "Σ", "Insert equation (Ctrl+Shift+M)", () => this.openEditor(reader._window));
    const notes = this.button(doc, "Save notes", "Save this paper's annotations and questions as a note", () => this.saveToNotes(reader._item, reader._window));
    const web = this.button(doc, "Web", "Connections web: what this paper cites, what cites it, and what is similar", () => this.openWeb(reader._window, reader._item?.parentItem ?? reader._item));
    for (const button of [equation, notes, web]) {
      button.className = "toolbar-button";
      button.style.cssText = "width:auto;padding:0 6px;font-size:13px";
      append(button);
    }
    if (typeof RRConnections !== "undefined") {
      RRConnections.prefetch(reader._item); // so the chat has this paper's neighbours by the first question
    }
  },

  // ---- the connections web ----

  libraryChanged() {
    if (typeof RRConnections !== "undefined") {
      RRConnections.rowsCache = null;
    }
    const win = Zotero.getMainWindow();
    if (win) {
      win.clearTimeout(this.exportTimer);
      this.exportTimer = win.setTimeout(() => this.exportLibrary(), 60000);
    }
  },

  exportLibrary() {
    RRConnections.exportLibrary().catch((error) => Zotero.debug(`Reading Room Tools: library copy not written: ${error}`));
  },

  currentItem(win) {
    const tab = win.Zotero_Tabs?._getTab?.(win.Zotero_Tabs.selectedID)?.tab;
    const reader = tab?.type?.startsWith("reader") ? Zotero.Reader.getByTabID(tab.id) : null;
    const item = reader?._item ?? win.ZoteroPane?.getSelectedItems?.()[0];
    const parent = item?.isAttachment?.() || item?.isNote?.() ? item.parentItem : item;
    return parent?.isRegularItem?.() ? parent : null;
  },

  /** A button beside New Note in the main window, so the web is one click away. */
  webButton(win) {
    const doc = win.document;
    const bar = doc.getElementById("zotero-items-toolbar");
    if (!bar) {
      return null;
    }
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="context-stroke" stroke-width="1.3">`
      + `<path d="M6.6 8.2 12.4 5.4M6.6 11.2l5.8 3.2M14.5 7v5.6"/><circle cx="4.7" cy="9.7" r="2.3"/><circle cx="14.5" cy="4.7" r="2.1"/><circle cx="14.5" cy="15" r="2.1"/></svg>`;
    const button = doc.createXULElement("toolbarbutton");
    button.id = "rrtools-tb-web";
    button.className = "zotero-tb-button";
    button.setAttribute("type", "menu");
    button.setAttribute("wantdropmarker", "true");
    button.setAttribute("tabindex", "-1");
    button.setAttribute("tooltiptext", "Connections: find linked papers");
    button.setAttribute("aria-label", "Connections: find linked papers");
    button.style.cssText = `list-style-image: url("data:image/svg+xml;utf8,${encodeURIComponent(icon)}"); -moz-context-properties: stroke; stroke: currentColor;`;
    const popup = doc.createXULElement("menupopup");
    popup.addEventListener("popupshowing", () => this.fillWebMenu(win, popup));
    button.appendChild(popup);
    const before = doc.getElementById("zotero-tb-note-add")?.nextElementSibling ?? null;
    bar.insertBefore(button, before);
    return button;
  },

  fillWebMenu(win, popup) {
    const doc = win.document;
    const short = (text) => (text.length > 48 ? `${text.slice(0, 47)}…` : text);
    const paper = this.currentItem(win);
    const collection = win.ZoteroPane?.getSelectedCollection?.() || null;
    const entry = (label, command, enabled = true) => {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", label);
      if (!enabled) {
        item.setAttribute("disabled", "true");
      }
      item.addEventListener("command", command);
      return item;
    };
    popup.replaceChildren(
      entry(paper ? `Linked to “${short(paper.getDisplayTitle())}”` : "Linked to the selected paper", () => this.openWeb(win, paper), !!paper),
      entry(collection ? `Map “${short(collection.name)}”` : "Map the selected collection", () => this.openCollection(win), !!collection),
      entry("Map My Library", () => this.openWeb(win, null, "library")),
      doc.createXULElement("menuseparator"),
      entry("Papers to Check Later", () => this.openWeb(win, null, "later")),
    );
  },

  openCollection(win) {
    const collection = win.ZoteroPane?.getSelectedCollection?.() || null;
    if (!collection) {
      this.notify(win, "No collection selected", "Select a collection in the left pane first.");
      return null;
    }
    return this.openWeb(win, null, "collection", collection);
  },

  openWeb(win, item = null, mode = "paper", collection = null) {
    const focal = mode === "paper" ? (item?.isRegularItem?.() ? item : this.currentItem(win)) : null;
    if (mode === "paper" && !focal) {
      this.notify(win, "No paper selected", "Open a paper or select one in your library.");
      return null;
    }
    const libraryID = collection?.libraryID ?? focal?.libraryID ?? Zotero.Libraries.userLibraryID;
    const target = { libraryID, key: focal?.key ?? "", wid: "", mode, collection: collection?.key ?? "" };
    const handle = (action, setTitle) => this.handleWeb(action, target, win, setTitle);
    return win.openDialog("chrome://rrtools/content/web.xhtml", "", "chrome,dialog=no,resizable,centerscreen", { url: "resource://rrtools/web.html", handle });
  },

  /** Each request from the web page, checked: keys, work ids and DOIs must look right, and links must be https. */
  async handleWeb(action, target, win, setTitle = () => {}) {
    const key = /^[A-Z0-9]{8}$/.test(String(action.key || "")) ? action.key : "";
    const wid = /^W\d+$/.test(String(action.wid || "")) ? action.wid : "";
    const doi = RRConnections.normalDOI(action.doi);
    const item = key ? Zotero.Items.getByLibraryAndKey(target.libraryID, key) : null;
    if (["refresh", "centre", "map", "later"].includes(action.type)) {
      const named = /^[A-Z0-9]{8}$/.test(String(action.collection || "")) ? action.collection : "";
      if (action.type === "map" || action.mode === "library") {
        Object.assign(target, { mode: "library", key: "", wid: "", collection: "" });
      }
      else if (action.mode === "collection" && named) {
        Object.assign(target, { mode: "collection", key: "", wid: "", collection: named });
      }
      else if (action.type === "later" || action.mode === "later") {
        Object.assign(target, { mode: "later", key: "", wid: "" });
      }
      else if (item?.isRegularItem()) {
        Object.assign(target, { mode: "paper", key: item.key, wid: "" });
      }
      else if (wid) {
        Object.assign(target, { mode: "paper", key: "", wid });
      }
      else if (action.type === "centre") {
        return null;
      }
    }
    const refresh = action.type === "refresh";
    const collection = target.collection ? Zotero.Collections.getByLibraryAndKey(target.libraryID, target.collection) || null : null;
    // While a web was reached from a collection, Add puts papers in that collection.
    const inCollection = (web) => Object.assign(web, collection ? { collection: { key: collection.key, name: collection.name } } : {});
    switch (action.type) {
      case "ready":
      case "refresh":
      case "centre":
      case "later":
      case "map": {
        if (target.mode === "later") {
          setTitle("Papers to check later");
          return { type: "web", web: await RRConnections.laterShow(target.libraryID) };
        }
        if (target.mode === "library") {
          setTitle("Connections: your library");
          return { type: "web", web: await RRConnections.libraryMap(target.libraryID, refresh) };
        }
        if (target.mode === "collection") {
          if (!collection) {
            throw new Error("That collection is no longer in the library.");
          }
          setTitle(`Connections: ${collection.name}`);
          return { type: "web", web: inCollection(await RRConnections.libraryMap(target.libraryID, refresh, collection)) };
        }
        if (target.wid) {
          setTitle("Connections");
          return { type: "web", web: inCollection(await RRConnections.webForWork(target.wid, refresh)) };
        }
        const focal = Zotero.Items.getByLibraryAndKey(target.libraryID, target.key);
        if (!focal) {
          throw new Error("That item is no longer in the library.");
        }
        setTitle(`Connections: ${focal.getDisplayTitle()}`);
        return { type: "web", web: inCollection(await RRConnections.webForItem(focal, refresh)) };
      }
      case "expand":
        return wid ? { type: "merge", web: await RRConnections.webForWork(wid) } : null;
      case "abstract":
        return wid ? { type: "abstract", wid, text: await RRConnections.abstractOf(wid) } : null;
      case "show":
        if (item) {
          await win.ZoteroPane.selectItem(item.id);
          win.focus();
        }
        return { type: "done" };
      case "read": {
        const attachment = item ? await item.getBestAttachment() : null;
        if (attachment) {
          await Zotero.Reader.open(attachment.id);
          win.focus();
        }
        return { type: "done", text: attachment ? "" : "No file found for this item." };
      }
      case "add": {
        if (!doi) {
          return null;
        }
        const added = await RRConnections.addByDOI(doi, collection);
        if (added) {
          const list = await RRConnections.laterList();
          await RRConnections.laterSave(list.filter((entry) => entry.doi !== doi));
        }
        return { type: "added", doi, key: added?.key || "", place: collection?.name || "My Library" };
      }
      case "file": {
        // A paper you already have, put in the collection as well. It stays where it was.
        if (item?.isRegularItem() && collection && !item.inCollection(collection.id)) {
          item.addToCollection(collection.id);
          await item.saveTx();
        }
        return item && collection ? { type: "filed", key: item.key, place: collection.name } : null;
      }
      case "later-add": {
        // The page sends what it shows. laterEntry keeps only known fields, as plain text, with checked ids and links.
        const from = target.key ? Zotero.Items.getByLibraryAndKey(target.libraryID, target.key) : null;
        const entry = RRConnections.laterEntry(action.work || {}, { key: from?.key || "", title: from?.getDisplayTitle?.() || "" });
        const list = RRConnections.laterAdd(await RRConnections.laterList(), entry);
        await RRConnections.laterSave(list);
        return { type: "saved", id: entry.id, doi: entry.doi, saved: list.some((item) => item.id === entry.id), count: list.length };
      }
      case "later-remove": {
        const id = String(action.id || "").slice(0, 200);
        const list = RRConnections.laterRemove(await RRConnections.laterList(), id);
        await RRConnections.laterSave(list);
        return { type: "saved", id, saved: false, count: list.length };
      }
      case "later-add-all": {
        const result = await RRConnections.laterAddAll(target.libraryID);
        return { type: "web", web: { ...await RRConnections.laterShow(target.libraryID), problem: result.problem, report: result } };
      }
      case "link": {
        const url = doi ? `https://doi.org/${doi}` : /^https:\/\/[^\s]+$/.test(String(action.url || "")) ? String(action.url) : "";
        if (url) {
          Zotero.launchURL(url);
        }
        return { type: "done" };
      }
      default:
        return null;
    }
  },

  async pickCSV(win, title) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(win, title, picker.modeOpen);
    picker.appendFilter("CSV", "*.csv");
    return await picker.show() === picker.returnOK ? IOUtils.readUTF8(picker.file) : null;
  },

  /** A CSV with "key" and "merge into" columns: shows each merge, then uses Zotero's own merge. */
  async mergeFromList(win) {
    const text = await this.pickCSV(win, "Choose the list of duplicates to merge");
    if (text === null) {
      return null;
    }
    const plan = await RROrganise.previewMerges(text);
    if (!plan.merges.length) {
      Services.prompt.alert(win, "Nothing to merge", RROrganise.describeMerges(plan));
      return null;
    }
    if (!Services.prompt.confirm(win, "Merge these duplicates?", RROrganise.describeMerges(plan))) {
      return null;
    }
    const log = await RROrganise.applyMerges(plan);
    this.notify(win, "Duplicates merged", `${log.merged.length} merged. Log: ${log.file}`);
    return log;
  },

  /** A CSV such as papers.py dois writes: sets DOIs and moves items to the trash, after showing every change. */
  async applyItemChanges(win) {
    const text = await this.pickCSV(win, "Choose the list of item changes (doi-lookup.csv)");
    if (text === null) {
      return null;
    }
    const plan = await RROrganise.previewItemChanges(text);
    const days = Zotero.Prefs.get("trashAutoEmptyDays") ?? 30;
    if (!plan.setDOI.length && !plan.trash.length) {
      Services.prompt.alert(win, "Nothing to change", RROrganise.describeItemChanges(plan, days));
      return null;
    }
    if (!Services.prompt.confirm(win, "Apply these item changes?", RROrganise.describeItemChanges(plan, days))) {
      return null;
    }
    const log = await RROrganise.applyItemChanges(plan);
    this.notify(win, "Item changes applied", `${log.setDOI.length} DOIs set, ${log.trashed.length} items moved to the trash. Log: ${log.file}`);
    return log;
  },

  /** Deletes the tags used only on papers, after showing how many and which stay. */
  async deleteKeywordTags(win) {
    const plan = await RROrganise.previewTags();
    if (!plan.remove.length) {
      Services.prompt.alert(win, "No keyword tags", "Every tag here is on a note or an annotation, or has a colour.");
      return null;
    }
    if (!Services.prompt.confirm(win, "Delete the imported keyword tags?", RROrganise.describeTags(plan))) {
      return null;
    }
    const log = await RROrganise.deleteTags(plan);
    this.notify(win, "Keyword tags deleted", `${log.removed.length} tags removed. Log: ${log.file}`);
    return log;
  },

  /** A plan made by papers.py: pick the CSV, read what would change, and only then apply it. */
  async applyPlan(win) {
    const text = await this.pickCSV(win, "Choose the library plan (reorganisation-plan.csv)");
    if (text === null) {
      return null;
    }
    const plan = await RROrganise.preview(text);
    const retire = { value: plan.trash.length > 0 };
    const describe = (p) => RROrganise.describe(p);
    // A checkbox label reads a single & as a keyboard-shortcut marker, so a collection named "A & B" needs it doubled.
    const label = (plan.trash.length ? `Also move ${plan.trash.map((entry) => entry.path).join(" and ")} to the trash` : "Nothing to move to the trash").replace(/&/g, "&&");
    if (!Services.prompt.confirmCheck(win, "Apply the library plan?", describe(plan), label, retire)) {
      return null;
    }
    const final = retire.value ? plan : await RROrganise.preview(text, Zotero.Libraries.userLibraryID, { retire: false });
    const log = await RROrganise.apply(final);
    this.notify(win, "Library plan applied", `${log.created.length} collections made, ${final.total} items filed, ${log.trashed.length} moved to the trash. Log: ${log.file}`);
    return log;
  },

  setOpenAlexKey(win) {
    const value = { value: Zotero.Prefs.get("extensions.rrtools.openalexKey", true) || "" };
    const text = "Without a key, OpenAlex allows about 1,000 requests a day, shared with everyone on your network. "
      + "A free key from openalex.org/settings/api raises that. Paste it here, or clear the box to stop using one.";
    if (Services.prompt.prompt(win, "OpenAlex key", text, value, null, {})) {
      Zotero.Prefs.set("extensions.rrtools.openalexKey", value.value.trim(), true);
    }
  },

  renderAnnotationHeader({ reader, doc, params, append }) {
    const button = this.button(doc, "Σ", "Add an equation to this comment", () => {
      this.openEditor(reader._window, { kind: "annotation", reader, key: params.annotation.id });
    });
    button.className = "rr-eq";
    button.style.cssText = "border:0;background:transparent;color:inherit;cursor:pointer;padding:0 4px;opacity:.7";
    append(button);
  },

  /** The element that has the focus, looking through frames and shadow roots. */
  deepActive(win) {
    let element = win.document.activeElement;
    for (let depth = 0; element && depth < 8; depth++) {
      if (element.shadowRoot?.activeElement) {
        element = element.shadowRoot.activeElement;
      }
      else if (["iframe", "browser"].includes(element.localName) && element.contentDocument?.activeElement) {
        element = element.contentDocument.activeElement;
      }
      else {
        break;
      }
    }
    return element;
  },

  /** Where an equation should go, taken before the editor window moves the focus. */
  findTarget(win) {
    const element = this.deepActive(win);
    if (element?.localName === "textarea" || (element?.localName === "input" && element.type === "text")) {
      return { kind: "text", element, start: element.selectionStart, end: element.selectionEnd };
    }
    if (element?.isContentEditable) {
      const selection = element.ownerGlobal.getSelection();
      return { kind: "editable", element, range: selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null };
    }
    const open = this.openComment(win);
    if (open) {
      return open;
    }
    const box = this.panelRoot(win)?.querySelector("textarea.cin");
    return box ? { kind: "text", element: box } : { kind: "clipboard" };
  },

  /** A comment open for editing in the paper on screen, so the toolbar button goes there before the chat box. */
  openComment(win) {
    const selected = win.Zotero_Tabs?.selectedID;
    const reader = selected ? Zotero.Reader.getByTabID(selected) : null;
    const card = reader?._iframeWindow?.document?.querySelector('[data-sidebar-annotation-id] [contenteditable="true"]')?.closest("[data-sidebar-annotation-id]");
    return card ? { kind: "annotation", reader, key: card.getAttribute("data-sidebar-annotation-id") } : null;
  },

  openEditor(win, target = null) {
    const place = target ?? this.findTarget(win);
    const url = `resource://rrtools/equation.html#${encodeURIComponent(JSON.stringify(this.recent()))}`;
    const insert = (text, latex) => {
      this.remember(latex);
      this.insert(place, text, win);
    };
    win.openDialog("chrome://rrtools/content/host.xhtml", "rrtools-equation", "chrome,dialog=no,resizable,dependent,centerscreen", { url, insert });
    return place;
  },

  recent() {
    try {
      return JSON.parse(Zotero.Prefs.get("extensions.rrtools.recent", true) || "[]");
    }
    catch {
      return [];
    }
  },

  remember(latex) {
    const kept = [latex, ...this.recent().filter((item) => item !== latex)].slice(0, 8);
    Zotero.Prefs.set("extensions.rrtools.recent", JSON.stringify(kept), true);
  },

  async insert(place, text, win) {
    if (place.kind === "annotation") {
      await this.insertInAnnotation(place, text);
    }
    else if (place.kind === "text") {
      this.insertInBox(place, text);
    }
    else if (place.kind === "editable") {
      this.insertInEditable(place, text);
    }
    else {
      Zotero.Utilities.Internal.copyTextToClipboard(text);
      this.notify(win, "Copied the equation", "Nothing was selected to type into, so paste it where you want it.");
    }
  },

  insertInBox({ element, start, end }, text) {
    const window_ = element.ownerGlobal;
    const from = start ?? element.selectionStart ?? element.value.length;
    const to = end ?? element.selectionEnd ?? from;
    element.focus();
    element.setRangeText(text, from, to, "end");
    element.dispatchEvent(new window_.Event("input", { bubbles: true }));
  },

  insertInEditable({ element, range }, text) {
    const window_ = element.ownerGlobal;
    element.focus();
    if (range) {
      const selection = window_.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    element.ownerDocument.execCommand("insertText", false, text);
  },

  /** Adds to the end of the comment. If that comment is being edited, types at the cursor instead. */
  async insertInAnnotation({ reader, key }, text) {
    const open = reader?._iframeWindow?.document?.querySelector(`[data-sidebar-annotation-id="${key}"] [contenteditable="true"]`);
    if (open && open.ownerDocument.activeElement === open) {
      const selection = open.ownerGlobal.getSelection();
      this.insertInEditable({ element: open, range: selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null }, text);
      return;
    }
    const item = Zotero.Items.getByLibraryAndKey(reader._item.libraryID, key);
    if (!item) {
      throw new Error(`no annotation ${key}`);
    }
    const comment = item.annotationComment || "";
    item.annotationComment = comment ? `${comment}\n\n${text}` : text;
    await item.saveTx();
  },

  notify(win, title, body) {
    const progress = new Zotero.ProgressWindow({ closeOnClick: true });
    progress.changeHeadline(title);
    progress.addDescription(body);
    progress.show();
    progress.startCloseTimer(5000);
  },

  async saveCurrent(win) {
    const tab = win.Zotero_Tabs?._getTab?.(win.Zotero_Tabs.selectedID)?.tab;
    const reader = tab?.type?.startsWith("reader") ? Zotero.Reader.getByTabID(tab.id) : null;
    const selected = reader?._item ?? win.ZoteroPane.getSelectedItems?.()[0];
    if (!selected) {
      this.notify(win, "No paper selected", "Open a paper or select one in your library.");
      return null;
    }
    return this.saveToNotes(selected, win);
  },

  /** Saves what has not been saved yet into a new child note. Earlier notes stay as they are, edits included. */
  async saveToNotes(selected, win) {
    const parent = selected.isAttachment() || selected.isNote() ? (selected.parentItem ?? selected) : selected;
    const attachments = selected.isAttachment() ? [selected] : parent.getAttachments().map((id) => Zotero.Items.get(id)).filter((item) => item.isPDFAttachment?.());
    const saved = await this.readSaved();
    const record = saved[parent.key] ?? { annotations: [], turns: [] };
    const annotations = attachments.flatMap((item) => item.getAnnotations())
      .filter((item) => !record.annotations.includes(item.key))
      .sort((a, b) => (a.annotationSortIndex || "").localeCompare(b.annotationSortIndex || ""));
    const turns = (await this.readTurns(parent.key, attachments.map((item) => item.key))).filter((turn) => !record.turns.includes(turn.id));
    if (!annotations.length && !turns.length) {
      this.notify(win, "Nothing new to save", "Every annotation and question on this paper is already in a note.");
      return { annotations: 0, questions: 0, note: null };
    }
    let note;
    if (annotations.length) {
      note = await Zotero.EditorInstance.createNoteFromAnnotations(annotations, { parentID: parent.id });
    }
    else {
      note = new Zotero.Item("note");
      note.libraryID = parent.libraryID;
      note.parentID = parent.id;
      await note.saveTx();
    }
    const html = this.mathInHTML(note.getNote(), win) + this.turnsHTML(turns);
    note.setNote(html);
    note.addTag("reading-room");
    await note.saveTx();
    saved[parent.key] = { annotations: [...record.annotations, ...annotations.map((item) => item.key)], turns: [...record.turns, ...turns.map((turn) => turn.id)] };
    await this.writeSaved(saved);
    const count = (number, word) => `${number} ${word}${number === 1 ? "" : "s"}`;
    this.notify(win, "Saved as a note", `${count(annotations.length, "annotation")} and ${count(turns.length, "question")} on this paper.`);
    return { annotations: annotations.length, questions: turns.length, note: note.key };
  },

  savedPath() {
    return PathUtils.join(Zotero.Profile.dir, "zotero-chat", "reading-room-notes.json");
  },

  async readSaved() {
    try {
      return await IOUtils.readJSON(this.savedPath());
    }
    catch {
      return {};
    }
  },

  async writeSaved(value) {
    await IOUtils.makeDirectory(PathUtils.parent(this.savedPath()), { ignoreExisting: true });
    await IOUtils.writeJSON(this.savedPath(), value);
  },

  /** Each question asked about this paper in the chat panel, with its answer. */
  async readTurns(itemKey, attachmentKeys) {
    const folder = PathUtils.join(Zotero.Profile.dir, "zotero-chat", "sessions");
    if (!(await IOUtils.exists(folder))) {
      return [];
    }
    const turns = [];
    for (const path of await IOUtils.getChildren(folder)) {
      if (!path.endsWith(".jsonl")) {
        continue;
      }
      let current = null;
      let about = false;
      const lines = (await IOUtils.readUTF8(path)).split("\n").filter(Boolean);
      for (let number = 0; number < lines.length; number++) {
        let event;
        try {
          event = JSON.parse(lines[number]);
        }
        catch {
          continue;
        }
        if (event.t === "user") {
          const refs = (event.chips ?? []).map((chip) => chip.ref ?? {});
          about = refs.some((ref) => ref.itemKey === itemKey || attachmentKeys.includes(ref.attachmentKey));
          current = null;
          if (about) {
            const page = refs.map((ref) => ref.pageLabel).find(Boolean) ?? "";
            current = { id: `${PathUtils.filename(path)}:${number}`, question: event.text ?? "", page, answer: "" };
            turns.push(current);
          }
        }
        else if (event.t === "text" && current) {
          current.answer += `${current.gap ? "\n\n" : ""}${event.delta ?? ""}`;
          current.gap = false;
        }
        else if (current?.answer) {
          current.gap = true; // a tool ran, so the text after it starts a new paragraph
        }
      }
    }
    return turns.filter((turn) => turn.answer.trim());
  },

  escape(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  /** Turns $...$ and $$...$$ into the math Zotero's note editor draws. Nothing else in the note changes. */
  mathInHTML(html, win) {
    const parsed = new win.DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = parsed.body.firstElementChild;
    const walker = parsed.createTreeWalker(root, 4);
    const nodes = [];
    while (walker.nextNode()) {
      if (/\$|\*\*/.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement.closest(".math")) {
        nodes.push(walker.currentNode);
      }
    }
    for (const node of nodes) {
      const holder = parsed.createElement("div");
      holder.innerHTML = this.bold(this.mathInText(this.escape(node.nodeValue)));
      const fragment = parsed.createDocumentFragment();
      fragment.append(...holder.childNodes);
      node.replaceWith(fragment);
    }
    for (const paragraph of [...root.querySelectorAll("p")]) {
      const math = paragraph.firstElementChild;
      if (paragraph.childNodes.length === 1 && math?.matches("span.math[data-display]")) {
        const block = parsed.createElement("pre");
        block.className = "math";
        block.textContent = `$$${math.textContent.slice(1, -1).replace("\\displaystyle ", "")}$$`;
        paragraph.replaceWith(block);
      }
    }
    return root.innerHTML;
  },

  /** Works on text that is already escaped. A note can only hold a display equation on its own line, so one in the
   * middle of a line becomes inline math set in display style. */
  mathInText(text) {
    return text.replace(/\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])/g, (whole, display) => {
      return display === undefined ? `<span class="math">${whole}</span>` : `<span class="math" data-display="1">$\\displaystyle ${display}$</span>`;
    });
  },

  bold(html) {
    return html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  },

  /** A small Markdown reader for answers: paragraphs, headings, lists, code, bold, italics, links and math. */
  markdownHTML(text) {
    const wiki = (line) => line.replace(/zotero:\/\/rr-wiki\/open\?path=/g, "obsidian://open?path=");
    const inline = (line) => this.bold(this.mathInText(this.escape(wiki(line))))
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "<em>$1</em>")
      .replace(/\[([^\]\n]+)\]\(((?:https?|zotero|obsidian):[^)\s]+)\)/g, '<a href="$2">$1</a>');
    const out = [];
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split("\n").filter((line) => line.trim());
      if (!lines.length) {
        continue;
      }
      if (block.trim().startsWith("```")) {
        out.push(`<pre>${this.escape(block.trim().replace(/^```\w*\n?|\n?```$/g, ""))}</pre>`);
      }
      else if (lines.every((line) => /^\s*([-*]|\d+\.)\s/.test(line))) {
        const tag = /^\s*\d/.test(lines[0]) ? "ol" : "ul";
        out.push(`<${tag}>${lines.map((line) => `<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`).join("")}</${tag}>`);
      }
      else if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) {
        out.push(`<h3>${inline(lines[0].replace(/^#+\s+/, ""))}</h3>`);
      }
      else if (/^\$\$[\s\S]*\$\$$/.test(block.trim())) {
        out.push(`<pre class="math">${this.escape(block.trim())}</pre>`);
      }
      else {
        out.push(`<p>${lines.map(inline).join("<br/>")}</p>`);
      }
    }
    return out.join("");
  },

  turnsHTML(turns) {
    if (!turns.length) {
      return "";
    }
    const parts = ["<h2>Questions</h2>"];
    for (const turn of turns) {
      const page = turn.page ? ` (p.${this.escape(turn.page)})` : "";
      parts.push(`<p><strong>Question${page}:</strong> ${this.mathInText(this.escape(turn.question))}</p>`);
      parts.push("<p><em>Agent answer, not checked. Verify it against the paper before reuse.</em></p>");
      parts.push(this.markdownHTML(turn.answer));
    }
    return parts.join("");
  },
};
