"use strict";
// Judge-owned Electron entry wrapper. Electron's default app loads this file as the main script;
// it then loads the unmodified checkout desktop main. It only (1) presents the ordinary
// `electron <dist/main.js>` argv/app-path layout, (2) keeps real test windows from taking the
// operator's focus and (3) adds a production-daemon port guard. It does not touch feature code.
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const desktopMain = process.env.PASEO_ORACLE_DESKTOP_MAIN;
if (!desktopMain || !path.isAbsolute(desktopMain)) {
  throw new Error("PASEO_ORACLE_DESKTOP_MAIN must name the absolute checkout desktop main");
}
// Playwright inserts its debugging switches before this script. Present the same layout as a
// developer running `electron packages/desktop/dist/main.js`, so CLI passthrough stays on the
// GUI path.
process.argv = [process.argv[0], desktopMain];
app.setAppPath(path.dirname(desktopMain));
if (process.platform === "darwin") {
  app.setActivationPolicy("accessory");
  if (app.dock) app.dock.hide();
}
BrowserWindow.prototype.show = function show() {
  this.showInactive();
};
BrowserWindow.prototype.focus = function focus() {};
app.focus = function focus() {};
// Registered before the product's own ready handlers; a later product webRequest handler on the
// default session takes precedence, so this guard can never change product behaviour.
function guardProductionDaemon() {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["*://*:6767/*", "*://*:6768/*"] },
    (details, respond) => {
      process.stderr.write(`[judge] blocked production daemon request ${details.url}\n`);
      respond({ cancel: true });
    },
  );
  process.stderr.write("[judge] app ready; production daemon guard installed\n");
  return true;
}
void app.whenReady().then(guardProductionDaemon);
require(desktopMain);
