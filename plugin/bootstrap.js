/* Zotero loads this file. The work is in tools.js. */
/* global Components, Services, Zotero, RRTools */
var chromeHandle;

function install() {}

function uninstall() {}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const addons = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = addons.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [["content", "rrtools", "content/"]]);
  resources().setSubstitution("rrtools", Services.io.newURI(rootURI + "content/"));
  Services.scriptloader.loadSubScript(rootURI + "connections.js");
  Services.scriptloader.loadSubScript(rootURI + "organise.js");
  Services.scriptloader.loadSubScript(rootURI + "tools.js");
  RRTools.start(id, rootURI);
}

function onMainWindowLoad({ window }) {
  RRTools.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  RRTools.removeFromWindow(window);
}

function shutdown() {
  RRTools?.stop();
  resources().setSubstitution("rrtools", null);
  chromeHandle?.destruct();
  chromeHandle = null;
}

function resources() {
  return Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsIResProtocolHandler);
}
