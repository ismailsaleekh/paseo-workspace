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
- host-owned deadlines: a document that does not accept a message within 5 s (or load within
  9 s) has its renderer terminated (`WebViewRenderProcess.terminate()`) and is reported
  `DOCUMENT_UNRESPONSIVE`, well inside the daemon's 13 s display timeout;
- hardware capture of the live document for `visual_inspect({screenshot:true})`: the same WebView
  is recorded into a `RenderNode` and rendered by `HardwareRenderer` into an `ImageReader`
  (WebGL included).

The protocol with Paseo (`VisualHostProtocol.kt`) is mirrored in
`packages/app/modules/paseo-visual-host`. Paseo's `SurfaceView` stays behind its window, so every
Paseo overlay, header and composer is drawn above the visual and is never covered. Touches that land
on the visual's own view are relayed as `MotionEvent`s and dispatched into the same WebView (the
browser creates trusted DOM events from them); touching the visual focuses the host `SurfaceView`,
which hands window focus to the embedded hierarchy on Android 12+ so the keyboard reaches text
fields in the document. While a Paseo visual surface is active, Paseo keeps the
service bound and sends `WARM`: the app starts the WebView provider and the `paseo-visual`
profile's renderer with an idle page that loads nothing, so a document's display deadline does not
include the cold start. A force-stopped host is re-warmed at once; a reinstalled one when the
package is added again.

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

## Development install

A development setup has two APKs side by side: **Paseo Debug** (`sh.paseo.debug`) and its
**Paseo visual host** (`sh.paseo.debug.visualhost`). Install both; order does not matter. They
coexist with a production Paseo install.
