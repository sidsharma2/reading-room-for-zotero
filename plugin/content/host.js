/* A plain window around the editor page. The page runs in a content browser with no privileges, as Zotero's own
 * note editor does, because Zotero strips attributes from HTML in privileged pages and MathLive needs them.
 * The page can only send two events, and the text it sends is inserted as plain text. */
window.addEventListener("load", () => {
  const { url, insert } = window.arguments[0];
  const view = document.createXULElement("browser");
  view.id = "view";
  view.setAttribute("type", "content");
  view.setAttribute("flex", "1");
  view.setAttribute("disableglobalhistory", "true");
  view.setAttribute("src", url);
  view.addEventListener("rr-insert", (event) => {
    const { text, latex } = JSON.parse(String(event.detail));
    insert(String(text), String(latex));
    window.close();
  }, true, true);
  view.addEventListener("rr-close", () => window.close(), true, true);
  document.documentElement.appendChild(view);
});
