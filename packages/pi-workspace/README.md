# Pi workspace visual tools

Internal V1 implementation for the Paseo fork. **Acceptance and installation readiness are pending.** This package extends the existing Pi conversation; it is not another agent or model router.

## Install the paired artifacts

Use the Pi-workspace tarball and the **fork protocol tarball from the same accepted candidate tree**. Upstream `@getpaseo/protocol@0.10.3` lacks the new runtime modules despite sharing the version number. See [PUBLISHING.md](PUBLISHING.md) for artifact hashes and the installed-pair test requirement. Do not install this package by resolving the protocol dependency from the upstream registry.

In an isolated development installation directory:

```sh
npm install --ignore-scripts --legacy-peer-deps ./paseo-protocol.tgz ./paseo-pi-workspace.tgz
pi -e ./node_modules/@getpaseo/pi-workspace/extensions/workspace.ts
```

Those tarball names stand for the exact reviewed artifacts. Pi supplies its SDK and TypeBox peer modules. A local checkout can load `extensions/workspace.ts` after workspace dependency installation and the existing protocol build. Git/npm distribution is not independently supported until the fork protocol receives a distinct published identity; do not substitute an upstream artifact.

Loading the package outside its compatible Paseo host registers the tools without starting a model or daemon. Calls return structured unavailable-host errors. The V1 task does not authorize installation into the active user session.

## Tools

All five tools are direct model-callable Pi tools. Results have matching `details` and `structuredContent` plus JSON text for the model. Failed operations set `isError` and return `error.code`/`error.message`; when available, `id` retains the artifact identity after a partial side effect.

| Tool             | Arguments                                                                         | Responsibility                                                        |
| ---------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `visual_present` | `{mode:"new",title,html}` or `{mode:"new",title,file}`; reopen `{mode:"open",id}` | Store/display one prepared document or reopen a saved one             |
| `visual_update`  | `{id,revision,html}` or `{id,revision,file}`                                      | Replace source against its observed source revision                   |
| `visual_act`     | `{id,action,value?}`                                                              | Invoke a declared, schema-validated document action                   |
| `visual_inspect` | `{id?,screenshot?}`                                                               | Read the current live state, selection, actions and delivery identity |
| `visual_list`    | `{cursor?}`                                                                       | List up to 50 stored artifacts in this conversation                   |

Exactly one HTML source is accepted. A file is a single explicitly named regular UTF-8 file, resolved relative to the actual Pi working directory. Symlinks and directories are refused. File and inline inputs share a 1 MiB UTF-8 bound; nothing is truncated. Tools do not scan directories, build projects, fetch assets, start per-document servers, run shell commands or invoke models.

Source and interaction revisions are separate. A local slider move is not a source edit. Stale updates, invalid actions, disconnected clients and failed restoration are explicit failures. Prior source and state files are retained for recovery. A `rendered` result requires a receipt from the bound app connection/document; storing a file alone is not a display receipt.

## Interactive documents

Prepared HTML can contain text, controls, SVG, Canvas and embedded assets. There is no prescribed explanation template. Instrumented content registers once before document readiness:

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
// After a local control changes its own state:
window.paseoVisual.publish();
```

Local controls update immediately without model requests. The next ordinary Pi request receives a separate `<pi-workspace-context>` observation marked as untrusted UI data. The original user message is unchanged. The envelope excludes the full HTML and transcript.

Actions use local JSON schemas; external schema resolution is not supported. Snapshots are bounded to 32 KiB and depth 16, with at most 64 declared actions. Uninstrumented static documents have empty state/action capability. A replacement unable to restore existing state fails rather than silently resetting it.

## UI and storage

The surface is part of the existing Paseo agent panel. It adds no tabs, routes, Pi commands, terminal widgets, shortcuts, microphone controls or voice agent. The ordinary composer and its draft owner remain in place.

One active app connection owns an agent's interactive surface. A competing connection receives `CLIENT_BUSY`. Reload/reconnect creates fresh connection/document identities and restores saved content/state; late receipts are refused. Errors appear in the surface with a reconnect action.

The daemon owns `${PASEO_HOME}/pi-workspace/`, keyed by a digest of the exact Paseo agent and Pi session. Each artifact has immutable source/state files and an atomically replaced current pointer. Historical files are retained, not silently evicted. Disk write errors propagate; storage capacity is not unlimited. The private Unix socket lives in a newly created mode-0700 runtime directory, with a mode-0600 socket. Its per-runtime capability is passed only through the Pi launch environment and is revoked with that runtime.

## Safety and V1 limits

Generated documents receive no capability token, filesystem access, Node API, Paseo client or unrestricted tool callback. Browser content uses an opaque-origin `allow-scripts` iframe and the existing preview CSP. The bridge is bound to the actual frame, document nonce, source revision and connection generation. UI observations remain untrusted data, not operator instructions.

V1 does **not** certify complete network/hang containment. Browser self-navigation and the existing native navigation-guard limits remain V2 work. All screenshot requests fail explicitly with `CAPTURE_UNSUPPORTED`; no headless or reconstructed image substitutes for client pixels. Native adapter source/typechecks are not physical-phone evidence. No production deployment, native capture, `speak`, branching tools, full voice, or whole-programme completion is claimed.

## Development

See [TESTING.md](TESTING.md) for exact isolated/offline commands and [TEST_PLAN.md](TEST_PLAN.md) for evidence mapping. Default QA includes strict source/test typechecking, a type-escape audit, logic tests, real SDK/RPC scripted-provider tests, installed paired-artifact tests and targeted host/controller tests. The separate judge-owned browser oracle is mandatory for the connected loop. No paid model calls are used by these tests.
