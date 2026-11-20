/* The connections web window. It draws what the plugin sends and asks the plugin to act.
 *
 * This page has no Zotero privileges. It can only send small requests (open, add, expand), and every title is set as
 * text, so a paper title can never become markup or a command.
 */
"use strict";

const SVG = "http://www.w3.org/2000/svg";
const GROUPS = {
  paper: [
    ["references", "Earlier work", "cited by this paper"],
    ["citing", "Later work", "cites this paper"],
    ["related", "Similar", "OpenAlex rates it similar"],
    ["library", "Same words, in your library", "in your library, with many of the same words"],
    ["expanded", "From expanding", "added when you expanded a paper"],
  ],
  library: [
    ["mine", "Your papers", "in your library"],
    ["earlier", "Earlier work several of yours cite", ""],
    ["later", "Later work that cites several of yours", ""],
    ["expanded", "From expanding", "added when you expanded a paper"],
  ],
  later: [
    ["saved", "Saved to check later", "you saved it to check later"],
  ],
};
// Where each group gathers: earlier work on the left, later work on the right, as on a timeline.
const ANCHORS = { focal: [0, 0], references: [-480, 0], citing: [480, 0], related: [0, 340], library: [0, -320], mine: [0, 0], earlier: [-560, 0], later: [560, 0], expanded: [0, 440], saved: [0, 0] };
const MARKS = { have: "In your library, with a PDF", wanted: "In your library, no PDF here", new: "Not in your library" };

const state = { web: null, byId: new Map(), selected: "", shown: new Set(), history: [], next: "replace", view: { x: 0, y: 0, k: 1 }, abstracts: new Map(), lonely: false };
const $ = (id) => document.getElementById(id);

function send(message) {
  document.dispatchEvent(new CustomEvent("rr-action", { bubbles: true, detail: JSON.stringify(message) }));
}

function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}

function ask(message, note = "") {
  status(note);
  send(message);
}

function el(name, attributes = {}) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function html(name, text = "", className = "") {
  const node = document.createElement(name);
  node.textContent = text;
  if (className) {
    node.className = className;
  }
  return node;
}

function who(node) {
  const first = String(node.authors?.[0] || "").trim().split(/\s+/).pop() || "Unknown";
  return node.authors?.length > 1 || node.more ? `${first} et al.` : first;
}

function shortTitle(text, limit = 60) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function groupName(group) {
  return (GROUPS[state.web.mode].find(([name]) => name === group) || [])[2] || "";
}

// ---- messages from the plugin ----

document.addEventListener("rr-data", (event) => {
  let message;
  try {
    message = JSON.parse(String(event.detail));
  }
  catch {
    return;
  }
  if (message.type === "web") {
    if (state.next === "push" && state.web) {
      state.history.push(state.web);
    }
    show(message.web);
  }
  else if (message.type === "merge") {
    merge(message.web);
  }
  else if (message.type === "abstract") {
    state.abstracts.set(message.wid, message.text || "OpenAlex has no abstract for this paper.");
    details();
  }
  else if (message.type === "added") {
    for (const node of state.web.nodes) {
      if (node.doi === message.doi) {
        node.mark = "wanted";
        node.key = message.key;
      }
    }
    status(message.key ? "Added to My Library. Zotero may find a PDF for it." : "Zotero did not add it.", !message.key);
    redraw();
  }
  else if (message.type === "saved") {
    for (const node of state.web.nodes) {
      if (node.id === message.id || (message.doi && node.doi === message.doi)) {
        node.saved = message.saved;
      }
    }
    if (state.web.mode === "later" && !message.saved) {
      state.web.nodes = state.web.nodes.filter((node) => node.id !== message.id);
      state.byId.delete(message.id);
      state.selected = "";
    }
    status(message.saved ? `Saved to check later (${message.count}). It stays on this computer, offline too.` : `Removed. ${message.count} left to check.`);
    $("later").textContent = `Check later (${message.count})`;
    redraw();
  }
  else if (message.type === "error") {
    status(message.message, true);
  }
  else if (message.type === "done") {
    status(message.text || "");
  }
});

// ---- showing a web ----

function show(web) {
  state.web = web;
  state.byId = new Map(web.nodes.map((node) => [node.id, node]));
  state.selected = web.focal || "";
  state.shown = new Set(["focal", ...GROUPS[web.mode].map(([group]) => group)]);
  state.lonely = web.mode === "library";
  const count = (test) => web.nodes.filter(test).length;
  const marks = ["have", "wanted", "new"].map((mark) => `${count((node) => node.mark === mark && node.id !== web.focal)} ${mark}`).join(", ");
  if (web.mode === "paper") {
    const focal = state.byId.get(web.focal);
    $("title").textContent = focal?.title || "Connections";
    const parts = GROUPS.paper.map(([group, name]) => [count((node) => node.groups.includes(group)), name.toLowerCase()]).filter(([n]) => n);
    $("subtitle").textContent = `${[focal?.year, ...parts.map(([n, name]) => `${n} ${name}`)].filter(Boolean).join(" · ")} | ${marks}`;
  }
  else if (web.mode === "later") {
    $("title").textContent = "Papers to check later";
    const report = web.report;
    $("subtitle").textContent = `${web.nodes.length} saved | ${marks}`
      + (report ? ` | added ${report.added}, already in your library ${report.already}, no DOI ${report.noDOI}, failed ${report.failed}` : "")
      + (web.cleared ? ` | ${web.cleared} now in your library, so taken off the list` : "");
  }
  else {
    const mine = count((node) => node.groups.includes("mine"));
    const links = web.edges.filter((edge) => state.byId.get(edge.source)?.groups.includes("mine") && state.byId.get(edge.target)?.groups.includes("mine")).length;
    $("title").textContent = "Your library";
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    $("subtitle").textContent = `${plural(mine, "paper", "papers")} with a DOI, ${plural(links, "citation", "citations")} between them`
      + (web.withoutDOI ? `. ${plural(web.withoutDOI, "item has", "items have")} no DOI, so ${web.withoutDOI === 1 ? "it is" : "they are"} not on the map.` : "");
  }
  const budget = web.budget || {};
  $("budget").textContent = budget.remaining != null ? `OpenAlex: ${budget.remaining} of ${budget.limit || "?"} requests left today` : "";
  const empty = web.mode === "later" ? (web.nodes.length ? "" : "Nothing saved yet. Select a new paper in any web and click Check later.")
    : web.nodes.length < 2 ? "Nothing connected was found for this paper." : "";
  status(web.problem || web.offline || empty, !!web.problem);
  $("laterAll").hidden = web.mode !== "later" || !web.nodes.some((node) => node.mark === "new" && node.doi);
  if (Number.isInteger(web.laterCount)) {
    $("later").textContent = `Check later (${web.laterCount})`;
  }
  $("back").disabled = !state.history.length;
  layout(true);
  filters();
  redraw();
  fit();
}

function redraw() {
  draw();
  details();
  list();
}

function visible(node) {
  if (!node.groups.some((group) => state.shown.has(group))) {
    return false;
  }
  return !state.lonely || state.web.edges.some((edge) => edge.source === node.id || edge.target === node.id);
}

function matches(node) {
  const query = $("search").value.trim().toLowerCase();
  return !query || `${node.title} ${(node.authors || []).join(" ")} ${node.year || ""}`.toLowerCase().includes(query);
}

/** A small force layout: each group has a home, linked papers pull together, all papers push apart. */
function layout(start) {
  const nodes = state.web.nodes;
  const byYear = $("byYear").checked;
  const years = nodes.map((node) => node.year).filter(Boolean);
  const low = Math.min(...years);
  const high = Math.max(...years);
  const xOf = (year) => (!year ? -560 : high > low ? -460 + 920 * (year - low) / (high - low) : 0);
  const home = (node) => node.home || ANCHORS[node.groups[0]] || [0, 0];
  if (start) {
    nodes.forEach((node, index) => {
      const [x, y] = home(node);
      const angle = index * 2.399963;
      const reach = 30 + 7 * Math.sqrt(index);
      node.x = x + reach * Math.cos(angle);
      node.y = y + reach * Math.sin(angle);
    });
  }
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  // Every paper is linked to the centre one, and later papers cite the earlier ones, so pulling along every line makes
  // one ball. Only lines inside a group pull: papers that cite each other sit together, and each group keeps its place.
  const links = state.web.edges.map((edge) => [index.get(edge.source), index.get(edge.target)])
    .filter(([a, b]) => a !== undefined && b !== undefined && nodes[a].groups[0] === nodes[b].groups[0] && nodes[a].groups[0] !== "focal");
  const steps = start ? (nodes.length > 300 ? 150 : 260) : 80;
  for (let step = 0; step < steps; step++) {
    const heat = (start ? 1 : 0.4) * (1 - step / steps);
    for (const node of nodes) {
      node.vx = 0;
      node.vy = 0;
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let far = dx * dx + dy * dy;
        if (far > 40000) {
          continue;
        }
        if (far < 1) {
          dx = (i % 7) - 3 || 1;
          dy = (j % 5) - 2 || 1;
          far = dx * dx + dy * dy;
        }
        const push = 900 / far;
        a.vx += dx * push;
        a.vy += dy * push;
        b.vx -= dx * push;
        b.vy -= dy * push;
      }
    }
    for (const [i, j] of links) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy) || 1;
      const pull = (length - 80) * 0.01 / length;
      a.vx += dx * pull;
      a.vy += dy * pull;
      b.vx -= dx * pull;
      b.vy -= dy * pull;
    }
    for (const node of nodes) {
      const [x, y] = home(node);
      node.vx += (x - node.x) * 0.06;
      node.vy += (y - node.y) * 0.06;
      const limit = 24 * heat;
      node.y += Math.max(-limit, Math.min(limit, node.vy * heat));
      node.x = byYear ? xOf(node.year) : node.x + Math.max(-limit, Math.min(limit, node.vx * heat));
      if (node.id === state.web.focal && !byYear) {
        node.x = 0;
        node.y = 0;
      }
    }
  }
  state.axis = byYear && years.length ? { low, high, xOf } : null;
}

function radius(node) {
  return node.id === state.web.focal ? 14 : 4 + Math.min(9, 1.1 * Math.log2(1 + (node.cites || 0)));
}

function draw() {
  const edges = $("edges");
  const circles = $("nodes");
  const labels = $("labels");
  const axis = $("axis");
  edges.replaceChildren();
  circles.replaceChildren();
  labels.replaceChildren();
  axis.replaceChildren();
  const shown = new Set(state.web.nodes.filter(visible).map((node) => node.id));
  const query = $("search").value.trim();
  for (const edge of state.web.edges) {
    if (!shown.has(edge.source) || !shown.has(edge.target)) {
      continue;
    }
    const a = state.byId.get(edge.source);
    const b = state.byId.get(edge.target);
    const line = el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: edge.kind });
    if (state.selected && state.selected !== state.web.focal && (edge.source === state.selected || edge.target === state.selected)) {
      line.classList.add("lit");
    }
    else if (query && !(matches(a) && matches(b))) {
      line.classList.add("dim");
    }
    edges.append(line);
  }
  for (const node of state.web.nodes) {
    if (!shown.has(node.id)) {
      continue;
    }
    const circle = el("circle", { cx: node.x, cy: node.y, r: radius(node), class: node.mark });
    circle.classList.toggle("focal", node.id === state.web.focal);
    circle.classList.toggle("selected", node.id === state.selected);
    circle.classList.toggle("dim", !!query && !matches(node));
    const tip = el("title");
    tip.textContent = `${who(node)} ${node.year || "n.d."}: ${node.title}`;
    circle.append(tip);
    circle.addEventListener("click", (event) => {
      event.stopPropagation();
      select(node.id);
    });
    circle.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      expand(node);
    });
    circles.append(circle);
  }
  if (!state.axis) {
    for (const [group, name] of GROUPS[state.web.mode]) {
      const members = state.web.nodes.filter((node) => node.groups[0] === group && shown.has(node.id));
      if (members.length && group !== "mine") {
        const x = members.reduce((sum, node) => sum + node.x, 0) / members.length;
        const label = el("text", { x, y: Math.min(...members.map((node) => node.y)) - 22, class: "group" });
        label.textContent = name;
        labels.append(label);
      }
    }
  }
  for (const id of new Set([state.web.focal, state.selected])) {
    const node = state.byId.get(id);
    if (node && shown.has(id)) {
      const label = el("text", { x: node.x + radius(node) + 4, y: node.y + 4 });
      label.textContent = `${who(node)} ${node.year || ""}`.trim();
      labels.append(label);
    }
  }
  if (state.axis) {
    const { low, high, xOf } = state.axis;
    const step = high - low > 40 ? 10 : high - low > 12 ? 5 : 1;
    const bottom = Math.max(...state.web.nodes.map((node) => node.y)) + 40;
    for (let year = Math.ceil(low / step) * step; year <= high; year += step) {
      axis.append(el("line", { x1: xOf(year), y1: -2000, x2: xOf(year), y2: bottom }));
      const label = el("text", { x: xOf(year), y: bottom + 14 });
      label.textContent = String(year);
      axis.append(label);
    }
  }
}

function filters() {
  const box = $("filters");
  box.replaceChildren();
  for (const [group, name] of GROUPS[state.web.mode]) {
    const count = state.web.nodes.filter((node) => node.groups.includes(group)).length;
    if (!count) {
      continue;
    }
    const label = html("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.shown.has(group);
    input.addEventListener("change", () => {
      input.checked ? state.shown.add(group) : state.shown.delete(group);
      redraw();
    });
    label.append(input, ` ${name} (${count})`);
    box.append(label);
  }
  if (state.web.mode === "library") {
    const label = html("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.lonely;
    input.addEventListener("change", () => {
      state.lonely = input.checked;
      redraw();
    });
    label.append(input, " Hide papers with no lines");
    box.append(label);
  }
}

function dot(mark) {
  return html("i", "", `dot ${mark}`);
}

function list() {
  const box = $("list");
  box.replaceChildren();
  const sort = $("sort").value;
  const order = (a, b) => (sort === "year" ? (b.year || 0) - (a.year || 0) : sort === "old" ? (a.year || 9999) - (b.year || 9999) : (b.cites || 0) - (a.cites || 0));
  for (const [group, name] of GROUPS[state.web.mode]) {
    if (!state.shown.has(group)) {
      continue;
    }
    const rows = state.web.nodes.filter((node) => node.groups.includes(group) && visible(node) && matches(node)).sort(order);
    if (!rows.length) {
      continue;
    }
    box.append(html("h3", `${name} (${rows.length})`));
    for (const node of rows) {
      const row = html("button", "", `row${node.id === state.selected ? " selected" : ""}`);
      const text = html("span");
      text.append(html("span", `${who(node)} ${node.year || "n.d."} `, "who"), node.title);
      row.append(dot(node.mark), text);
      row.addEventListener("click", () => select(node.id));
      box.append(row);
    }
  }
}

function details() {
  const node = state.byId.get(state.selected);
  $("details").hidden = !node;
  if (!node) {
    return;
  }
  const authors = (node.authors || []).join(", ") + (node.more ? " et al." : "");
  $("d-title").textContent = node.title || "(no title)";
  $("d-meta").textContent = [authors, node.year || "n.d.", node.venue, `cited by ${(node.cites || 0).toLocaleString()}`].filter(Boolean).join(" · ");
  $("d-mark").replaceChildren(dot(node.mark), MARKS[node.mark]);
  $("d-note").textContent = [...node.groups.filter((group) => group !== "focal").map(groupName), node.note].filter(Boolean).join(". ");
  const actions = $("d-actions");
  actions.replaceChildren();
  const action = (label, message, note, primary = false) => {
    const button = html("button", label, primary ? "primary" : "");
    button.addEventListener("click", () => {
      if (message.type === "centre") {
        state.next = "push"; // Back returns to this web
      }
      ask(message, note);
    });
    actions.append(button);
  };
  if (node.mark === "have") {
    action("Open PDF", { type: "read", key: node.key }, "", true);
  }
  if (node.key) {
    action("Show in Zotero", { type: "show", key: node.key }, "");
  }
  if (node.mark === "new" && node.doi) {
    action("Add to Zotero", { type: "add", doi: node.doi }, "Adding to My Library…", true);
  }
  if (node.id !== state.web.focal && (node.key || node.wid)) {
    action("Centre here", { type: "centre", key: node.key, wid: node.wid }, "Asking OpenAlex…");
  }
  if (node.wid && node.id !== state.web.focal) {
    const button = html("button", "Expand");
    button.title = "Add this paper's own connections to the web (or double-click it)";
    button.addEventListener("click", () => expand(node));
    actions.append(button);
  }
  if (node.saved) { // any saved paper can leave the list, whatever its mark
    action("Remove from Check later", { type: "later-remove", id: state.web.mode === "later" ? node.id : node.wid || `doi:${node.doi}` }, "");
  }
  else if (node.mark === "new" && node.id !== state.web.focal && (node.wid || node.doi)) {
    const work = { wid: node.wid, doi: node.doi, title: node.title, authors: node.authors, more: node.more, year: node.year, venue: node.venue, cites: node.cites, oa: node.oa, abstract: node.abstract };
    action("Check later", { type: "later-add", work }, "");
  }
  if (node.doi) {
    action("DOI page", { type: "link", doi: node.doi }, "");
  }
  if (node.oa) {
    action("Free copy online", { type: "link", url: node.oa }, "");
  }
  const text = node.abstract || (node.wid ? state.abstracts.get(node.wid) : "");
  $("d-abstract").textContent = text || "";
  if (node.wid && !text) {
    const button = html("button", "Show abstract");
    button.addEventListener("click", () => ask({ type: "abstract", wid: node.wid }, "Asking OpenAlex…"));
    $("d-abstract").append(button);
  }
}

function select(id) {
  state.selected = id;
  redraw();
}

function expand(node) {
  if (node.wid) {
    ask({ type: "expand", wid: node.wid }, `Expanding ${shortTitle(node.title, 40)}…`);
  }
}

/** Another paper's web added to this one: its 30 most cited new papers, placed around it. */
function merge(partial) {
  const centre = state.byId.get(partial.focal);
  if (!centre) {
    return;
  }
  const fresh = partial.nodes.filter((node) => !state.byId.has(node.id)).sort((a, b) => (b.cites || 0) - (a.cites || 0)).slice(0, 30);
  for (const node of fresh) {
    node.groups = ["expanded"];
    node.home = [centre.x, centre.y];
    node.x = centre.x + (Math.random() - 0.5) * 60;
    node.y = centre.y + (Math.random() - 0.5) * 60;
    state.web.nodes.push(node);
    state.byId.set(node.id, node);
  }
  const known = new Set(state.web.edges.map((edge) => `${edge.source}>${edge.target}`));
  for (const edge of partial.edges) {
    if (state.byId.has(edge.source) && state.byId.has(edge.target) && !known.has(`${edge.source}>${edge.target}`)) {
      state.web.edges.push(edge);
    }
  }
  state.shown.add("expanded");
  const budget = partial.budget || {};
  if (budget.remaining != null) {
    $("budget").textContent = `OpenAlex: ${budget.remaining} of ${budget.limit || "?"} requests left today`;
  }
  layout(false);
  filters();
  redraw();
  status(`Added ${fresh.length} papers around ${shortTitle(centre.title, 50)}.`);
}

// ---- moving around ----

function applyView() {
  const { x, y, k } = state.view;
  $("world").setAttribute("transform", `translate(${x},${y}) scale(${k})`);
}

function fit() {
  const shown = state.web.nodes.filter(visible);
  if (!shown.length) {
    return;
  }
  const box = $("graph").getBoundingClientRect();
  const xs = shown.map((node) => node.x);
  const ys = shown.map((node) => node.y);
  const [left, right, top, bottom] = [Math.min(...xs) - 60, Math.max(...xs) + 120, Math.min(...ys) - 40, Math.max(...ys) + 60];
  const k = Math.min(box.width / (right - left), box.height / (bottom - top), shown.length < 5 ? 1.2 : 2.5); // a few papers stay a readable size
  state.view = { k, x: box.width / 2 - k * (left + right) / 2, y: box.height / 2 - k * (top + bottom) / 2 };
  applyView();
}

const graph = $("graph");
graph.addEventListener("wheel", (event) => {
  event.preventDefault();
  const box = graph.getBoundingClientRect();
  const px = event.clientX - box.left;
  const py = event.clientY - box.top;
  const { x, y, k } = state.view;
  const next = Math.max(0.1, Math.min(8, k * Math.exp(-event.deltaY * 0.0015)));
  state.view = { k: next, x: px - (px - x) * next / k, y: py - (py - y) * next / k };
  applyView();
}, { passive: false });

// A resized or maximised window fits the graph again, once the resizing stops.
let refit = 0;
window.addEventListener("resize", () => {
  clearTimeout(refit);
  refit = setTimeout(() => state.web && fit(), 150);
});

let drag = null;
graph.addEventListener("pointerdown", (event) => {
  if (event.target.localName === "circle") {
    return;
  }
  drag = { x: event.clientX, y: event.clientY };
  graph.classList.add("panning");
  graph.setPointerCapture(event.pointerId);
});
graph.addEventListener("pointermove", (event) => {
  if (drag) {
    state.view.x += event.clientX - drag.x;
    state.view.y += event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    applyView();
  }
});
graph.addEventListener("pointerup", () => {
  drag = null;
  graph.classList.remove("panning");
});

$("byYear").addEventListener("change", () => {
  layout(true);
  draw();
  fit();
});
$("search").addEventListener("input", () => {
  draw();
  list();
});
$("sort").addEventListener("change", list);
$("refresh").addEventListener("click", () => {
  const focal = state.web ? state.byId.get(state.web.focal) : null;
  state.next = "replace";
  ask({ type: "refresh", mode: state.web?.mode, key: focal?.key, wid: focal?.wid }, state.web?.mode === "later" ? "" : "Asking OpenAlex again…");
});
$("map").addEventListener("click", () => {
  state.next = "push";
  ask({ type: "map" }, "Mapping your library. The first time takes a minute…");
});
$("later").addEventListener("click", () => {
  state.next = "push";
  ask({ type: "later" }, "");
});
$("laterAll").addEventListener("click", () => {
  state.next = "replace";
  ask({ type: "later-add-all" }, "Adding the saved papers to My Library, one at a time…");
});
$("back").addEventListener("click", () => {
  const last = state.history.pop();
  if (last) {
    show(last);
  }
});

state.next = "replace";
ask({ type: "ready" }, "Asking OpenAlex…");
