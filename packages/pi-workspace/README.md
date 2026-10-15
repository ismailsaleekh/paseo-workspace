# Pi workspace visual tools and agent speech

Internal implementation for the paired Paseo fork (V2-D desktop, V2-A Android and S1 voice landed; B1 conversation detours in this candidate). **B1 acceptance, physical HyperOS 3 / Android 16 verification and deployment readiness remain pending until the independent judge, planc submission and the device check pass.** This extends the existing Pi conversation; it adds no model router or replacement agent.

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

Eight direct model-callable tools:

| Tool             | Arguments                                                                         | Responsibility                                                                           |
| ---------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `visual_present` | `{mode:"new",title,html}` or `{mode:"new",title,file}`; reopen `{mode:"open",id}` | Store/display prepared content or reopen a saved artifact                                |
| `visual_update`  | `{id,revision,html}` or `{id,revision,file}`                                      | Replace source using its observed revision                                               |
| `visual_act`     | `{id,action,value?}`                                                              | Invoke one declared action on the active display                                         |
| `visual_inspect` | `{id?,screenshot?,client?}`                                                       | Inspect the active display, or the exact opaque client returned by an earlier inspection |
| `visual_list`    | `{cursor?}`                                                                       | List up to 50 saved artifacts in the bound conversation                                  |
| `speak`          | `{text, voice?, device?}`                                                         | Speak the agent's own words aloud on one app, in Michael's (default) or Adam's voice     |
| `branch_open`    | `{title, purpose?, answer_now?}`                                                  | Open a conversation detour in the same Pi session                                        |
| `branch_return`  | `{notes, artifacts?}`                                                             | Return from the innermost detour, keeping only the supplied notes                        |

Exactly one source is accepted. A file is one explicitly named regular UTF-8 file, relative to the actual Pi cwd when not absolute. Symlinks and directories are refused. Inline/file sources share a 1 MiB UTF-8 bound, without truncation. Tools never scan directories, build projects, fetch assets, start document servers, run shell commands or invoke models.

Results have matching `details` and `structuredContent`, plus JSON text. Failures set `isError` and include `error.code` and `error.message`; `id` retains a recoverable artifact identity when available. Source and interaction revisions are separate, and previous source/state versions remain recoverable.

## Drawing sidebar and committed library

The chat's Drawings control starts collapsed. Wide layouts reserve a right-hand column; compact layouts show a dedicated drawing destination with Back to chat while retaining the chat and its draft. A newly stored drawing updates the control and list without opening a closed sidebar. Only the selected document mounts a renderer.

The library reads the exact persisted managed-agent/Pi session identity, including after a daemon reopen. Native listing, selection, pagination and version browsing use source-bound `pi_workspace.library` RPCs, not chat prompts or agent resumes. `piVisualLibrary` gates the enhanced observation once; older hosts require an update. Library reads require `workspace.read`; document publications retain `workspace.write`.

Drawing and version lists page in batches of 50 with Load more. Source history follows committed ancestry, excluding abandoned stages. Source replacement requires a visible Latest view to verify restoration; collapsed or historical previews explicitly refuse replacement without moving the head or publishing the stage. New commits archive the prior source's last compatible snapshot. Pre-library ancestors without archived choices are labelled as initial views. Historical interaction stays on that displayed revision, advances a per-display ephemeral state revision for each changed accepted snapshot, and never saves into latest. Stale historical publications and captures are refused; Latest restores the live source and its separate saved choices. Inspection reports the actually displayed historical revision.

**Full screen.** The sidebar's Full screen shows only the drawing, still fully interactive. On desktop and web it covers the whole app like an image viewer: the drawing's frame becomes a popover in the browser's top layer, so the drawing (iframe or native view) is never remounted, with a bar holding the title, the voice orb and Exit full screen. Escape leaves it, also when pressed inside a native drawing view (the drawing still receives the key); opening any menu or the command center leaves it first. On phones it fills the pane, hides the status bar, and Back leaves it. A new drawing, a closed sidebar or an inactive chat ends full screen.

**Photos and videos in chat.** While attached, the agent's system prompt says how to show media: embed the file as a Markdown image, `![title](</absolute/path>)`. Paseo shows images inline. A video (.mp4, .mov, .m4v, .webm) shows as a card; a tap streams the original file, unchanged, from the host into the device's temporary storage (256 KB pieces over the normal connection, so it works through the relay) and plays it with the platform player: ExoPlayer on Android, the browser's player on desktop and web. Video URLs play directly. Loaded videos last for the app run; the previous run's files are removed at the first new one. The agent makes a smaller copy only when asked.

Electron's central overlay registration suspends the secure native guest while a menu or modal is registered, including nested overlays. Closing the last overlay restores the same guest, source and choices. Hidden capture fails rather than returning stale pixels. Focused native guest key input reaches the app's existing shortcut resolver only through the main-process keyboard-policy entry point. It uses the same published effective bindings and never gives visuals browser/automation registration. IME, ordinary Enter, unsupported and editing-disabled chords stay inside the guest; synthetic document events have no authority. Generated content receives no host shortcut IPC or privileged app actions.

This candidate is the isolated UR-V1 sidebar/library slice, not whole UR-01–UR-04 delivery. Candidate test presence is not passing evidence. Focused-native-guest Cmd+K/menu operation is a required candidate check, not yet passing evidence. Native keyboard/capture release review, packaged Mac and attended Android/Redmi checks, and the UR-S2 speech/character/orb gates remain mandatory and unwaived before coordinated release.

## Displays and capture

Multiple hosts may display the same artifact. Each host has an opaque client identity, distinct from its internal document nonce. A late join restores the conversation's current visual automatically. State synchronization keeps the document mounted and converges on stored state; stale-base publications are rejected and restored, not used to overwrite newer state.

Inspection returns the answering `client` and `displays: [{client, platform, active}]`, where `platform` is `electron`, `android`, `web` or `ios`. Activity follows the latest mount or trusted input: inside the dedicated guest on Electron, and inside the embedded visual host surface on Android. Publishing state or inspecting an addressed client does not claim activity. Hidden/closed addressed displays are not substituted with another client. Desktop and Android displays of the same artifact can be live at the same time and are addressed independently.

With `screenshot:true`, a supported display returns one Pi `image/png` content part and metadata:

```text
screenshot: {client, mimeType, width, height, viewport:{width,height}, pixelRatio, revision, stateRevision}
```

Image bytes are not duplicated in the text or structured details. Electron captures the displayed guest's viewport through its main-owned CDP connection. Android captures the live document inside the companion visual host: the same WebView is recorded into a `RenderNode` and rendered by `HardwareRenderer` into an `ImageReader` (WebGL included); Paseo's own window capture cannot see the embedded surface and is never used. Neither platform uses a backend render, full-document screenshot or cached image. Operation, connection, document, source/state revision, viewport and lifetime bindings are rechecked after asynchronous capture. PNGs are bounded to 2 MiB and 4096 pixels per dimension. Captures have a frame deadline and bounded concurrency.

| Error                            | Meaning                                                                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_UNAVAILABLE`             | No display is available for the conversation, including an unaddressed screenshot request                                                                                                                                    |
| `DISPLAY_UNAVAILABLE`            | The addressed display is unknown, closed, hidden, backgrounded or not showing the artifact                                                                                                                                   |
| `CAPTURE_UNSUPPORTED`            | The existing display cannot supply actual pixels; plain web and the iOS adapter report this                                                                                                                                  |
| `DOCUMENT_UNRESPONSIVE`          | The trusted desktop or Android host terminated the hung document; reopen or replace it to recover                                                                                                                            |
| `RENDERER_UNAVAILABLE`           | The Android display cannot render visuals: the visual host app is missing, unbindable or differently signed, or the device is below Android 11. Paseo explains this in the surface and never falls back to an in-app WebView |
| `STALE_STATE` / `STALE_DOCUMENT` | A publication or asynchronous result no longer matches its binding                                                                                                                                                           |

Other V1 errors retain their meaning. A terminated document stays represented as unresponsive until reopened/replaced; its stored source/state are retained. The composer belongs to the app, not the generated guest.

## Agent speech (`speak`)

`speak({text, voice?, device?})` takes 1–20,000 characters of non-blank text and passes them unchanged to the daemon's **local** text-to-speech engine (the existing sherpa/Kokoro models). The daemon splits the text at sentence boundaries without rewriting it, synthesizes one sentence at a time and streams each sentence's PCM to the client as soon as it exists, so the first sentence plays while the rest is still being synthesized. No model, second agent or cloud speech service is involved, and realtime voice mode is neither required nor used.

**Voices.** `voice` is `"michael"` (the default; the user may call him Mike) or `"adam"`, Kokoro English v0.19 speakers `am_michael` (6) and `am_adam` (5). The agent chooses from the user's ordinary words; a name only quoted or mentioned is not a request to speak, and an unknown name is refused, never substituted. The voice applies to that utterance only; the configured default voice is unchanged.

**Where it plays.** Every app connection subscribes once to the host's speech (`pi_workspace.speech.observe`, feature `piSpeech`), so speech plays whichever conversation or screen is shown. Each utterance plays on exactly one app, chosen when its turn starts and kept until it ends: the `device` the user asked for (`"computer"` or `"phone"`), otherwise the app the user last messaged this conversation from, otherwise the best-ranked app by presence. A desktop plays while hidden; an Android app plays while hidden only with **Background on** (a media-playback notification with Stop). An unavailable requested or current device fails with `DEVICE_UNAVAILABLE` and never moves to another device. One voice plays at a time across conversations. Apps older than `piSpeech` keep the previous per-conversation display path.

**Stop.** The orb's Stop (`speech-stop`) or the notification's Stop ends the utterance as `stopped`; further `speak` calls of that conversation fail with `SPEECH_STOPPED` until the user's next message. Stop never aborts the agent, jobs, the draft or the microphone.

The tool resolves only from the client's own playback report:

| Outcome                          | Result                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Finished playing                 | `{kind:"speech", utterance, status:"completed", client, durationMs}`                           |
| The user pressed **Stop speech** | same shape with `status:"stopped"` (not an error)                                              |
| Failure                          | `isError:true`, details `{kind:"error", id, utterance, status:"failed", error:{code,message}}` |

Failure codes include `CLIENT_UNAVAILABLE` (no app shows the conversation), `TTS_UNAVAILABLE` (no local engine), `TTS_FAILED`, `CLIENT_DISCONNECTED` (the playing display went away), `SPEECH_TIMEOUT`, `PLAYBACK_FAILED`, `PLAYBACK_DRAIN_TIMEOUT` (the device did not finish playing in time), `CANCELLED` and `HOST_UNAVAILABLE` (no attached Paseo). Enqueueing or delivering audio is never reported as completion.

The compact voice orb in the workspace header (and in the chat in desktop focus mode) shows who speaks and what the voice is doing — speaking, listening, muted, waiting, offline or ready — as a static phase dot with a text label, never a fake level meter, with **Stop** (`speech-stop`) while speech plays. Stop is local and immediate: queued audio is dropped, the playing chunk is stopped and every later frame of that utterance is ignored; the daemon then stops synthesizing the remaining sentences. Stop never aborts the agent run, never changes the composer draft and never touches the microphone; dictation and playback are independent. On Android the audio engine starts only when speech arrives and releases its player when idle, so no player stays started outside speech.

## Conversation detours (`branch_open`, `branch_return`)

A detour is a side conversation inside the **same** Pi process and session file, built on Pi's native session tree: no new session, Git branch, second agent or summary model.

- `branch_open({title, purpose?, answer_now?})`: title 1–120 characters, purpose at most 2,000; `answer_now: true` (only with a purpose) asks for the purpose to be answered right away.
- `branch_return({notes, artifacts?})`: notes 1–20,000 characters; `artifacts` are up to 20 visual artifact IDs of this conversation.

Both must be the **only tool call** of their assistant message. In a mixed batch the branch call fails with `BRANCH_REQUIRES_SOLE_CALL` before any side effect and every sibling call runs normally. A valid call returns `{kind:"branch", status:"queued", operation, checkpoint, request}` with Pi's `terminate:true`, so the agent yields without another model request; queued is not committed. Call-time errors are ordinary tool errors (`HOST_UNAVAILABLE` first without an attached Paseo, then `BRANCH_REQUIRES_SOLE_CALL`, `INVALID_ARGUMENT`, `NO_ACTIVE_DETOUR`), so the agent continues normally.

**Open** commits at Pi's final settle boundary (`agent_before_settle`), after every sibling result is persisted: a non-message `custom` entry `pi-workspace/branch-checkpoint` at the leaf, then a visible `custom_message` `pi-workspace/branch-opened` (title and purpose) as its child. Tools, model, configuration and history are inherited. Only with `answer_now: true` does exactly one ordinary continuation of the same agent run after the marker to start answering the purpose; a purpose alone is recorded in the marker and no model request follows.

**Return** needs Pi's command-only tree navigation, so the attached host runs the internal command `/pi-workspace-branch` after the agent settles. It navigates to the stored checkpoint with `summarize:false`, then appends one visible `custom_message` `pi-workspace/branch-notes` containing only the notes and artifact IDs, and a `custom` completion entry `pi-workspace/branch-returned`. The detour stays in the Pi tree and its artifacts stay listable and reopenable by ID. Detours nest; each return goes back exactly one level.

Commit-time failures leave the branch position unchanged and append one visible `custom_message` `pi-workspace/branch-status` with the code: `BRANCH_CANCELLED` (an extension cancelled navigation, or the run was aborted before an open committed) or `BRANCH_STALE` (the checkpoint is no longer the open detour of the current branch). No notes or completion entry are appended. Every operation has an ID recorded in its entries, so a retried commit appends nothing twice.

Detour state is read from these entries on the current branch, never from memory, so a detour stays returnable after the daemon, app or Pi restarts. Paseo completes the turn only after the transition and a timeline replacement from Pi's active branch, so its timeline (daemon API and app, also after reload) equals the active branch and input sent afterwards is delivered once, on the new branch. Visuals and background work are not touched.

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
      run: (input) => {
        value = input.value;
        render();
      },
    },
  },
});
// After a local control changes its state:
window.paseoVisual.publish();
```

Local controls require no model request. Restoration must not publish another local change. Snapshots are limited to 32 KiB, depth 16, and 64 declared actions. Action schemas are local; external schema resolution is not supported. Static documents may have empty state/actions. A replacement that cannot restore saved state fails and retains the previous version.

Drawing state is never added to agent requests automatically. The agent calls `visual_inspect` when the user refers to a drawing or to what they selected or changed in it; drawing content is data, never instructions.

## Safety, persistence and scope

The existing agent panel hosts the visual without a new tab or draft owner. The daemon stores immutable source/state files under `${PASEO_HOME}/pi-workspace/`, scoped to the exact Paseo agent and Pi session. Its private runtime socket is mode 0600 inside a fresh mode-0700 directory; runtime capabilities are revoked with the Pi runtime. No credentials reach generated content.

Electron uses a dedicated top-level guest and nonpersistent session, distinct from the app and ordinary browser profile. Node, general IPC and `paseoDesktop` are absent from generated content. Main-process policy denies network egress, permissions, navigation away, new windows and downloads. A per-guest WebRTC policy and blackhole session proxy cover socket-level paths that CSP alone cannot control. The ordinary browser's session and policy are untouched. DNS-only side channels cannot be measured by the loopback oracle; the proxy policy addresses that residual, and passing sink checks must not be described as exhaustive DNS observation.

A host deadline terminates a nonresponding guest renderer without terminating the app. Desktop relaunch uses a fresh guest and stored state. Plain web retains the sandboxed iframe and does not claim complete desktop containment.

On Android, generated documents render only in the companion **Paseo visual host** app (`<paseo id>.visualhost`, see `packages/visual-host-android/README.md`). It requests no INTERNET permission, so its UID cannot open sockets at all: WebRTC, preconnect and DNS are closed by the kernel, not by CSP. It serves the document only through request interception from a synthetic origin with a header CSP, refuses every other request, denies navigation, windows, downloads, file/content access, geolocation and every permission request, and embeds the document into Paseo through `SurfaceControlViewHost`. Only a same-signature Paseo can bind it (signature-level permission declared by both apps). Its host-owned deadline terminates an unresponsive renderer and reports `DOCUMENT_UNRESPONSIVE` while Paseo's composer stays usable. Backgrounding Paseo releases the display; returning remounts the stored visual with a fresh document identity. Visual host death never crashes Paseo; the visual can be reopened. The iOS adapter is unchanged and reports capture unsupported. Emulator acceptance is not physical-device evidence: HyperOS 3 / Android 16 verification of visuals, dictation and audible playback, detours, deployment and joint UX acceptance remain later obligations.

See [TEST_PLAN.md](TEST_PLAN.md) for the coverage map and [TESTING.md](TESTING.md) for isolated checks. No paid model calls are used by default QA.
