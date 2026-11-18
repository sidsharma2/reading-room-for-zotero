/* A plain window around the connections page, which runs in a content browser with no privileges, like the
 * equation editor. The page sends small requests as JSON text, the plugin checks each one, and answers go back the
 * same way. */
window.addEventListener("load", () => {
  const { url, handle } = window.arguments[0];
  const view = document.createXULElement("browser");
  view.setAttribute("type", "content");
  view.setAttribute("flex", "1");
  view.setAttribute("disableglobalhistory", "true");
  view.setAttribute("src", url);
  const reply = (message) => {
    const page = view.contentWindow;
    if (page && message) {
      page.document.dispatchEvent(new page.CustomEvent("rr-data", { detail: JSON.stringify(message) }));
    }
  };
  view.addEventListener("rr-action", async (event) => {
    let action;
    try {
      action = JSON.parse(String(event.detail));
    }
    catch {
      return;
    }
    try {
      reply(await handle(action, (title) => {
        document.title = title;
      }));
    }
    catch (error) {
      reply({ type: "error", message: String(error?.message || error) });
    }
  }, true, true);
  document.documentElement.appendChild(view);
});
