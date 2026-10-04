# Paired internal artifacts

Status: implementation in progress. No release, installation into a production Pi session, or native-platform readiness is claimed.

This package requires the **Paseo fork's protocol artifact from the same accepted candidate tree**. The new runtime imports are `@getpaseo/protocol/pi-workspace/contracts`. Upstream `@getpaseo/protocol@0.10.3` does not contain those modules. The version string alone is not compatibility evidence.

## Artifact boundary

The Pi package ships `extensions/` and its runtime `src/` files. It must not import server sources, judge fixtures, test helpers, absolute development paths, or files outside its installed dependencies. Pi supplies its SDK, Pi AI and TypeBox as peers. Development dependencies pin SDK 1.0.0 and TypeBox 1.3.27; they are not bundled into the runtime package.

The package pins its Zod runtime to 4.4.3, the version used by the fork build. A caret range made a clean offline artifact install select an untested newer tarball; the installed-pair test now also verifies Zod resolution from both artifacts.

Protocol is a declared runtime dependency. Its compiled `dist/pi-workspace/contracts.js` and declaration file, plus every transitive protocol runtime import, must be present in the paired protocol tarball. Build and pack that artifact from the accepted fork, not the npm registry's same-numbered upstream release.

## Required release evidence

1. Obtain the V1 Accepted certificate and supervisor audit before Land; no manual copying into the original checkout.
2. Record the accepted candidate tree and SHA-256 of both the protocol tarball and Pi-workspace tarball in the release receipt.
3. Build protocol with its existing build script, then pack both artifacts. Package tests must verify contents and install the pair into an isolated directory, without workspace symlinks or undeclared source imports.
4. Install both exact tarballs in the same isolated npm operation with scripts disabled and peer auto-installation disabled. Validate the installed protocol leaf and load the installed extension through real Pi. A workspace-source load is not this packaging witness.
5. Run deterministic source, SDK, RPC, type-safety and host tests plus the independent connected browser oracle. Do not publish until they pass.
6. Distribute the pair as identified internal artifacts. Do not publish this Pi package with instructions that resolve its protocol dependency from the upstream registry. An independently published release needs a distinct fork protocol identity/version and a separately reviewed packaging change.

The V1 planning authority does not authorize installation into the user's active setup. V2 platform containment/capture and native delivery, S1 voice, B1 detours, actual-device checks and joint UX acceptance remain separate obligations.
