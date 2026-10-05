# Pi workspace visual tools and agent speech

Internal implementation for the paired Paseo fork (V2-D desktop and V2-A Android landed; S1 voice in this candidate). **S1 acceptance, physical HyperOS 3 / Android 16 dictation/playback verification and deployment readiness remain pending until the independent judge, planc submission and the device check pass.** This extends the existing Pi conversation; it adds no model router or replacement agent.

## Install the paired artifacts

Use the Pi-workspace tarball and fork protocol tarball from the **same accepted candidate tree**. Upstream `@getpaseo/protocol@0.10.3` does not contain this feature despite sharing the version number. See [PUBLISHING.md](PUBLISHING.md). Do not resolve the protocol dependency from the upstream registry.

In an isolated development installation directory:

```sh
npm install --ignore-scripts --legacy-peer-deps ./paseo-protocol.tgz ./paseo-pi-workspace.tgz
pi -e ./node_modules/@getpaseo/pi-workspace/extensions/workspace.ts
```

The names above stand for the exact reviewed artifacts. Pi supplies its SDK and TypeBox peers. A local checkout can load `extensions/workspace.ts` after dependency installation and the fork protocol build. Git/npm distribution needs a distinct published fork protocol identity before it is independently supported.

Loading outside a compatible Paseo host registers the tools without starting a daemon or model. Calls return structured unavailable-host errors. Development and certification do not authorize installation into the active user session.

## Tools

Six direct model-callable tools; no branch stubs:

| Tool | Arguments | Responsibility |
| --- | --- | --- |
| `visual_present` | `{mode:"new",title,html}` or `{mode:"new",title,file}`; reopen `{mode:"open",id}` | Store/display prepared content or reopen a saved artifact |
| `visual_update` | `{id,revision,html}` or `{id,revision,file}` | Replace source using its observed revision |
| `visual_act` | `{id,action,value?}` | Invoke one declared action on the active display |
| `visual_inspect` | `{id?,screenshot?,client?}` | Inspect the active display, or the exact opaque client returned by an earlier inspection |
| `visual_list` | `{cursor?}` | List up to 50 saved artifacts in the bound conversation |
| `speak` | `{text}` | Speak the agent's own words aloud on the one app client showing the conversation |

Exactly one source is accepted. A file is one explicitly named regular UTF-8 file, relative to the actual Pi cwd when not absolute. Symlinks and directories are refused. Inline/file sources share a 1 MiB UTF-8 bound, without truncation. Tools never scan directories, build projects, fetch assets, start document servers, run shell commands or invoke models.

Results have matching `details` and `structuredContent`, plus JSON text. Failures set `isError` and include `error.code` and `error.message`; `id` retains a recoverable artifact identity when available. Source and interaction revisions are separate, and previous source/state versions remain recoverable.

## Displays and capture

Multiple hosts may display the same artifact. Each host has an opaque client identity, distinct from its internal document nonce. A late join restores the conversation's current visual automatically. State synchronization keeps the document mounted and converges on stored state; stale-base publications are rejected and restored, not used to overwrite newer state.

Inspection returns the answering `client` and `displays: [{client, platform, active}]`, where `platform` is `electron`, `android`, `web` or `ios`. Activity follows the latest mount or trusted input: inside the dedicated guest on Electron, and inside the embedded visual host surface on Android. Publishing state or inspecting an addressed client does not claim activity. Hidden/closed addressed displays are not substituted with another client. Desktop and Android displays of the same artifact can be live at the same time and are addressed independently.

With `screenshot:true`, a supported display returns one Pi `image/png` content part and metadata:

```text
screenshot: {client, mimeType, width, height, viewport:{width,height}, pixelRatio, revision, stateRevision}
```

Image bytes are not duplicated in the text or structured details. Electron captures the displayed guest's viewport through its main-owned CDP connection. Android captures the live document inside the companion visual host: the same WebView is recorded into a `RenderNode` and rendered by `HardwareRenderer` into an `ImageReader` (WebGL included); Paseo's own window capture cannot see the embedded surface and is never used. Neither platform uses a backend render, full-document screenshot or cached image. Operation, connection, document, source/state revision, viewport and lifetime bindings are rechecked after asynchronous capture. PNGs are bounded to 2 MiB and 4096 pixels per dimension. Captures have a frame deadline and bounded concurrency.

| Error | Meaning |
| --- | --- |
| `CLIENT_UNAVAILABLE` | No display is available for the conversation, including an unaddressed screenshot request |
| `DISPLAY_UNAVAILABLE` | The addressed display is unknown, closed, hidden, backgrounded or not showing the artifact |
| `CAPTURE_UNSUPPORTED` | The existing display cannot supply actual pixels; plain web and the iOS adapter report this |
| `DOCUMENT_UNRESPONSIVE` | The trusted desktop or Android host terminated the hung document; reopen or replace it to recover |
| `RENDERER_UNAVAILABLE` | The Android display cannot render visuals: the visual host app is missing, unbindable or differently signed, or the device is below Android 11. Paseo explains this in the surface and never falls back to an in-app WebView |
| `STALE_STATE` / `STALE_DOCUMENT` | A publication or asynchronous result no longer matches its binding |

Other V1 errors retain their meaning. A terminated document stays represented as unresponsive until reopened/replaced; its stored source/state are retained. The composer belongs to the app, not the generated guest.

## Agent speech (`speak`)

`speak({text})` takes 1–20,000 characters of non-blank text and passes them unchanged to the daemon's **local** text-to-speech engine (the existing sherpa/Kokoro models). The daemon splits the text at sentence boundaries without rewriting it, synthesizes one sentence at a time and streams each sentence's PCM to the client as soon as it exists, so the first sentence plays while the rest is still being synthesized. No model, second agent or cloud speech service is involved, and realtime voice mode is neither required nor used: agent speech works with it disabled.

Playback goes to exactly one client: among the visible app displays of this conversation that announced speech playback, the daemon ranks by the connection's `client_heartbeat` presence (focused on this agent, then most recent activity, the same presence notification routing uses), then the latest mount. Activity age only ranks: an idle operator still hears speech. An app that reports itself hidden, such as a backgrounded Android app, does not display the conversation and is never chosen. Utterances of one conversation play in order; speech holds no session input lock, and visual tools, typing and other tools stay responsive (`speak` runs in parallel with other tool calls).

The tool resolves only from the client's own playback report:

| Outcome | Result |
| --- | --- |
| Finished playing | `{kind:"speech", utterance, status:"completed", client, durationMs}` |
| The user pressed **Stop speech** | same shape with `status:"stopped"` (not an error) |
| Failure | `isError:true`, details `{kind:"error", id, utterance, status:"failed", error:{code,message}}` |

Failure codes include `CLIENT_UNAVAILABLE` (no app shows the conversation), `TTS_UNAVAILABLE` (no local engine), `TTS_FAILED`, `CLIENT_DISCONNECTED` (the playing display went away), `SPEECH_TIMEOUT`, `PLAYBACK_FAILED`, `PLAYBACK_DRAIN_TIMEOUT` (the device did not finish playing in time), `CANCELLED` and `HOST_UNAVAILABLE` (no attached Paseo). Enqueueing or delivering audio is never reported as completion.

The app shows a **Stop speech** control (`speech-stop`) while speech plays, on desktop and Android. Stop is local and immediate: queued audio is dropped, the playing chunk is stopped and every later frame of that utterance is ignored; the daemon then stops synthesizing the remaining sentences. Stop never aborts the agent run, never changes the composer draft and never touches the microphone; dictation and playback are independent. On Android the audio engine starts only when speech arrives and releases its player when idle, so no player stays started outside speech.

## Dictation

Dictation stays Paseo's ordinary composer path with local speech-to-text; `speak` does not change it. The composer receives exactly the engine's final transcript (surrounding whitespace trimmed); a blank final is an explicit failed state with retry/cancel, never replaced by provisional text. Captured audio streams to the daemon as it is recorded, and the copy retained for reconnect replay is bounded to 30 minutes; reaching the bound stops recording with an explicit error instead of dropping audio. The composer is read-only while dictating, and typed text before and after dictation is preserved in order. Stable test ids: `dictation-toggle`, `dictation-insert`, `dictation-cancel`.

## Interactive documents

Prepared HTML may contain text, controls, SVG, Canvas and embedded assets. There is no required explanation template. Register once before readiness:

```js
window.paseoVisual.register({
  read: () => ({ state: { value }, selection }),
  restore: (snapshot) => {
    value = snapshot.state.value;
    selection = snapshot.selection;
    render();
  },
  actions: {
    setValue: {
      description: "Change the displayed value",
      parameters: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      run: (input) => { value = input.value; render(); },
    },
  },
});
// After a local control changes its state:
window.paseoVisual.publish();
```

Local controls require no model request. Restoration must not publish another local change. Snapshots are limited to 32 KiB, depth 16, and 64 declared actions. Action schemas are local; external schema resolution is not supported. Static documents may have empty state/actions. A replacement that cannot restore saved state fails and retains the previous version.

The next ordinary Pi request receives a separate `<pi-workspace-context>` observation marked as untrusted UI data. User text is unchanged. The envelope excludes full HTML and image bytes.

## Safety, persistence and scope

The existing agent panel hosts the visual without a new tab or draft owner. The daemon stores immutable source/state files under `${PASEO_HOME}/pi-workspace/`, scoped to the exact Paseo agent and Pi session. Its private runtime socket is mode 0600 inside a fresh mode-0700 directory; runtime capabilities are revoked with the Pi runtime. No credentials reach generated content.

Electron uses a dedicated top-level guest and nonpersistent session, distinct from the app and ordinary browser profile. Node, general IPC and `paseoDesktop` are absent from generated content. Main-process policy denies network egress, permissions, navigation away, new windows and downloads. A per-guest WebRTC policy and blackhole session proxy cover socket-level paths that CSP alone cannot control. The ordinary browser's session and policy are untouched. DNS-only side channels cannot be measured by the loopback oracle; the proxy policy addresses that residual, and passing sink checks must not be described as exhaustive DNS observation.

A host deadline terminates a nonresponding guest renderer without terminating the app. Desktop relaunch uses a fresh guest and stored state. Plain web retains the sandboxed iframe and does not claim complete desktop containment.

On Android, generated documents render only in the companion **Paseo visual host** app (`<paseo id>.visualhost`, see `packages/visual-host-android/README.md`). It requests no INTERNET permission, so its UID cannot open sockets at all: WebRTC, preconnect and DNS are closed by the kernel, not by CSP. It serves the document only through request interception from a synthetic origin with a header CSP, refuses every other request, denies navigation, windows, downloads, file/content access, geolocation and every permission request, and embeds the document into Paseo through `SurfaceControlViewHost`. Only a same-signature Paseo can bind it (signature-level permission declared by both apps). Its host-owned deadline terminates an unresponsive renderer and reports `DOCUMENT_UNRESPONSIVE` while Paseo's composer stays usable. Backgrounding Paseo releases the display; returning remounts the stored visual with a fresh document identity. Visual host death never crashes Paseo; the visual can be reopened. The iOS adapter is unchanged and reports capture unsupported. Emulator acceptance is not physical-device evidence: HyperOS 3 / Android 16 verification of visuals, dictation and audible playback, detours, deployment and joint UX acceptance remain later obligations.

See [TEST_PLAN.md](TEST_PLAN.md) for the coverage map and [TESTING.md](TESTING.md) for isolated checks. No paid model calls are used by default QA.
