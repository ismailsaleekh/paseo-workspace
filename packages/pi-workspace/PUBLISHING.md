# Paired internal artifacts

Status: V2-D candidate, not a production release. No installation into the active Pi/Paseo setup or Android readiness is authorized by this document.

## Artifact identity

Ship the Pi-workspace package with the **fork protocol artifact from the same accepted candidate tree**, and use the desktop/app/daemon implementation from that paired fork. Upstream `@getpaseo/protocol@0.10.3` lacks these feature modules despite sharing the version string. A version number alone is not compatibility evidence.

The Pi package ships `extensions/` and runtime `src/` files. Runtime imports must not reach server source, judge files, test helpers, absolute development paths or undeclared dependencies. Pi supplies SDK, Pi AI and TypeBox peers. Development pins SDK 1.0.0 and TypeBox 1.3.27; runtime Zod remains pinned to 4.4.3. Do not change dependency resolutions as an incidental part of this unit.

The fork protocol tarball must include compiled `dist/pi-workspace/contracts.js`, declarations and all transitive runtime imports. Desktop additionally needs its compiled guest preload and Electron-flavored app bundle. Browser-only package loading is not desktop delivery evidence.

## Required evidence

1. Obtain the V2-D Accepted certificate and supervisor audit of candidate tree, exact diff, protected files and scope. V1 acceptance is not V2 acceptance. Stop at Accepted until the supervisor authorizes Land.
2. Record the accepted candidate tree and SHA-256 of both tarballs in the release receipt. Build/pack from that tree, not from upstream registry artifacts.
3. Verify paired contents and install both exact tarballs into one isolated directory with lifecycle scripts and peer auto-installation disabled. Require no workspace symlinks or undeclared source imports.
4. Execute the installed extension through real Pi, using isolated state and the deterministic provider. A checkout-source load is not this witness.
5. Require strict typecheck, type-escape audit, unit/SDK/RPC/package/host tests, scoped format/lint, dry pack and the independent V2-D Root, including V1 preservation and actual Electron pixels/containment/lifecycle.
6. Distribute only identified paired internal artifacts. An independently published package needs a distinct fork protocol identity/version and a separately reviewed packaging change.

Use the private task cache for offline packaging tests. Never repair the global npm cache or silently substitute an online dependency.

## Deployment boundary

The desktop certificate covers the isolated checkout runtime tested by the judge. Packaged deployment, reversible installation, existing-profile coexistence and joint operator try-out remain separate checks. Do not replace the installed Paseo app or restart the production daemon as part of certification.

V2-A still requires native Android containment/capture, emulator acceptance and physical HyperOS 3 / Android 16 evidence. S1 speech and B1 native Pi detours remain required. None is closed by desktop pixels, browser screenshots, module compilation or a package manifest.
