# Subscription accounts

Open **Settings → your Mac → Accounts & usage**, or search **Accounts & usage** in the desktop command palette. Account controls do not appear in the chat toolbar or sidebar.

## Which login changes

The active account is Pi's normal saved login on that Mac. Terminal Pi shares it. Standalone Claude Code and Codex CLI logins are separate.

A switch affects subsequent requests. Requests already in progress finish normally. Switching does not restart agents, change their model, replace Pi's runtime, or rewrite conversations.

If an existing Pi login is not yet saved in Paseo, choose **Save current Pi login** before switching. That explicit action preserves it without guessing which named account owns it. Imported OpenAI logins may lack verified profile details: Pi retains the client registration but does not retain the ID token after a native refresh. Those logins can remain active or be saved for switching back; add a verified sign-in before connecting account-specific Codex controls.

API-key environment variables, credential headers in `models.json`, or `--api-key` overrides can bypass the normal subscription login. Account activation and active logout refuse the known overrides rather than falling through to paid-key access. This page does not control independently supplied terminal flags, arbitrary extensions, or unrelated custom provider homes.

## Credential ownership

Active credentials stay under Pi's normal provider keys. Inactive credentials occupy `paseo.subscription.<account-id>` slots in the same protected auth file. Those slots are storage entries, not registered model providers. A switch moves the latest credential between slots under Pi's own auth-file lock. Native Pi refreshes and account operations therefore cannot independently rotate stale copies of one refresh token.

Paseo's `subscription-accounts/state.json` contains account labels, verified identity/registration metadata and reset receipts, not copies of Pi access/refresh tokens. Codex controls own a separate private Codex profile; their renewable credentials are not interchangeable with Pi's credentials.

Pi 1.x file-storage APIs are checked when loading the installed package. The daemon imports only the file backend; it does not embed or replace the agent runtime. Ordinary Pi continues to launch through the existing provider implementation. The local integration test is pinned to the installed Pi binary with `PASEO_TEST_PI_BIN` so npm's development dependency cannot silently substitute another CLI.

## OpenAI connections and usage

Pi access uses Sign in with ChatGPT. Codex usage and banked-reset controls use the official Codex account-control authorization. Connecting both may require two one-time authorizations. Confirm their account/workspace association; an email address alone is insufficient.

An issued OpenAI client ID remains bound to its registration's workspace. Multiple registrations can have the same email and verified subject. Keep their labels and client IDs separate; reuse the selected registration on reauthorization.

Codex limits and Pi's ChatGPT-sharing allowance are different scopes. The page labels Codex counters and links to ChatGPT Settings for the sharing allowance when no supported exact-allowance API is available. An unavailable value is not zero. Old values retain their timestamp and an error until refreshed.

Usage reads never start a model turn or activate an inactive account. Reading the page can renew saved OAuth sessions without inference. Provider revocation or extended offline periods may still require sign-in.

## Sign-out and resets

Sign-out affects the requested account only. An active sign-out clears the shared Pi login, including terminal Pi. The result states whether remote revocation was confirmed or only local sign-out completed.

Banked Codex resets require confirmation for the specific account/workspace. A durable account-bound attempt ID is recorded before dispatch. If a reply is lost, use **Reconcile this reset attempt**; it reuses the original ID rather than starting another spend. Reset credits are not purchased credits, and redemption is never automatic.

## Privacy and validation

Account reads and actions both require `daemon.manage`; snapshots can contain login challenges. Authorization replies belong in the dedicated Settings form, not an agent chat. Renewable tokens stay on the Mac and are excluded from client snapshots and normal logs.

Tests are collocated under `packages/server/src/server/subscription-accounts/` and `packages/app/src/subscription-accounts/`, with wire/permission cases in the existing client and authorization suites. They use temporary homes and fake credentials. Do not use live sign-ins or consume a real reset as an unattended test.
