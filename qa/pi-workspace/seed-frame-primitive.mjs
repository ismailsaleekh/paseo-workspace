#!/usr/bin/env node
// Judge-owned regression for app-only Playwright bootstrap; not a product renderer test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(path.join(process.cwd(), "package.json"));
const ts = require("typescript");
const { chromium } = require("playwright");
const fixturePath = path.join(process.cwd(), "packages/app/e2e/support/fixtures.ts");
const source = ts.createSourceFile(
  fixturePath,
  await readFile(fixturePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const callbacks = [];
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "addInitScript"
  ) {
    const callback = node.arguments[0];
    assert.ok(callback && ts.isArrowFunction(callback), "Expected the actual app seed callback");
    callbacks.push(callback.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(callbacks.length, 1, "Review bootstrap ownership if more seed callbacks are added");
const bootstrap = callbacks[0];
const nonce = "isolated-bootstrap-regression";
const daemon = { serverId: "test-only-server", endpoint: "test-only-endpoint" };
const preferences = { fixture: true };
const input = { daemon, preferences, seedNonce: nonce, extraHostsKey: "@paseo:e2e-extra-hosts" };
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    request.url === "/child"
      ? "<!doctype html><p>same-origin child</p>"
      : '<!doctype html><iframe name="same" src="/child"></iframe><iframe name="opaque" sandbox="allow-scripts" srcdoc="<p>opaque child</p>"></iframe>',
  );
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Observe real storage access before invoking the callback from the actual fixture source.
  await page.addInitScript({
    content: `
    window.__seedStorageReads = 0;
    if (window.top !== window) {
      const getter = Object.getOwnPropertyDescriptor(window, "localStorage")?.get;
      if (!getter) throw new Error("Browser storage descriptor unavailable");
      Object.defineProperty(window, "localStorage", {configurable:true,get(){
        window.__seedStorageReads += 1;
        return getter.call(window);
      }});
    }
    (${bootstrap})(${JSON.stringify(input)});
  `,
  });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => localStorage.getItem("@paseo:e2e")), "1");
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem("@paseo:daemon-registry"))),
    [daemon],
  );
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem("@paseo:create-agent-preferences"))),
    preferences,
  );
  assert.deepEqual(errors, [], "App bootstrap must not throw in an opaque-origin child frame");
  for (const name of ["same", "opaque"]) {
    const element = await page.locator(`iframe[name="${name}"]`).elementHandle();
    assert.ok(element, `Missing ${name} iframe element`);
    try {
      const frame = await element.contentFrame();
      assert.ok(frame, `Missing ${name} child context`);
      assert.equal(
        await frame.evaluate(() => window.__seedStorageReads),
        0,
        `${name} child must not run app-storage seeding`,
      );
    } finally {
      await element.dispose();
    }
  }
  await page.evaluate((seedNonce) => {
    localStorage.setItem("@paseo:e2e-disable-default-seed-once", seedNonce);
    localStorage.setItem(
      "@paseo:daemon-registry",
      JSON.stringify([{ serverId: "preserved-override" }]),
    );
  }, nonce);
  await page.reload();
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem("@paseo:daemon-registry"))),
    [{ serverId: "preserved-override" }],
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("@paseo:e2e-disable-default-seed-once")),
    null,
  );
  await page.reload();
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem("@paseo:daemon-registry"))),
    [daemon],
  );
  assert.deepEqual(errors, []);
  process.stdout.write(
    "PASS actual app bootstrap seeds top-level/reloads without touching child-frame storage\n",
  );
} finally {
  await browser?.close();
  await promisify(server.close.bind(server))();
}
