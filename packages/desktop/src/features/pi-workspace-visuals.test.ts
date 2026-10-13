import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import ts from "typescript";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import sharp from "sharp";
import { z } from "zod";
import {
  installVisualContentsPolicy,
  installVisualSessionPolicy,
  isVisualHostUrl,
  sameVisualBinding,
  VisualDeadlines,
  captureDisplayedFrame,
  visualPngSize,
  type VisualFrameSource,
  type VisualContentsPolicy,
  type VisualSessionPolicy,
  type VisualTimer,
} from "./pi-workspace-visuals.js";

test("visual policy denies permissions, devices, display media, downloads, navigation and new windows only on the supplied ports", async () => {
  const installed: string[] = [];
  const documentUrl = "paseo-visual://document-nonce/document";
  const session: VisualSessionPolicy = {
    async setProxy(config) {
      assert.deepEqual(config, {
        mode: "fixed_servers",
        proxyRules: "http://127.0.0.1:9",
        proxyBypassRules: "<-loopback>",
      });
      installed.push("proxy");
    },
    setPermissionCheckHandler(handler) {
      assert.equal(handler(), false);
      installed.push("permission-check");
    },
    setPermissionRequestHandler(handler) {
      handler(null, "notifications", (allowed) => assert.equal(allowed, false));
      installed.push("permission-request");
    },
    setDevicePermissionHandler(handler) {
      assert.equal(handler(), false);
      installed.push("device-permission");
    },
    setDisplayMediaRequestHandler(handler) {
      handler(null, (streams) => assert.deepEqual(streams, {}));
      installed.push("display-media");
    },
    on(event, handler) {
      assert.equal(event, "will-download");
      let prevented = false;
      handler({
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
      installed.push("download");
    },
    webRequest: {
      onBeforeRequest(filter, handler) {
        assert.deepEqual(filter, { urls: ["<all_urls>"] });
        for (const url of [
          "http://127.0.0.1:9876/",
          "https://example.invalid/",
          "ws://example.invalid/",
          "wss://example.invalid/",
          "file:///etc/hosts",
          "paseo://app/",
          "paseo-visual://other/document",
        ]) {
          handler({ url, method: "GET", resourceType: "mainFrame" }, (result) =>
            assert.deepEqual(result, { cancel: true }),
          );
        }
        handler({ url: documentUrl, method: "GET", resourceType: "mainFrame" }, (result) =>
          assert.deepEqual(result, { cancel: false }),
        );
        handler({ url: documentUrl, method: "POST", resourceType: "mainFrame" }, (result) =>
          assert.deepEqual(result, { cancel: true }),
        );
        handler({ url: documentUrl, method: "GET", resourceType: "subFrame" }, (result) =>
          assert.deepEqual(result, { cancel: true }),
        );
        handler(
          { url: "data:image/png;base64,AAAA", method: "GET", resourceType: "image" },
          (result) => assert.deepEqual(result, { cancel: false }),
        );
        installed.push("requests");
      },
    },
  };
  await installVisualSessionPolicy(session, documentUrl);
  assert.deepEqual(installed, [
    "permission-check",
    "permission-request",
    "device-permission",
    "display-media",
    "download",
    "requests",
    "proxy",
  ]);
  const events: string[] = [];
  const contents: VisualContentsPolicy = {
    setWebRTCIPHandlingPolicy(policy) {
      assert.equal(policy, "disable_non_proxied_udp");
      events.push("webrtc");
    },
    setWindowOpenHandler(handler) {
      assert.deepEqual(handler(), { action: "deny" });
      events.push("windows");
    },
    on(event, handler) {
      let prevented = false;
      handler({
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
      events.push(event);
    },
  };
  installVisualContentsPolicy(contents);
  assert.deepEqual(events, [
    "webrtc",
    "windows",
    "will-navigate",
    "will-frame-navigate",
    "will-redirect",
    "will-prevent-unload",
  ]);
});

test("host deadlines expire once, reject duplicate operations, and ignore callbacks after settlement or disposal", () => {
  const timers: Array<{ expire(): void; cancelled: boolean }> = [];
  const schedule: VisualTimer = (expire, milliseconds) => {
    assert.equal(milliseconds, 6000);
    const timer = { expire, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const deadlines = new VisualDeadlines(schedule);
  const expired: string[] = [];
  deadlines.arm("first", () => expired.push("first"));
  assert.throws(() => deadlines.arm("first", () => expired.push("duplicate")), /already pending/);
  const first = timers[0];
  if (!first) throw new Error("No host deadline was installed");
  first.expire();
  first.expire();
  assert.deepEqual(expired, ["first"]);
  deadlines.arm("second", () => expired.push("second"));
  deadlines.settle("second");
  const second = timers[1];
  if (!second) throw new Error("No second deadline was installed");
  assert.equal(second.cancelled, true);
  second.expire();
  deadlines.arm("third", () => expired.push("third"));
  deadlines.close();
  const third = timers[2];
  if (!third) throw new Error("No third deadline was installed");
  assert.equal(third.cancelled, true);
  third.expire();
  assert.deepEqual(expired, ["first"]);
});

test("desktop authority distinguishes every document binding field and the actual app origin", () => {
  const binding = {
    id: "artifact",
    revision: 1,
    nonce: "document",
    clientGeneration: "connection",
  };
  assert.equal(sameVisualBinding(binding, { ...binding }), true);
  for (const changed of [
    { ...binding, id: "other" },
    { ...binding, revision: 2 },
    { ...binding, nonce: "replaced" },
    { ...binding, clientGeneration: "reconnected" },
  ])
    assert.equal(sameVisualBinding(binding, changed), false);
  assert.equal(isVisualHostUrl("paseo://app/h/server/agent/id", "http://localhost:8082"), true);
  assert.equal(
    isVisualHostUrl("http://localhost:8082/h/server/agent/id", "http://localhost:8082"),
    true,
  );
  for (const url of [
    "paseo-visual://document/",
    "http://localhost:8083/",
    "https://example.invalid/",
    "file:///tmp/page.html",
    "about:blank",
    "not a URL",
  ])
    assert.equal(isVisualHostUrl(url, "http://localhost:8082"), false);
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZsAAAAASUVORK5CYII=",
  "base64",
);
class FrameSource implements VisualFrameSource {
  reply: ((response: unknown) => void) | null = null;
  throttled = true;
  destroyed = false;
  attached = false;
  starts = 0;
  ends = 0;
  readonly throttleChanges: boolean[] = [];
  readonly debugger: VisualFrameSource["debugger"] = {
    isAttached: () => this.attached,
    attach: () => {
      this.starts += 1;
      this.attached = true;
    },
    detach: () => {
      this.ends += 1;
      this.attached = false;
    },
    sendCommand: (method, parameters) => {
      assert.equal(method, "Page.captureScreenshot");
      assert.deepEqual(parameters, {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      return new Promise((accept) => {
        this.reply = accept;
      });
    },
  };
  getBackgroundThrottling(): boolean {
    return this.throttled;
  }
  setBackgroundThrottling(value: boolean): void {
    this.throttled = value;
    this.throttleChanges.push(value);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  deliver(response: unknown): void {
    if (!this.reply) throw new Error("Capture did not request the displayed viewport");
    this.reply(response);
  }
}

test("capture forwards a new viewport PNG from its display and releases its debugger, deadline and temporary throttling", async () => {
  const source = new FrameSource();
  let cancelled = 0;
  const pending = captureDisplayedFrame({
    source,
    valid: () => true,
    signal: new AbortController().signal,
    schedule: (_expire, milliseconds) => {
      assert.equal(milliseconds, 5000);
      return () => {
        cancelled += 1;
      };
    },
  });
  assert.equal(source.starts, 1);
  assert.equal(source.throttled, false);
  source.deliver({ data: png.toString("base64") });
  assert.deepEqual(await pending, png);
  assert.equal(source.ends, 1);
  assert.equal(cancelled, 1);
  assert.deepEqual(source.throttleChanges, [false, true]);
  assert.deepEqual(visualPngSize(png), { width: 1, height: 1 });
});

test("capture revalidates after asynchronous delivery and after PNG decoding", async () => {
  for (const failAt of [2, 3]) {
    const source = new FrameSource();
    let validations = 0;
    const pending = captureDisplayedFrame({
      source,
      valid: () => ++validations < failAt,
      signal: new AbortController().signal,
    });
    const failed = assert.rejects(pending, /Capture binding changed/);
    source.deliver({ data: png.toString("base64") });
    await failed;
    assert.equal(validations, failAt);
    assert.equal(source.ends, 1);
    assert.equal(source.throttled, true);
  }
});

test("capture timeout and cancellation release resources and ignore late replies", async () => {
  for (const reason of ["deadline", "unmount"] as const) {
    const source = new FrameSource();
    const abort = new AbortController();
    const expirations: Array<() => void> = [];
    let cancelled = 0;
    const pending = captureDisplayedFrame({
      source,
      valid: () => true,
      signal: abort.signal,
      schedule: (expire) => {
        expirations.push(expire);
        return () => {
          cancelled += 1;
        };
      },
    });
    const failed = assert.rejects(
      pending,
      reason === "deadline" ? /capture deadline/ : /target changed/,
    );
    const expire = expirations[0];
    if (!expire) throw new Error("Capture did not install its deadline");
    if (reason === "deadline") expire();
    else abort.abort();
    await failed;
    source.deliver({ data: png.toString("base64") });
    await Promise.resolve();
    assert.equal(source.ends, 1);
    assert.equal(cancelled, 1);
    assert.equal(source.throttled, true);
  }
});

test("unavailable or already-owned views and malformed or oversized PNG replies fail explicitly", async () => {
  const unavailable = new FrameSource();
  await assert.rejects(
    captureDisplayedFrame({
      source: unavailable,
      valid: () => false,
      signal: new AbortController().signal,
    }),
    /not displayed/,
  );
  assert.equal(unavailable.starts, 0);
  const occupied = new FrameSource();
  occupied.attached = true;
  await assert.rejects(
    captureDisplayedFrame({
      source: occupied,
      valid: () => true,
      signal: new AbortController().signal,
    }),
    /already owned/,
  );
  assert.equal(occupied.ends, 0);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(5000, 16);
  for (const response of [
    { data: 17 },
    { data: "A".repeat(3 * 1024 * 1024) },
    { data: oversized.toString("base64") },
  ]) {
    const source = new FrameSource();
    const pending = captureDisplayedFrame({
      source,
      valid: () => true,
      signal: new AbortController().signal,
    });
    const failed = assert.rejects(pending, /bounded PNG|dimensions exceed/);
    source.deliver(response);
    await failed;
    assert.equal(source.ends, 1);
    assert.equal(source.throttled, true);
  }
  assert.throws(() => visualPngSize(Buffer.alloc(32)), /bounded PNG/);
});

async function sampleCanvas(bytes: Buffer): Promise<number[]> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scale = info.width / 880;
  const offset = (Math.floor(32 * scale) * info.width + Math.floor(64 * scale)) * 4;
  return Array.from(data.subarray(offset, offset + 3));
}

test("real Electron same-nonce mount reservations preserve the newer invocation in both preparation completion orders", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const evidence = await mkdtemp(join(tmpdir(), "visual-reservations-"));
  console.log("MOUNT EVIDENCE " + evidence);
  const entry = join(evidence, "main.cjs");
  await writeFile(
    entry,
    `
    const {app,BrowserWindow,WebContentsView,session,ipcMain}=require('electron');
    const {createServer}=require('http');
    const {randomUUID}=require('crypto');
    const {PiWorkspaceVisuals,installVisualSessionPolicy}=require(${JSON.stringify(join(repository, "packages/desktop/dist/features/pi-workspace-visuals.js"))});
    app.setPath('userData',${JSON.stringify(join(evidence, "user-data"))});
    if(process.platform==='darwin'){app.setActivationPolicy('accessory');app.dock.hide();}
    globalThis.mountReady=app.whenReady().then(async()=>{
      const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<p>Private mount host</p>');});
      await new Promise(done=>server.listen(0,'127.0.0.1',done));
      const origin='http://127.0.0.1:'+server.address().port;
      const preparations=[],waiters=new Map(),views=[],partitions=[];
      const nextPreparation=index=>preparations[index]?Promise.resolve(preparations[index]):new Promise(done=>waiters.set(index,done));
      const host=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
      const visuals=new PiWorkspaceVisuals({
        ipc:ipcMain,keyboard:{handleTrustedNativeInput:()=>false},
        createSession:partition=>{partitions.push(partition);return session.fromPartition(partition,{cache:false});},
        prepareSession:async(nativeSession,url)=>{
          let release;
          const held=new Promise(done=>{release=done;});
          const gate={release};
          const index=preparations.push(gate)-1;
          if(waiters.has(index)){waiters.get(index)(gate);waiters.delete(index);}
          await held;
          await installVisualSessionPolicy(nativeSession,url);
        },
        createView:webPreferences=>{const view=new WebContentsView({webPreferences});views.push(view);return view;},
        preloadPath:${JSON.stringify(join(repository, "packages/desktop/dist/features/pi-workspace-visual-preload.js"))},
        appOrigin:origin,reportFailure:error=>{throw error;}
      });
      visuals.attachWindow(host);
      await host.loadURL(origin);
      const invoke=(channel,input)=>host.webContents.executeJavaScript('require("electron").ipcRenderer.invoke('+JSON.stringify(channel)+','+JSON.stringify(input)+')');
      globalThis.mountRace=async order=>{
        const nonce=randomUUID(),id=randomUUID(),generation=randomUUID();
        const current={binding:{id,nonce,revision:1,clientGeneration:generation},document:{id,title:'Reservation proof',revision:1,stateRevision:1,html:'<p>Retained</p>',snapshot:{state:null,selection:null}}};
        const input={current,commandId:null,bounds:{x:0,y:0,width:400,height:300}};
        const firstIndex=preparations.length,viewIndex=views.length,partitionIndex=partitions.length;
        const start=()=>invoke('paseo:visual:mount',input).then(()=>({status:'mounted'}),error=>({status:'cancelled',message:error.message}));
        const old=start();
        const oldGate=await nextPreparation(firstIndex);
        await invoke('paseo:visual:dispose',{nonce});
        const newer=start();
        const newGate=await nextPreparation(firstIndex+1);
        let oldResult,newResult;
        if(order==='old-first'){
          oldGate.release();oldResult=await old;
          const duplicate=await start();
          if(!duplicate.message?.includes('already mounted'))throw new Error('Old finally deleted the new reservation');
          newGate.release();newResult=await newer;
        }else{
          newGate.release();newResult=await newer;
          oldGate.release();oldResult=await old;
        }
        const guest=views[viewIndex];
        if(!guest)throw new Error('Replacement guest missing');
        const beforeDispose={order,oldStatus:oldResult.status,oldMessage:oldResult.message,newStatus:newResult.status,createdGuests:views.length-viewIndex,contentsId:guest.webContents.id,stillAlive:!guest.webContents.isDestroyed(),distinctPartitions:new Set(partitions.slice(partitionIndex)).size===2,sandbox:guest.webContents.getLastWebPreferences().sandbox,nodeIntegration:guest.webContents.getLastWebPreferences().nodeIntegration};
        const destroyed=new Promise(done=>guest.webContents.once('destroyed',done));
        await invoke('paseo:visual:dispose',{nonce});
        await destroyed;
        return {...beforeDispose,disposed:guest.webContents.isDestroyed()};
      };
      host.on('closed',()=>server.close());
    });
  `,
  );
  const runtimePath = process.env.PATH;
  if (!runtimePath) throw new Error("Mount test requires PATH");
  const electron = await _electron.launch({
    executablePath: join(
      repository,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [entry],
    cwd: repository,
    env: {
      PATH: runtimePath,
      HOME: evidence,
      TMPDIR: tmpdir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      PASEO_HOME: join(evidence, "paseo"),
      PI_CODING_AGENT_DIR: join(evidence, "pi"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    },
    timeout: 60000,
  });
  const results: unknown[] = [];
  try {
    await electron.evaluate(async () => {
      const ready: unknown = Reflect.get(globalThis, "mountReady");
      if (!(ready instanceof Promise)) throw new Error("Missing mount fixture");
      await ready;
    });
    for (const order of ["old-first", "new-first"]) {
      const raw: unknown = await electron.evaluate(async (_electronModule, completionOrder) => {
        const run: unknown = Reflect.get(globalThis, "mountRace");
        if (typeof run !== "function") throw new Error("Missing mount race");
        return await Reflect.apply(run, undefined, [completionOrder]);
      }, order);
      const result = z
        .object({
          order: z.string(),
          oldStatus: z.string(),
          oldMessage: z.string(),
          newStatus: z.string(),
          createdGuests: z.number(),
          contentsId: z.number(),
          stillAlive: z.boolean(),
          distinctPartitions: z.boolean(),
          sandbox: z.boolean(),
          nodeIntegration: z.boolean(),
          disposed: z.boolean(),
        })
        .parse(raw);
      assert.equal(result.order, order);
      assert.equal(result.oldStatus, "cancelled");
      assert.match(result.oldMessage, /unmounted while preparing/);
      assert.equal(result.newStatus, "mounted");
      assert.equal(result.createdGuests, 1);
      assert.equal(result.stillAlive, true);
      assert.equal(result.distinctPartitions, true);
      assert.equal(result.sandbox, true);
      assert.equal(result.nodeIntegration, false);
      assert.equal(result.disposed, true);
      results.push(result);
    }
    await writeFile(join(evidence, "results.json"), JSON.stringify(results, null, 2));
  } finally {
    await electron.close();
  }
}, 90000);

test("real production guest is hidden by central nested overlay registration and restored without losing source or choices", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const evidence = await mkdtemp(join(tmpdir(), "visual-layer-"));
  console.log("NATIVE EVIDENCE " + evidence);
  const runtime = join(evidence, "runtime");
  await mkdir(runtime);
  await symlink(join(repository, "node_modules"), join(runtime, "node_modules"), "dir");
  const overlaySource = await readFile(
    join(repository, "packages/app/src/lib/overlay-root.ts"),
    "utf8",
  );
  const overlayModule = join(runtime, "overlay-root.cjs");
  await writeFile(
    overlayModule,
    ts.transpileModule(overlaySource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
  const entry = join(runtime, "main.cjs");
  const shortcutStringModule = join(runtime, "shortcut-string.cjs");
  const shortcutsModule = join(runtime, "keyboard-shortcuts.cjs");
  const browserPolicyModule = join(runtime, "browser-shortcuts.cjs");
  const compile = async (filename: string, output: string, from?: string, to?: string) => {
    const source = await readFile(join(repository, filename), "utf8");
    // Resolve an existing source module into this isolated emitted test runtime; no logic is substituted.
    const resolved = from && to ? source.replace(JSON.stringify(from), JSON.stringify(to)) : source;
    await writeFile(
      output,
      ts.transpileModule(resolved, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  };
  await compile("packages/app/src/keyboard/shortcut-string.ts", shortcutStringModule);
  await compile(
    "packages/app/src/keyboard/keyboard-shortcuts.ts",
    shortcutsModule,
    "@/keyboard/shortcut-string",
    shortcutStringModule,
  );
  await compile(
    "packages/app/src/desktop/browser/shortcuts.ts",
    browserPolicyModule,
    "../../keyboard/keyboard-shortcuts",
    shortcutsModule,
  );
  const hostScript = `
    const {ipcRenderer}=require('electron');
    const React=require('react');
    const {createRoot}=require('react-dom/client');
    const {flushSync}=require('react-dom');
    const registry=require(${JSON.stringify(overlayModule)});
    const shortcuts=require(${JSON.stringify(shortcutsModule)});
    const browserPolicy=require(${JSON.stringify(browserPolicyModule)});
    const bindings=shortcuts.buildEffectiveBindings({});
    window.policyReady=window.Promise.resolve(ipcRenderer.invoke('paseo:browser:set-shortcut-policy',browserPolicy.buildBrowserKeyboardPolicy({bindings,isMac:true,isDesktop:true})));
    window.commandCenterCount=0;
    ipcRenderer.on('paseo:event:browser-shortcut-input',(_event,payload)=>{
      const input=browserPolicy.parseBrowserShortcutInput(payload);
      if(!input) throw new Error('Invalid trusted shortcut');
      const resolved=shortcuts.resolveKeyboardShortcut({event:input,context:{isMac:true,isDesktop:true,focusScope:'browser',commandCenterOpen:registry.hasActiveWebOverlay()},chordState:{candidateIndices:[],step:0,timeoutId:null},onChordReset:()=>{},bindings});
      if(resolved.match?.action==='command-center.toggle'){window.commandCenterCount++;window.setOverlays(registry.hasActiveWebOverlay()?0:1);}
    });
    const current=JSON.parse(document.getElementById('configuration').textContent);
    const nonce=current.binding.nonce;
    let mounted=false;
    const bounds={x:320,y:72,width:640,height:400};
    window.pendingVisibility=Promise.resolve();
    registry.subscribeWebOverlayActivity(()=>{
      if(mounted) window.pendingVisibility=ipcRenderer.invoke('paseo:visual:bounds',{nonce,bounds,occluded:registry.hasActiveWebOverlay()});
    });
    const root=createRoot(document.getElementById('overlay-root'));
    function Overlay({level}){
      const ref=registry.useWebOverlayRegistration({active:true,layer:level*20,onKeyDown:()=>false});
      return React.createElement('div',{ref,tabIndex:-1,'data-testid':'overlay-'+level,style:{position:'fixed',inset:0,background:'white',zIndex:level*20}},React.createElement('input',{'data-testid':'overlay-input-'+level}),React.createElement('button',{onClick:()=>window.setOverlays(level-1)},'Close overlay'));
    }
    window.setOverlays=async(count)=>{
      flushSync(()=>root.render(React.createElement(React.Fragment,null,...Array.from({length:count},(_,index)=>React.createElement(Overlay,{key:index,level:index+1})))));
      await window.pendingVisibility;
      return registry.hasActiveWebOverlay();
    };
    window.hiddenCapture=async()=>{
      try { await ipcRenderer.invoke('paseo:visual:command',{nonce,command:{kind:'inspect',commandId:require('crypto').randomUUID(),binding:current.binding,screenshot:true,stateRevision:2}}); return 'unexpected success'; }
      catch(error){return error.message;}
    };
    ipcRenderer.on('paseo:event:visual',(_event,value)=>{
      if(value.type==='paseo-visual' && !value.receipt.error) ipcRenderer.invoke('paseo:visual:ack',{binding:current.binding,sequence:value.receipt.sequence,stateRevision:2});
    });
    document.getElementById('opener').focus();
    window.ready=window.Promise.resolve(ipcRenderer.invoke('paseo:visual:mount',{current,commandId:null,bounds,occluded:registry.hasActiveWebOverlay()})).then(()=>{mounted=true;});
    window.hostKeyCount=0;
    window.addEventListener('keydown',()=>window.hostKeyCount++);
  `;
  const id = "c43b1be5-e3dc-4ea6-b3c3-68b1c7789fe3";
  const nonce = "bdc22ad2-ac92-4df7-9211-3f3f2d815d7b";
  const configuration = {
    binding: { id, nonce, revision: 1, clientGeneration: "d8cff4c6-e3dc-491f-b301-3daa0c205cc8" },
    document: {
      id,
      title: "Layer proof",
      revision: 1,
      stateRevision: 2,
      html: `<input id="choice" value="initial"><script>paseoVisual.register({read:()=>({state:document.getElementById('choice').value,selection:null}),restore:s=>{document.getElementById('choice').value=s.state},actions:{}})</script>`,
      snapshot: { state: "saved", selection: null },
    },
  };
  // HTML script elements terminate on </script> even when it appears inside JSON text.
  const configurationJson = JSON.stringify(configuration).replaceAll("<", "\\u003c");
  await writeFile(
    entry,
    `
    const {app,BrowserWindow,WebContentsView,session,ipcMain}=require('electron');
    const {appendFileSync}=require('fs');
    const {createServer}=require('http');
    const {PiWorkspaceVisuals}=require(${JSON.stringify(join(repository, "packages/desktop/dist/features/pi-workspace-visuals.js"))});
    const {BrowserKeyboard}=require(${JSON.stringify(join(repository, "packages/desktop/dist/features/browser-keyboard/index.js"))});
    const {PaseoBrowserWebviewRegistry}=require(${JSON.stringify(join(repository, "packages/desktop/dist/features/browser-webviews/registry.js"))});
    // No visual is registered as a browser or automation target.
    const keyboard=new BrowserKeyboard(new PaseoBrowserWebviewRegistry());
    keyboard.registerIpc();
    app.setPath('userData',${JSON.stringify(join(runtime, "user-data"))});
    if(process.platform==='darwin'){app.setActivationPolicy('accessory');app.dock.hide();}
    globalThis.ready=app.whenReady().then(async()=>{
      const html='<button id="opener">Library</button><div id="overlay-root"></div><script id="configuration" type="application/json">'+${JSON.stringify(configurationJson)}+'</script><script>'+${JSON.stringify(hostScript)}+'</script>';
      const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end(html);});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const origin='http://127.0.0.1:'+server.address().port;
      const views=[];
      const visuals=new PiWorkspaceVisuals({ipc:ipcMain,keyboard,createSession:partition=>session.fromPartition(partition,{cache:false}),createView:webPreferences=>{const view=new WebContentsView({webPreferences});views.push(view);return view;},preloadPath:${JSON.stringify(join(repository, "packages/desktop/dist/features/pi-workspace-visual-preload.js"))},appOrigin:origin,reportFailure:error=>{throw error;}});
      // Only the harness host uses Node to load the real React registry. Production guest security is unchanged.
      const win=new BrowserWindow({width:1100,height:700,show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
      visuals.attachWindow(win);
      win.webContents.on('console-message',(_event,...details)=>appendFileSync(${JSON.stringify(join(evidence, "renderer.log"))},JSON.stringify(details)+'\\n'));
      win.webContents.on('did-fail-load',(_event,code,message,url)=>appendFileSync(${JSON.stringify(join(evidence, "renderer.log"))},JSON.stringify({code,message,url})+'\\n'));
      await win.loadURL(origin);
      win.showInactive();
      globalThis.guestState=()=>({visible:views[0].getVisible(),contentsId:views[0].webContents.id,processId:views[0].webContents.getOSProcessId(),sandbox:views[0].webContents.getLastWebPreferences().sandbox,nodeIntegration:views[0].webContents.getLastWebPreferences().nodeIntegration});
      globalThis.guestFocused=()=>views[0].webContents.isFocused();
      globalThis.focusOwnedGuest=async()=>{
        const contents=views[0].webContents;
        const focusEvents=[];
        const guestFocus=()=>focusEvents.push('guest-focus');
        const hostFocus=()=>focusEvents.push('host-focus');
        contents.on('focus',guestFocus);
        win.webContents.on('focus',hostFocus);
        try {
          // Operator-authorized brief focus of this captured private fixture window and child app only.
          // No production lookup, external PID, OS-wide input or browser-registry registration.
          // The earlier diagnostic retained accessory activation policy and never became a key window.
          // The focused-keyboard QA section deliberately makes only this child app foreground-capable.
          app.setActivationPolicy('regular');
          await app.dock.show();
          win.show();
          app.focus({steal:true});
          win.focus();
          const focusDeadline=Date.now()+2000;
          while(!win.isFocused() && Date.now()<focusDeadline) await new Promise(done=>setTimeout(done,20));
          contents.focus();
          while(!contents.isFocused() && Date.now()<focusDeadline) await new Promise(done=>setTimeout(done,20));
          const diagnostics={uid:process.getuid(),guestFocused:contents.isFocused(),hostFocused:win.webContents.isFocused(),windowFocused:win.isFocused(),windowVisible:win.isVisible(),guestVisible:views[0].getVisible(),appHidden:app.isHidden(),activationPolicy:'regular',focusEvents};
          appendFileSync(${JSON.stringify(join(evidence, "focus.jsonl"))},JSON.stringify(diagnostics)+'\\n');
          if(!win.isFocused() || !contents.isFocused())throw new Error('Owned native window/guest did not acquire focus: '+JSON.stringify(diagnostics));
        } finally {
          contents.removeListener('focus',guestFocus);
          win.webContents.removeListener('focus',hostFocus);
        }
      };
      globalThis.guestEnter=async()=>{
        await globalThis.focusOwnedGuest();
        const contents=views[0].webContents;
        if(!contents.isFocused())throw new Error('Guest focus lost before Enter');
        contents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
        contents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      };
      globalThis.guestCommandCenter=async()=>{
        await globalThis.focusOwnedGuest();
        const contents=views[0].webContents;
        if(!contents.isFocused())throw new Error('Guest focus lost before shortcut');
        contents.sendInputEvent({type:'keyDown',keyCode:'K',modifiers:['meta']});
        contents.sendInputEvent({type:'keyUp',keyCode:'K',modifiers:['meta']});
      };
      win.on('closed',()=>server.close());
    });
  `,
  );
  const runtimePath = process.env.PATH;
  if (!runtimePath) throw new Error("Native layer proof requires PATH");
  const electron = await _electron.launch({
    executablePath: join(
      repository,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [entry],
    cwd: runtime,
    env: {
      PATH: runtimePath,
      HOME: runtime,
      TMPDIR: tmpdir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      PASEO_HOME: join(runtime, "paseo"),
      PI_CODING_AGENT_DIR: join(runtime, "pi"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    },
    timeout: 60000,
  });
  try {
    await electron.evaluate(async () => {
      const ready: unknown = Reflect.get(globalThis, "ready");
      if (!(ready instanceof Promise)) throw new Error("Missing native layer fixture");
      await ready;
    });
    const host = await electron.firstWindow();
    await host.evaluate(async () => {
      const ready: unknown = Reflect.get(window, "ready");
      if (!(ready instanceof Promise)) throw new Error("Missing host mount");
      await ready;
    });
    let guest = electron.windows().find((page) => page.url().startsWith("paseo-visual:"));
    const deadline = Date.now() + 15000;
    while (!guest && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
      guest = electron.windows().find((page) => page.url().startsWith("paseo-visual:"));
    }
    if (!guest) throw new Error("No real production visual guest");
    await guest.locator("#choice").waitFor();
    assert.equal(await guest.locator("#choice").inputValue(), "saved");
    await guest.locator("#choice").fill("retained");
    const inspect = async () =>
      z
        .object({
          visible: z.boolean(),
          contentsId: z.number(),
          processId: z.number(),
          sandbox: z.boolean(),
          nodeIntegration: z.boolean(),
        })
        .parse(
          await electron.evaluate(() => {
            const read: unknown = Reflect.get(globalThis, "guestState");
            if (typeof read !== "function") throw new Error("Missing guest observer");
            return Reflect.apply(read, undefined, []);
          }),
        );
    const before = await inspect();
    assert.equal(before.visible, true);
    assert.equal(before.sandbox, true);
    assert.equal(before.nodeIntegration, false);
    for (const count of [1, 2, 1, 0]) {
      await host.evaluate(async (overlayCount) => {
        const set: unknown = Reflect.get(window, "setOverlays");
        if (typeof set !== "function") throw new Error("Missing overlay controls");
        await Reflect.apply(set, window, [overlayCount]);
      }, count);
      assert.equal((await inspect()).visible, count === 0);
      if (count > 0) {
        await host.getByTestId(`overlay-${count}`).waitFor();
        const refusal = await host.evaluate(async () => {
          const capture: unknown = Reflect.get(window, "hiddenCapture");
          if (typeof capture !== "function") throw new Error("Missing capture check");
          return Reflect.apply(capture, window, []);
        });
        assert.match(String(refusal), /not displaying/);
      }
    }
    assert.equal(await guest.locator("#choice").inputValue(), "retained");
    assert.deepEqual(await inspect(), before);
    await guest.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
      ),
    );
    await electron.evaluate(async () => {
      const enter: unknown = Reflect.get(globalThis, "guestEnter");
      if (typeof enter !== "function") throw new Error("Missing trusted input check");
      await Reflect.apply(enter, undefined, []);
    });
    assert.equal(await host.evaluate(() => Reflect.get(window, "hostKeyCount")), 0);
    assert.equal(
      await host.evaluate(() => Reflect.get(window, "commandCenterCount")),
      0,
      "Generated document events cannot dispatch privileged shortcuts",
    );
    await host.evaluate(async () => {
      const ready: unknown = Reflect.get(window, "policyReady");
      if (!(ready instanceof Promise)) throw new Error("No published shortcut policy");
      await ready;
    });
    await electron.evaluate(async () => {
      const shortcut: unknown = Reflect.get(globalThis, "guestCommandCenter");
      if (typeof shortcut !== "function") throw new Error("No native keyboard probe");
      await Reflect.apply(shortcut, undefined, []);
    });
    await host.getByTestId("overlay-1").waitFor({ timeout: 10000 });
    await host.evaluate(async () => {
      await Reflect.get(window, "pendingVisibility");
    });
    assert.equal(await host.evaluate(() => Reflect.get(window, "commandCenterCount")), 1);
    assert.equal((await inspect()).visible, false);
    await host.getByRole("button", { name: "Close overlay" }).click();
    await host.evaluate(async () => {
      await Reflect.get(window, "pendingVisibility");
    });
    assert.equal((await inspect()).visible, true);
    assert.deepEqual(
      await inspect(),
      before,
      "The command menu must restore the same secure guest and process",
    );
    assert.equal(await guest.locator("#choice").inputValue(), "retained");
    assert.equal(
      await electron.evaluate(() => {
        const focused: unknown = Reflect.get(globalThis, "guestFocused");
        if (typeof focused !== "function") throw new Error("No native focus observer");
        return Reflect.apply(focused, undefined, []);
      }),
      true,
      "Closing the command menu must restore native guest focus",
    );
    await host.screenshot({ path: join(evidence, "restored.png") });
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          before,
          after: await inspect(),
          nestedOverlays: [1, 2, 1, 0],
          choices: "retained",
          hiddenCapture: "refused",
          guestHostKeyboardCount: 0,
          focusedGuestCommandCenter: "opened and closed using published shortcut policy",
          nativeFocusRestored: true,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      join(evidence, "failure.json"),
      JSON.stringify(
        { passed: false, error: error instanceof Error ? error.stack : String(error) },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await electron.close();
    await rm(runtime, { recursive: true, force: true });
  }
}, 90000);

function paintedColor(height: number, covered: boolean): number[] {
  if (covered) return [0, 0, 255];
  if (height === 360) return [255, 0, 255];
  return [0, 255, 0];
}

test("real Electron guest capture contains current canvas pixels across view resize and occlusion", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const evidence = await mkdtemp(join(tmpdir(), "paseo-visual-capture-evidence-"));
  const runtime = join(evidence, "runtime");
  await mkdir(runtime);
  const entry = join(runtime, "main.cjs");
  const guestUrl =
    "data:text/html," +
    encodeURIComponent(
      '<!doctype html><title>Capture port regression</title><body style="margin:0;background:white"><canvas width="256" height="128"></canvas></body>',
    );
  await writeFile(
    entry,
    `
    const { app, BrowserWindow, WebContentsView } = require('electron');
    const { captureDisplayedFrame } = require(${JSON.stringify(join(repository, "packages/desktop/dist/features/pi-workspace-visuals.js"))});
    app.setPath('userData', ${JSON.stringify(join(runtime, "user-data"))});
    if (process.platform === 'darwin') { app.setActivationPolicy('accessory'); app.dock.hide(); }
    globalThis.visualCaptureReady = app.whenReady().then(async () => {
      const win = new BrowserWindow({ width:1200, height:800, show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} });
      await win.loadURL('data:text/html,<title>Capture host</title>');
      const view = new WebContentsView({ webPreferences:{partition:'capture-port-regression',sandbox:true,contextIsolation:true,nodeIntegration:false} });
      win.contentView.addChildView(view);
      view.setBounds({x:320,y:72,width:880,height:360});
      await view.webContents.loadURL(${JSON.stringify(guestUrl)});
      win.showInactive();
      globalThis.visualCaptureProbe = async (height, covered) => {
        // A second window above the host occludes it, like a newer desktop window.
        let cover = null;
        if (covered) {
          cover = new BrowserWindow({ ...win.getBounds(), show:false });
          await cover.loadURL('data:text/html,<body style="background:black"></body>');
          cover.showInactive();
          await new Promise((done) => setTimeout(done, 300));
        }
        try {
        view.setBounds({x:320,y:72,width:880,height});
        const color = covered ? '#0000ff' : height === 360 ? '#ff00ff' : '#00ff00';
        await view.webContents.mainFrame.executeJavaScript("(() => {const c=document.querySelector('canvas').getContext('2d'); c.fillStyle="+JSON.stringify(color)+";c.fillRect(0,0,256,128)})()");
        const png = await captureDisplayedFrame({source:view.webContents,valid:()=>!view.webContents.isDestroyed() && win.isVisible(),signal:new AbortController().signal});
        return {data:png.toString('base64'),bounds:view.getBounds(),visible:view.getVisible()};
        } finally {
          if (cover) cover.destroy();
        }
      };
    });
  `,
  );
  const runtimePath = process.env.PATH;
  if (!runtimePath) throw new Error("Electron capture test requires PATH");
  const app = await _electron.launch({
    executablePath: join(
      repository,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [entry],
    cwd: repository,
    env: {
      PATH: runtimePath,
      HOME: runtime,
      TMPDIR: tmpdir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      PASEO_HOME: join(runtime, "paseo"),
      PI_CODING_AGENT_DIR: join(runtime, "pi"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    },
    timeout: 60000,
  });
  try {
    assert.equal(await app.evaluate(() => process.versions.electron), "44.2.0");
    await app.evaluate(async () => {
      const ready: unknown = Reflect.get(globalThis, "visualCaptureReady");
      if (!(ready instanceof Promise)) throw new Error("Capture fixture did not start");
      await ready;
    });
    // Playwright attaches the guest's page asynchronously after the main process reports readiness;
    // wait (bounded) for it instead of assuming it is already listed.
    let guest = app.windows().find((page) => page.url() === guestUrl);
    const guestDeadline = Date.now() + 15_000;
    while (!guest && Date.now() < guestDeadline) {
      await new Promise((done) => setTimeout(done, 100));
      guest = app.windows().find((page) => page.url() === guestUrl);
    }
    if (!guest) throw new Error("Real guest page is missing");
    for (const [height, covered] of [
      [360, false],
      [340, false],
      [340, true],
    ] as const) {
      const raw: unknown = await app.evaluate(
        async (_electronModule, input) => {
          const capture: unknown = Reflect.get(globalThis, "visualCaptureProbe");
          if (typeof capture !== "function") throw new Error("Capture fixture not ready");
          const result: unknown = await Reflect.apply(capture, undefined, [
            input.height,
            input.covered,
          ]);
          return result;
        },
        { height, covered },
      );
      const captured = z
        .object({
          data: z.string(),
          visible: z.boolean(),
          bounds: z.object({ width: z.number(), height: z.number() }),
        })
        .parse(raw);
      assert.equal(captured.visible, true);
      assert.deepEqual(captured.bounds, { width: 880, height });
      const bytes = Buffer.from(captured.data, "base64");
      const label = `${height}${covered ? "-covered" : ""}`;
      await writeFile(join(evidence, `capture-${label}.png`), bytes);
      const observed = await guest.screenshot({ path: join(evidence, `guest-${label}.png`) });
      const expected = paintedColor(height, covered);
      const guestPixel = await sampleCanvas(observed);
      const capturePixel = await sampleCanvas(bytes);
      // Display color management may round a channel by a few units; the oracle decodes
      // with thresholds, so compare against the painted color with the same small margin.
      const near = (pixel: number[]) =>
        pixel.length === 3 &&
        pixel.every((channel, index) => Math.abs(channel - (expected[index] ?? -1)) <= 8);
      assert.equal(
        near(guestPixel),
        true,
        `Guest fixture did not paint: ${JSON.stringify({ evidence, label, guestPixel })}`,
      );
      assert.equal(
        near(capturePixel),
        true,
        JSON.stringify({ evidence, label, capturePixel, guestPixel }),
      );
    }
  } finally {
    await app.close();
    await rm(runtime, { recursive: true, force: true });
  }
}, 90000);
