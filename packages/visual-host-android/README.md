# Paseo visual host (Android)

Companion Android app that renders Pi visuals for the Paseo Android app. Generated documents never
run inside Paseo: they run in this app's own process and UID, embedded into Paseo's agent panel
through `SurfaceControlViewHost`.

## Why a separate app

The app requests no permissions at all, in particular **no `android.permission.INTERNET`**. The
kernel denies sockets to a UID outside the inet group, which closes every network path a document
could use: WebRTC in any realm, `<link rel=preconnect>`, DNS, WebTransport. An in-app WebView
cannot close those paths, CSP has no WebRTC directive, and an `isolatedProcess` service cannot
create views. Permissions are per UID, so the renderer needs its own app.

Inside the app every document gets:

- a WebView in the dedicated `paseo-visual` profile (own renderer, storage and cookies);
- the document only through `shouldInterceptRequest` from `https://visual.invalid/` with a header
  CSP; every other request is answered `403`, and the document is served once;
- denied navigation, windows, downloads, file and content access, geolocation, JS dialogs and every
  `PermissionRequest`;
- one injected port (`window.paseoVisualHost`, main frame only) that the `window.paseoVisual`
  bridge reports through, with bounded message size and rate;
- host-owned deadlines: a document that does not accept a message within 5 s (load within
  9 s, or report its bridge within 3 s after loading) is reported `DOCUMENT_UNRESPONSIVE`
  **before** termination or teardown. Renderer termination runs off the companion main thread;
  all WebView binding, input, capture and destruction stay on the WebView's UI thread. Recovery
  queues new opens for at most 9 s, then returns `RENDERER_UNAVAILABLE` explicitly if the old
  renderer is still terminating. The app retains the stored visual and its sticky-dead display;
- hardware capture of the live document for `visual_inspect({screenshot:true})`: the same WebView
  is recorded into a `RenderNode` and rendered by `HardwareRenderer` into an `ImageReader`
  (WebGL included).

The protocol with Paseo (`VisualHostProtocol.kt`) is mirrored in
`packages/app/modules/paseo-visual-host`. Paseo's `SurfaceView` stays behind its window, so every
Paseo overlay, header and composer is drawn above the visual and is never covered. Touches that land
on the visual's own view are relayed as `MotionEvent`s and dispatched into the same WebView (the
browser creates trusted DOM events from them). The embedded-window IME path is not used:
HyperOS and some stock emulator runs do not reliably show a keyboard for that window. On API 30+
Paseo's own host view serves the IME while an editable element is focused. Its transient native
editor mirror supplies text-before-cursor, selection and text/number/multi-line hints; native
InputConnection operations are relayed to the focused WebView's internal connection, established
once per focus generation and reused for every operation; operations are applied one at a time,
each after the document's barrier receipt confirmed the previous one (bounded by the 5 s message
deadline, after which keyboard focus ends explicitly). A blur from Paseo first applies every
operation accepted before it, in order, then ends focus; any other focus end with operations still
unapplied logs their count (never their content), on its declared
handler (Chromium may use an IME thread). WebView binding, readiness barriers and unbinding stay
on the WebView UI thread. A focus report waits for real native editor metadata rather than lending
a TYPE_NULL connection; establishment has a 2 s deadline that explicitly retires the editor on failure.
The companion
WebView never offers an InputConnection to the system IME. Blur, Back, composer handoff and unmount
retire the focus generation and clear the mirror; delayed receipts/operations cannot revive it.
Both untrusted page-to-native ports share the document's 120-messages/second admission budget,
counted before keyboard payload decoding. Excess retires the keyboard consumer and fails the
document explicitly; reopening gets a fresh document budget. Focused-element text is validated at
both native boundaries, capped at 64 KiB of UTF-8 with validated
UTF-16 selection offsets, and is never logged, persisted or forwarded to JavaScript by the IME
bridge. Malformed or oversized reports explicitly end keyboard focus. This does not restrict the
visual's separate, explicit `read()`/`publish()` state contract.

While a Paseo visual surface is active, Paseo keeps the
service bound and sends `WARM`: the app starts the WebView provider and the `paseo-visual`
profile's renderer with an idle page that loads nothing, so a document's display deadline does not
include the cold start. A force-stopped host is re-warmed at once; a reinstalled one when the
package is added again. After a renderer termination the idle page is re-warmed only once no
visual has been opened for two load deadlines, so re-warming never competes with a recovery open
for the main thread.

## Variants and binding

| Variant (`-PpaseoVariant`) | Visual host id              | Paseo app id     |
| -------------------------- | --------------------------- | ---------------- |
| `development` (default)    | `sh.paseo.debug.visualhost` | `sh.paseo.debug` |
| `production`               | `sh.paseo.visualhost`       | `sh.paseo`       |

Paseo binds `<its own application id>.visualhost`. The exported `VisualHostService` is protected
by `<paseo id>.permission.VISUAL_HOST` with `protectionLevel="signature"`. Both apps declare that
identical permission, so binding works whichever app is installed first and survives reinstalling
the visual host. **Both APKs must be signed with the same key.** A missing, unbindable or
differently signed visual host makes Paseo report `RENDERER_UNAVAILABLE` with an in-surface
explanation; Paseo never falls back to an in-app WebView. Android 10 (API 29) devices report the
same, because embedding needs API 30.

## Build

Offline, with a cached Gradle 8.14.3 distribution, JDK 17, Android SDK 36 and the cached AGP
8.11.0 / Kotlin 2.1.20 / `androidx.webkit:webkit:1.14.0` artifacts. No wrapper is checked in.

```bash
gradle -p packages/visual-host-android --offline assembleRelease \
  -PpaseoSigningStore=<keystore> \
  -PpaseoSigningAlias=<alias> \
  -PpaseoSigningPassword=<password>
```

The build produces exactly one APK under `app/build/outputs/apk/release/`. Release builds without
the three signing properties fail; there is no unsigned or debug-signed fallback. Use the keystore
that signs the Paseo APK (for a development Paseo build from `expo prebuild`, that is
`packages/app/android/app/debug.keystore`, alias `androiddebugkey`).

## Responsiveness diagnostics and development faults

Every variant logs main-thread stalls of at least 1000 ms under `PaseoVisualHost`, during the
stall at least every 5 s and once at its end, with sampled stack frames and the operation name:
`main thread stalled <ms> ms during <operation>`. The keyboard bridge also logs, per focus, the
latency from the focus report to the native editor (`Visual editor established after <ms> ms`)
and the reason (never the content) for every ignored, skipped, dropped or rejected input operation
(Paseo: `PaseoVisualEditor` dropped/stopped lines; companion: ended/skipped lines). Paseo requests
the keyboard explicitly when a newly focused element's report arrives, and again once the IMM
binds its host view if it was not bound yet. Diagnostics carry no document/input contents.
They do not change display behavior.

Only the development application variant reads these Android system properties (including release
builds of that variant); the production variant never reads them:

- `debug.paseo.visualhost.slow_renderer_ms`: integer 1–20000 delays every initiated renderer
  termination on its terminating thread, after logging
  `debug slow renderer: terminate delayed <ms> ms on thread <thread name>`.
- `debug.paseo.visualhost.block_main_ms`: checked off-main at least every 2 s; each changed positive
  integer 1–20000 schedules one main-thread task that logs `debug block main: <ms> ms` then blocks.

Unset, zero and invalid values inject no fault. These seams diagnose OEM lifecycle delays; they
are not settings for ordinary users. Physical HyperOS/Gboard verification remains a separate gate.

## Native boundary tests

After offline dependency preparation, run
`node packages/visual-host-android/tests/run-keyboard-boundaries.mjs`. It builds the two product
APKs and a dependency-free Android instrumentation APK, then exercises the installed production
editor/keyboard consumers on a fresh, locked judge emulator. `--build <build.json>` reuses the
result of `qa/pi-workspace/android/build.mjs`. Missing targets, native classes or instrumentation
results fail the run; no physical adb serial is accepted. Full logs are in a fresh `/tmp/af1-`
location printed by the runner, without field contents. This complements, not replaces, the frozen
AF1 keyboard/recovery flow and earlier regressions.

## Development install

A development setup has two APKs side by side: **Paseo Debug** (`sh.paseo.debug`) and its
**Paseo visual host** (`sh.paseo.debug.visualhost`). Install both; order does not matter. They
coexist with a production Paseo install.
