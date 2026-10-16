# Workspace stable upgrade

This branch integrates official **Paseo v0.11.4** (`dc5b02f7`) into the custom Workspace release (`7789ec8`). It is not the upstream 0.12 beta and must not be published under an official Paseo release tag.

## Preserved behavior

- Pi remains the installed CLI, with its native sessions and models. Stable's MCP/provider-option improvements coexist with the Workspace visual and background-task attachments.
- Drawings, committed drawing history, fullscreen interaction and native conversation detours remain available.
- Michael/Adam speech keeps its device selection, app-wide playback ownership, Stop behavior and Android background playback.
- Assistant videos retain original bytes and the existing native/browser players. The 0.12 Markdown rewrite is excluded.
- Accounts remain in host Settings and command search. The fixed upstream Usage footer icon is omitted; its optional summary stays off by default. No preference files are rewritten.
- Account login storage and reset semantics remain as described in [Subscription accounts](subscription-accounts.md). Upstream usage discovery does not replace those controls or interpret current Pi/ChatGPT-sharing tokens as legacy Codex tokens.

## Integration boundaries

Stable moved audio-engine ownership from `voice/` to `audio/`; Workspace speech consumes that existing owner. Stable's provider wrapper must forward the Workspace history-replacement callback as well as its own usage-session reference.

Stable removed the old quota-fetcher framework and provider-usage card. Accounts use the current usage-window component. The account-specific Claude reader takes only the account owner's supplied credential; it cannot discover or fall back to a different CLI login. It preserves unknown values, model/surface scopes and provider rate-limit backoff. This differs from the read-only usage plugins, whose input is a harness-owned login location.

The custom Pi extension's protocol dependency follows 0.11.4. This is not an upgrade or replacement of the user's installed Pi engine.

## Selected upstream fixes

After the stable merge, backport only these reviewed changes:

| Upstream PR                                          | Reason                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| [#6847](https://github.com/getpaseo/paseo/pull/6847) | Bound generated validator functions to avoid V8 compiler-memory spikes    |
| [#7074](https://github.com/getpaseo/paseo/pull/7074) | Open cached chats while unrelated agents stream, preserving durable reads |
| [#6741](https://github.com/getpaseo/paseo/pull/6741) | Persist Pi's effective thinking level when an extension changes it        |
| [#6285](https://github.com/getpaseo/paseo/pull/6285) | Reject oversized messages without disconnect/retry loops                  |
| [#6595](https://github.com/getpaseo/paseo/pull/6595) | Download through the connected relay/SSH session, checking complete bytes |

The in-memory download limit in #6595 applies to ordinary session downloads, not Workspace's disk-streamed video cache. Both paths must validate the announced byte count.

Use focused protocol, cache, Pi, account, transfer, speech, video and drawing checks before packaging. A successful source merge is not installation or live OAuth validation. Keep Mac/Redmi installation coordinated with the operator; never restart active sessions to validate this branch.
