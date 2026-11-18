/* The equation editor window. A visual field and the LaTeX source stay in step, and the result is plain LaTeX.
 *
 * This page has no Zotero privileges. MathLive needs that, because Zotero strips attributes from HTML in privileged
 * pages. It also means the page can only hand back text, which the plugin inserts as plain text.
 */
/* global MathfieldElement, mathVirtualKeyboard */

const SCIENCE = {
  label: "Science",
  tooltip: "Engineering and chemistry",
  rows: [
    [{ latex: "\\dot{#@}" }, { latex: "\\bar{#@}" }, { latex: "\\hat{#@}" }, { latex: "\\vec{#@}" }, { latex: "\\tilde{#@}" }, { latex: "\\partial" }, { latex: "\\nabla" }, { latex: "\\Delta" }, { latex: "\\infty" }],
    [{ latex: "\\frac{#@}{#?}", label: "a/b", class: "small" }, { latex: "\\frac{d#@}{d#?}", label: "d/dx", class: "small" }, { latex: "\\frac{\\partial #@}{\\partial #?}", label: "∂/∂x", class: "small" }, { latex: "\\int_{#?}^{#?}", label: "∫", class: "small" }, { latex: "\\sum_{#?}^{#?}", label: "Σ", class: "small" }, { latex: "\\sqrt{#@}", label: "√", class: "small" }, { latex: "\\exp(#?)", label: "exp", class: "small" }, { latex: "\\ln(#?)", label: "ln", class: "small" }, { latex: "\\log_{10}(#?)", label: "log₁₀", class: "small" }],
    [{ latex: "\\sim" }, { latex: "\\approx" }, { latex: "\\propto" }, { latex: "\\ll" }, { latex: "\\gg" }, { latex: "\\le" }, { latex: "\\ge" }, { latex: "\\pm" }, { latex: "\\times" }],
    [{ latex: "\\mathrm{#@}", label: "text", class: "small" }, { latex: "#@_{#?}", label: "xᵢ", class: "small" }, { latex: "#@^{#?}", label: "x²", class: "small" }, { latex: "\\rightarrow" }, { latex: "\\rightleftharpoons" }, { latex: "^{\\circ}\\mathrm{C}", label: "°C", class: "small" }, { latex: "\\mathrm{kg/s}", label: "kg/s", class: "small" }, { latex: "\\mathrm{mg/kg}", label: "mg/kg", class: "small" }, "[backspace]"],
  ],
};

const field = document.getElementById("field");
const source = document.getElementById("source");

function wrap(latex) {
  const mode = document.querySelector("input[name=mode]:checked").value;
  return mode === "display" ? `$$${latex}$$` : `$${latex}$`;
}

function recentEquations() {
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(1)) || "[]");
  }
  catch {
    return [];
  }
}

function insert() {
  // An empty box in a template leaves a placeholder, which nothing else can draw.
  const latex = source.value.replace(/\\placeholder\{[^}]*\}/g, "").trim();
  if (latex) {
    const detail = JSON.stringify({ text: wrap(latex), latex });
    document.dispatchEvent(new CustomEvent("rr-insert", { bubbles: true, detail }));
  }
  else {
    closeEditor();
  }
}

function closeEditor() {
  document.dispatchEvent(new CustomEvent("rr-close", { bubbles: true }));
}

function showRecent() {
  const box = document.getElementById("recent");
  for (const latex of recentEquations()) {
    const button = document.createElement("button");
    button.textContent = latex;
    button.title = latex;
    button.addEventListener("click", () => {
      field.setValue(latex);
      source.value = latex;
    });
    box.appendChild(button);
  }
}

function start() {
  // Local fonts and no sounds, so nothing is fetched from a CDN.
  MathfieldElement.fontsDirectory = new URL("vendor/fonts", location.href).href;
  MathfieldElement.soundsDirectory = null;
  MathfieldElement.keypressSound = null;
  MathfieldElement.plonkSound = null;
  field.mathVirtualKeyboardPolicy = "manual";
  field.smartMode = false;
  mathVirtualKeyboard.container = document.getElementById("keyboard");
  mathVirtualKeyboard.layouts = [SCIENCE, "numeric", "symbols", "greek", "alphabetic"];
  field.addEventListener("input", () => {
    source.value = field.value;
  });
  source.addEventListener("input", () => field.setValue(source.value, { silenceNotifications: true }));
  document.getElementById("insert").addEventListener("click", insert);
  document.getElementById("cancel").addEventListener("click", closeEditor);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeEditor();
    }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      insert();
    }
  });
  showRecent();
  field.focus();
  mathVirtualKeyboard.show();
}

start();
