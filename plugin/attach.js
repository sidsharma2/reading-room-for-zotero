/* Reading Room Tools: pictures and documents in the chat, by drag, paste or the paperclip.
 *
 * Zotero Agent already turns a pasted or dropped picture into a picture chip, and ignores every other file. So pictures
 * are handed to it, and documents are handled here: each is copied into uploads/ in the folder the chat runs in, with a
 * plain-text copy beside it, and one line in the message box names it. The agent reads it from there like any other
 * file, so this needs nothing from inside Zotero Agent but its message box.
 */
/* global Zotero, Services, Components, ChromeUtils, PathUtils, IOUtils, RRTools */
var RRAttach = {
  PICTURES: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" },
  OFFICE: ["pdf", "docx", "pptx", "xlsx"],
  TEXT: ["txt", "md", "csv", "tsv", "json", "xml", "html", "htm", "tex", "bib", "ris", "rtf", "log", "yaml", "yml", "toml", "ini",
    "py", "ipynb", "m", "r", "jl", "js", "ts", "c", "h", "cpp", "hpp", "cs", "java", "f90", "inp"],
  MAX_FILES: 10,
  MAX_BYTES: 100 * 1024 * 1024,
  MAX_ENTRY: 50 * 1024 * 1024, // one part of a Word or PowerPoint file, unpacked
  FOLDER: "uploads",

  // ---- plain functions, tested in test_attach.mjs ----

  extension(name) {
    return (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? "").toLowerCase();
  },

  kind(name) {
    const extension = this.extension(name);
    return extension in this.PICTURES ? "picture" : this.OFFICE.includes(extension) || this.TEXT.includes(extension) ? "document" : "";
  },

  /** Letters, digits, dots and hyphens only, so the name needs no quoting in a shell and cannot be read as an option. */
  safeName(name) {
    const extension = this.extension(name);
    const stem = (extension ? name.slice(0, -extension.length - 1) : name).normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80).replace(/[-.]+$/, "");
    const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stem);
    const safe = !stem ? "file" : reserved ? `file-${stem}` : stem;
    return extension ? `${safe}.${extension}` : safe;
  },

  /** Zotero ends each page with a form feed. Pages are marked as Zotero Agent marks them: a line [p.N] starts page N. */
  markPages(text) {
    const pages = text.split("\f");
    if (pages.length > 1 && !pages.at(-1).trim()) {
      pages.pop();
    }
    if (!pages.some((page) => page.trim())) {
      return { body: "", pages: pages.length };
    }
    return { body: pages.map((page, index) => `[p.${index + 1}]\n\n${page.trim() || "(no text on this page: a scan or a picture)"}`).join("\n\n"), pages: pages.length };
  },

  entities(text) {
    const named = { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" };
    return text.replace(/&(lt|gt|quot|apos|amp|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (whole, name) => {
      if (name[0] !== "#") {
        return named[name];
      }
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
  },

  /** The paragraphs of a Word or PowerPoint part. Text deleted with tracked changes is in other tags, so it is left out. */
  paragraphs(xml, prefix) {
    const run = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([^<]*)</${prefix}:t>|<${prefix}:tab\\b[^>]*/>|(<${prefix}:(?:br|cr)\\b[^>]*/>)`, "g");
    return xml.replace(new RegExp(`<${prefix}:pPr\\b[^>]*?(?:/>|>[\\s\\S]*?</${prefix}:pPr>)`, "g"), "")
      .split(`</${prefix}:p>`)
      .map((part) => [...part.matchAll(run)].map((match) => match[1] !== undefined ? this.entities(match[1]) : match[2] ? "\n" : "\t").join("").trim())
      .filter(Boolean)
      .join("\n\n");
  },

  /** What a Word or PowerPoint file says, from its parts by name. */
  officeText(extension, parts) {
    if (extension === "docx") {
      return [["word/document.xml", ""], ["word/footnotes.xml", "[footnotes]\n\n"], ["word/endnotes.xml", "[endnotes]\n\n"]]
        .map(([name, head]) => [head, this.paragraphs(parts[name] ?? "", "w")])
        .filter(([, body]) => body).map(([head, body]) => head + body).join("\n\n");
    }
    const number = (name) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
    return Object.keys(parts).sort((a, b) => number(a) - number(b))
      .map((name) => `[slide ${number(name)}]\n\n${this.paragraphs(parts[name], "a") || "(no text on this slide)"}`).join("\n\n");
  },

  partsWanted(extension) {
    return extension === "docx" ? /^word\/(document|footnotes|endnotes)\.xml$/ : /^ppt\/slides\/slide\d+\.xml$/;
  },

  /** The line in the message box. related_sources.py reads the same form. */
  line(name, { pages = 0, text = false, scan = false } = {}) {
    const facts = [pages ? `${pages} page${pages === 1 ? "" : "s"}` : "", text ? `text in ${name}.txt` : "", scan ? "no text layer" : ""].filter(Boolean);
    return `Attached: ${this.FOLDER}/${name}${facts.length ? ` (${facts.join(", ")})` : ""}`;
  },

  /** The lines go below what is already typed. In an empty box they leave room above for the question. */
  withLine(value, line) {
    const text = value.replace(/\s+$/, "");
    const after = /(^|\n)Attached: [^\n]*$/.test(text) ? "\n" : "\n\n";
    return `${text}${after}${line}`;
  },

  /** One file's line can start like another's (a.js and a.json), so whole lines are compared. */
  hasFile(value, name) {
    const bare = this.line(name);
    return value.split("\n").some((line) => line === bare || line.startsWith(`${bare} (`));
  },

  lineAt(value, wanted) {
    let at = 0;
    for (const line of value.split("\n")) {
      if (line === wanted) {
        return at;
      }
      at += line.length + 1;
    }
    return -1;
  },

  /** A drag that starts in Zotero can carry files as well as items, and it stays the panel's own. */
  carriesFiles(data) {
    const types = [...(data?.types ?? [])];
    return types.some((type) => type === "Files" || type === "application/x-moz-file") && !types.some((type) => type.startsWith("zotero/"));
  },

  filesOf(data) {
    return this.carriesFiles(data) ? [...(data.files ?? [])] : [];
  },

  // ---- inside Zotero ----

  /** The folder a new chat runs in, found the way Zotero Agent finds it. */
  chatFolder() {
    let chosen = "";
    try {
      chosen = JSON.parse(Zotero.Prefs.get("extensions.zotero-chat.settings", true) || "{}").chatFolder || "";
    }
    catch {
      // unreadable settings: the default folder
    }
    const forced = chosen || Services.env.get("ZMC_DEFAULT_CHAT_FOLDER"); // the variable is for test copies of Zotero
    if (forced) {
      return forced;
    }
    const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile);
    const documents = home.clone();
    documents.append("Documents");
    return PathUtils.join(documents.exists() ? documents.path : home.path, "Zotero-Agent");
  },

  watch(host, win) {
    const copy = (event) => {
      if (this.carriesFiles(event.dataTransfer)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        this.showDrop(win, true);
      }
    };
    const leave = () => this.showDrop(win, false); // inside the panel this does not fire, as the panel is one shadow tree
    const drop = (event) => {
      const files = this.filesOf(event.dataTransfer);
      this.showDrop(win, false);
      if (files.length) {
        event.preventDefault();
        // On the message box itself the panel takes the pictures, so only documents are handled here.
        const onBox = event.composedPath().some((element) => element.classList?.contains("composer"));
        this.take(win, files, { pictures: !onBox });
      }
    };
    const paste = (event) => {
      const files = this.filesOf(event.clipboardData).filter((file) => this.kind(file.name) === "document");
      if (files.length) {
        event.preventDefault();
        this.take(win, files, { pictures: false });
      }
    };
    const listeners = [["dragenter", copy], ["dragover", copy], ["dragleave", leave], ["drop", drop], ["paste", paste]];
    listeners.forEach(([type, handler]) => host.addEventListener(type, handler, true));
    return () => listeners.forEach(([type, handler]) => host.removeEventListener(type, handler, true));
  },

  /** The panel's own drop sign on the message box, shown for the whole panel. */
  showDrop(win, on) {
    this.box(win)?.closest(".composer")?.classList.toggle("composer--drop", on);
  },

  box(win) {
    return RRTools.panelRoot(win)?.querySelector("textarea.cin") ?? null;
  },

  async pick(win) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(win, "Choose pictures and documents for the chat", picker.modeOpenMultiple);
    const all = [...Object.keys(this.PICTURES), ...this.OFFICE, ...this.TEXT].map((extension) => `*.${extension}`).join("; ");
    picker.appendFilter("Pictures and documents", all);
    return await picker.show() === picker.returnOK ? this.takePaths(win, picker.files) : null;
  },

  async takePaths(win, paths) {
    const files = [];
    for (const path of paths) {
      files.push(await win.File.createFromFileName(path, { type: this.PICTURES[this.extension(path)] ?? "" }));
    }
    return this.take(win, files);
  },

  /** Hands pictures to the panel and copies documents. Says what could not be attached, and why. */
  async take(win, files, { pictures = true } = {}) {
    const box = this.box(win);
    const done = { pictures: 0, attached: [], refused: [] };
    if (!box) {
      return done;
    }
    const images = files.filter((file) => this.kind(file.name) === "picture");
    if (pictures && images.length) {
      if (this.dropPictures(win, box, images)) {
        done.pictures = images.length;
      }
      else {
        done.refused.push(`${images.map((file) => file.name).join(", ")}: the chat did not take the picture`);
      }
    }
    const rest = files.filter((file) => this.kind(file.name) !== "picture");
    for (const file of rest.slice(0, this.MAX_FILES)) {
      try {
        done.attached.push(await this.attach(win, file));
      }
      catch (error) {
        Zotero.debug(`Reading Room Tools: ${file.name} not attached: ${error}`);
        done.refused.push(`${file.name}: ${error.message}`);
      }
    }
    if (rest.length > this.MAX_FILES) {
      done.refused.push(`only the first ${this.MAX_FILES} of ${rest.length} files were attached`);
    }
    if (done.refused.length) {
      RRTools.notify(win, "Not attached", done.refused.join("\n"));
    }
    return done;
  },

  /** The panel reads pictures from a drop on its box, so the chips, the size limit and the preview stay its own. */
  dropPictures(win, box, files) {
    const data = new win.DataTransfer();
    files.forEach((file) => data.items.add(file));
    const event = new win.DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    (box.closest(".composer") ?? box).dispatchEvent(event);
    return event.defaultPrevented;
  },

  async attach(win, file) {
    if (this.kind(file.name) !== "document") {
      throw new Error("the chat takes PDF, Word, PowerPoint, Excel, text and code files, and PNG, JPEG, GIF and WebP pictures");
    }
    if (file.size > this.MAX_BYTES) {
      throw new Error(`larger than ${Math.round(this.MAX_BYTES / 1024 / 1024)} MB`);
    }
    const folder = PathUtils.join(this.chatFolder(), this.FOLDER);
    await IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true });
    const name = await this.copyIn(file, folder);
    const box = this.box(win);
    let line = this.line(name);
    if (box && !this.hasFile(box.value, name)) {
      this.setBox(win, box, this.withLine(box.value, line));
    }
    // The copy is in place, so a question sent now already works. The line gets its details when the text is ready.
    const facts = await this.writeText(PathUtils.join(folder, name));
    const full = this.line(name, facts);
    if (full !== line && box) {
      const at = this.lineAt(box.value, line);
      if (at >= 0) {
        box.setRangeText(full, at, at + line.length, "preserve");
        box.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
      line = full;
    }
    return { name, line, path: PathUtils.join(folder, name), ...facts };
  },

  setBox(win, box, value) {
    const caret = box.value.trim() ? box.selectionEnd : 0;
    box.value = value;
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    box.focus();
    box.setSelectionRange(caret, caret);
  },

  /** Copies the file under a safe name. The same file again keeps its copy, and another file of that name gets a number. */
  async copyIn(file, folder) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await this.sha256(bytes);
    const wanted = this.safeName(file.name);
    const extension = this.extension(wanted);
    const stem = extension ? wanted.slice(0, -extension.length - 1) : wanted;
    for (let number = 1; number < 1000; number++) {
      const name = number === 1 ? wanted : `${stem}-${number}${extension ? `.${extension}` : ""}`;
      const path = PathUtils.join(folder, name);
      if (await IOUtils.exists(path)) {
        if (await this.sha256(await IOUtils.read(path)) === digest) {
          return name;
        }
      }
      else if (!(await IOUtils.exists(`${path}.txt`))) {
        await IOUtils.write(path, bytes, { tmpPath: `${path}.part` });
        return name;
      }
    }
    throw new Error("too many files of that name");
  },

  async sha256(bytes) {
    const hash = Components.classes["@mozilla.org/security/hash;1"].createInstance(Components.interfaces.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return hash.finish(true);
  },

  /** A plain-text copy for the agents that cannot open the file, and for searching it. Without one, the file still works. */
  async writeText(path) {
    const extension = this.extension(path);
    try {
      let body = "";
      let pages = 0;
      if (extension === "pdf") {
        ({ body, pages } = await this.pdfText(path));
      }
      else if (extension === "docx" || extension === "pptx") {
        body = this.officeText(extension, this.readZip(path, this.partsWanted(extension)));
      }
      else {
        return {};
      }
      if (!body) {
        return { pages, scan: extension === "pdf" };
      }
      const head = `Text of ${PathUtils.filename(path)}, which the user attached.${pages ? ` A line [p.N] starts page N of ${pages}.` : ""}`;
      await IOUtils.writeUTF8(`${path}.txt`, `${head}\n\n${body}\n`, { tmpPath: `${path}.txt.part` });
      return { pages, text: true };
    }
    catch (error) {
      Zotero.debug(`Reading Room Tools: no text copy of ${PathUtils.filename(path)}: ${error}`);
      return {};
    }
  },

  /** Zotero's own PDF reader. Its public call takes a library item, so this asks the worker behind it. */
  async pdfText(path) {
    const worker = Zotero.PDFWorker;
    const buf = new Uint8Array(await IOUtils.read(path)).buffer;
    const result = await worker._enqueue(() => worker._query("pdf.getFulltext", { buf, maxPages: null }, [buf]), true);
    const { body, pages } = this.markPages(String(result?.text ?? ""));
    return { body, pages: Number(result?.totalPages) || pages };
  },

  readZip(path, wanted) {
    const { classes: Cc, interfaces: Ci } = Components;
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zip.open(Zotero.File.pathToFile(path));
    try {
      const parts = {};
      const names = zip.findEntries(null);
      while (names.hasMore()) {
        const name = names.getNext();
        if (wanted.test(name)) {
          if (zip.getEntry(name).realSize > this.MAX_ENTRY) {
            throw new Error(`${name} is too large to read`);
          }
          const stream = zip.getInputStream(name);
          parts[name] = NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
          stream.close();
        }
      }
      return parts;
    }
    finally {
      zip.close();
    }
  },
};
