# Pi workspace visual tools

Internal V2-D implementation for the paired Paseo fork. **V2-D acceptance and deployment readiness remain pending until the independent judge and planc submission pass.** This extends the existing Pi conversation; it adds no model router or replacement agent.

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

Five direct model-callable tools; no speech or branch stubs:

| Tool | Arguments | Responsibility |
| --- | --- | --- |
| `visual_present` | `{mode:"new",title,html}` or `{mode:"new",title,file}`; reopen `{mode:"open",id}` | Store/display prepared content or reopen a saved artifact |
| `visual_update` | `{id,revision,html}` or `{id,revision,file}` | Replace source using its observed revision |
| `visual_act` | `{id,action,value?}` | Invoke one declared action on the active display |
| `visual_inspect` | `{id?,screenshot?,client?}` | Inspect the active display, or the exact opaque client returned by an earlier inspection |
| `visual_list` | `{cursor?}` | List up to 50 saved artifacts in the bound conversation |

Exactly one source is accepted. A file is one explicitly named regular UTF-8 file, relative to the actual Pi cwd when not absolute. Symlinks and directories are refused. Inline/file sources share a 1 MiB UTF-8 bound, without truncation. Tools never scan directories, build projects, fetch assets, start document servers, run shell commands or invoke models.

Results have matching `details` and `structuredContent`, plus JSON text. Failures set `isError` and include `error.code` and `error.message`; `id` retains a recoverable artifact identity when available. Source and interaction revisions are separate, and previous source/state versions remain recoverable.

## Displays and capture

Multiple hosts may display the same artifact. Each host has an opaque client identity, distinct from its internal document nonce. A late join restores the conversation's current visual automatically. State synchronization keeps the document mounted and converges on stored state; stale-base publications are rejected and restored, not used to overwrite newer state.

Inspection returns the answering `client` and `displays: [{client, platform, active}]`. On Electron, activity follows the latest mount or trusted input in the dedicated guest. Publishing state or inspecting an addressed client does not claim activity. Hidden/closed addressed displays are not substituted with another client.

With `screenshot:true`, a supported display returns one Pi `image/png` content part and metadata:

```text
screenshot: {client, mimeType, width, height, viewport:{width,height}, pixelRatio, revision, stateRevision}
```

Image bytes are not duplicated in the text or structured details. Electron captures the displayed guest's viewport through its main-owned CDP connection, never a backend render, full-document screenshot or cached image. Operation, connection, document, source/state revision, viewport and lifetime bindings are rechecked after asynchronous capture. PNGs are bounded to 2 MiB and 4096 pixels per dimension. Captures have a five-second frame deadline and bounded concurrency.

| Error | Meaning |
| --- | --- |
| `CLIENT_UNAVAILABLE` | No display is available for the conversation, including an unaddressed screenshot request |
| `DISPLAY_UNAVAILABLE` | The addressed display is unknown, closed, hidden or not showing the artifact |
| `CAPTURE_UNSUPPORTED` | The existing display cannot supply actual pixels; plain web and the current native adapter report this |
| `DOCUMENT_UNRESPONSIVE` | The trusted desktop host terminated the hung document; reopen or replace it to recover |
| `STALE_STATE` / `STALE_DOCUMENT` | A publication or asynchronous result no longer matches its binding |

Other V1 errors retain their meaning. A terminated document stays represented as unresponsive until reopened/replaced; its stored source/state are retained. The composer belongs to the app, not the generated guest.

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

A host deadline terminates a nonresponding guest renderer without terminating the app. Desktop relaunch uses a fresh guest and stored state. Plain web retains the sandboxed iframe and does not claim complete desktop containment. Android/native containment, native capture and physical HyperOS 3 / Android 16 verification remain V2-A. Speech, detours, deployment and joint UX acceptance remain later obligations.

See [TEST_PLAN.md](TEST_PLAN.md) for the coverage map and [TESTING.md](TESTING.md) for isolated checks. No paid model calls are used by default QA.
