# Testing the visual core

Status: tests are being implemented and executed under the V1 planc unit. A command listed here is not a passing receipt. The independent Accepted certificate, not this document, decides V1 acceptance.

## Prerequisites

- Paired Paseo fork checkout with the protocol leaf modules, Node 24, npm, Pi SDK 1.0.0 and TypeBox 1.3.27.
- Warm offline npm cache for the complete lockfile, including standalone Pi AI's dependencies. Missing metadata must fail explicitly; do not change SDK versions or silently fall back online.
- Root dependencies installed with lifecycle scripts disabled, then the reviewed upstream patch step.
- For the independent browser check: its explicitly selected installed Google Chrome. It does not certify Electron or a physical phone.

Run commands only in the acquired implementation workspace or an isolated judge workspace. Do not restart or connect tests to production daemon 6767. Do not use the real user's Pi agent directory, auth, settings or sessions.

## Commands

`CACHE` below means the explicitly task-owned, pre-warmed npm cache, supplied by the operator/supervisor. Do not use a default global cache or repair its permissions.

```sh
npm install --workspace=@getpaseo/pi-workspace --offline --ignore-scripts --no-audit --no-fund --cache "$CACHE"
npm run build:server
npm run build:app-deps
npm run typecheck --workspace=@getpaseo/app
npm --cache "$CACHE" --offline --prefix packages/pi-workspace test
npm --cache "$CACHE" --offline --prefix packages/pi-workspace run pack:dry-run
```

The package is loaded as TypeScript by Pi, not emitted as Node ESM. Its no-emit typecheck uses ESNext/Bundler resolution with JSON-module support: Pi 1.0.0's bundled catalog declarations import JSON without NodeNext import attributes. All required strict options remain enabled and `skipLibCheck` stays false; SDK declarations are still checked. Real SDK/RPC and installed-artifact tests independently verify runtime resolution.

The package default QA runs strict typecheck, the AST-based type-safety audit, source/tool tests, real Pi SDK and RPC tests, package tests, and the four targeted host/controller suites. It does not run the whole monorepo suite. Tests are also individually selectable through `test:unit`, `test:sdk`, `test:rpc`, `test:package`, and `test:host`. For a single host file, use the repository's targeted Vitest command with `--bail=1`.

Use the existing root `format:files`, `format:check:files` and `lint` scripts with the exact changed paths. Never weaken shared build/check scripts or edit existing tests to obtain a pass.

The independent Root command is:

```sh
node qa/pi-workspace/judge-visual.mjs
```

It owns locked/offline preparation, prerequisite guards, five-tool registration mode, package QA/packing, and the real Pi→daemon→browser loop. It is read-only judge input. A successful local run is not a submit certificate.

## Isolation and diagnostics

`tests/helpers/pi-harness.ts` creates a temporary HOME, agent directory and project. Only PATH and small locale/temporary-directory values are inherited. `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1` and `CI=1` are set; attachment capabilities and provider credentials are not inherited. The deterministic provider writes requests only to the test-owned trace path. It never makes a network model request.

RPC tests use Pi's exported RPC client and wait for `agent_settled`, not prompt acceptance or `agent_end`. They exercise all five tools and Unicode JSONL content. Socket tests use the actual feature bridge/client with controlled host ports, not a fake WebSocket daemon. Browser evidence comes from the independent actual app/daemon oracle.

Package tests pack the fork protocol and Pi package into a temporary artifact directory, install both tarballs into another empty directory with scripts/peer auto-installation disabled, check exact compiled/source hashes and absence of workspace links, then load and execute the installed extension through real Pi. The test does not accept the upstream same-numbered protocol version as equivalent.

Temporary test homes and tarballs are removed in `finally` blocks. Failure messages include child stdout/stderr and exact command details; no timing normalization or output truncation is used to turn a failure into success. Supervisor-bound diagnostic probes may separately preserve complete command logs outside the repository.

## Remaining boundaries

No TUI component/PTY suite is required: this package has no terminal UI or shortcuts. Its UI is the Paseo app, whose real browser test is mandatory. No known flake is waived. Native capture, full containment and physical-device delivery remain V2, not skipped V1 test successes. SDK/package default QA must be green before V1 submission; pending or unexecuted tests are not acceptance evidence.
