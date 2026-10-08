# Changelog

## Unreleased

## 0.1.9-alpha

- Removed Junius-specific Browser/Desktop four-way authorization dialogs, policy state, and redundant service authorization flags; preserve Chat-scoped sessions, Desktop control lifecycle, and Escape interruption.

- Show Browser/Desktop four-choice consent UI only for genuinely pending requests, not after every authorized tool call; use nonce-bound widget actions to preserve Chat-scoped permission when app session metadata is unavailable.

- Restored local Junius observability history across Host/Worker restarts with actual user turn titles and bounded tool-call inputs/events instead of `[private input omitted]`; retained existing seven-day/256-session pruning and session isolation.
- Replaced unavailable MCP elicitation-based Browser and Desktop authorization with a user-clicked MCP App consent panel, preserving independent four-way turn/Chat permissions and denying device access until approval.
- Aligned the shipped Core, Browser, Desktop, and Engineering contracts with the actual consent flow and prohibited using Workspace commands or silently installed Playwright/Chromium as a Browser authorization workaround.
- Removed unintended automatic prompt rewriting and backup-file creation while preserving the user's existing prompt files and normal prompt-read behavior.
- Added an enforced per-turn task-review checkpoint before consequential Junius tool calls. Read-only inspection and emergency cancellation remain available; task review does not grant Browser/Desktop consent or prove design correctness.

## 0.1.8-alpha

- Fixed Windows installation so the packaged `junius` CLI is exposed through a stable per-user command shim and `PATH` entry, while the one-command PowerShell bootstrap also updates its current session for immediate CLI use.
- Added informed four-way consent before Playwright or Windows Computer Use access, with turn/Chat-scoped allow or deny choices, session isolation, Escape revocation, and control cleanup. The client must actually accept the request; model-only authorization assertions no longer grant access.
- Prevented persistent MCP observability from storing raw user turn titles and tool arguments; existing records are scrubbed at startup and local history is bounded to seven days and 256 sessions.

## 0.1.7-alpha

- Optimized both MCP traffic shapes: bursty short work now uses larger bounded batches plus HTTP keep-alive, while long-running process work uses shorter foreground limits, detached Jobs, bounded polling, and combined incremental output cursors to avoid holding one Secure MCP Tunnel request open for the full task.

- Added MCP request lifecycle diagnostics that distinguish completed responses from client/request disconnects and Worker/Host failures, correlate each request with local Secure MCP Tunnel health and delivery-failure counters, and expose the bounded timelines through the local supervisor diagnostic.

## 0.1.6-alpha

- Localized the Junius observability UI, turn fallback text, and Desktop control disclosure while keeping the ChatGPT sidebar entry name simply `Junius`; ChatGPT locale is used when available and Windows UI language drives the native Desktop disclosure.
- Kept a single `rg` Workspace tool while adding backend fallback: ripgrep first, then `pwsh`, then `cmd` on Windows, preserving Workspace path protections across all backends.

## 0.1.5-alpha

- Fixed observability on modern ChatGPT MCP calls, which do not carry `Mcp-Session-Id`. Junius now prefers the transport session when present and otherwise uses ChatGPT's documented `openai/session` conversation id, so turn begin/end, tool monitoring, Skill usage, and the panel work on both protocol eras.

## 0.1.4-alpha

- Added MCP-session-scoped persistent observability and Skill-use monitoring. Turn/tool/Skill history now follows real MCP session creation, use, and deletion; successful `read_skill` calls appear as Skill usage in Tools and Logs; each Junius turn now discovers installed Skills before substantive task tools.

## 0.1.3-alpha

- Hardened Junius turn lifecycle tracking: ordinary tools are now refused until `junius_turn_begin` succeeds, fallback turns are no longer created for missing boundaries, ordinary tool results remind ChatGPT to call `junius_turn_end`, and a new begin still closes an unfinished prior turn as recovery.

## 0.1.2-alpha

- Reworked the ChatGPT observability panel around Junius-owned turns. Tools and Logs now use turn accordions; turn titles come from the user prompt with literal `[File]` placeholders, tool calls are grouped by tool with per-call input differences, and the Logs tab shows the ordered tool-call event timeline for each turn.

## 0.1.1-alpha

- Removed the Junius test-window authorization gate. The ChatGPT thread panel can now be opened directly by the user or from chat, while chat-driven close requests remain session-scoped one-shot signals.

## 0.1.0-alpha

- Added a native ChatGPT conversation-side Junius observability panel with Tools and Logs tabs. It lists model-visible Junius tools, records per-conversation tool activity, groups counts by explicit ChatGPT turn identifiers when provided, and shows the existing structured Audit log without persisting arbitrary tool metadata values.
- The Junius test window now starts closed for every ChatGPT conversation and can be opened or closed only through explicit user chat requests. Direct or unauthorized panel mounts immediately request closure, and ordinary Junius tool activity never changes the window state.

## 0.0.12-alpha

- Installed Junius now runs detached from the invoking terminal with no visible process windows in normal operation; the source-test instance remains foreground.

## 0.0.11-alpha

- Installed Junius now hides console windows across the normal launcher, bootstrap, Host, and Worker process chain while preserving foreground output for the source-test instance.
- Compiled-release upgrades now invalidate incompatible legacy source-runtime bootstrap state while preserving compatible compiled last-known-good runtime state.

## 0.0.10-alpha

- GitHub Releases now package the compiled JavaScript application directly: installed Junius no longer ships TypeScript sources, source tests, tsx/TypeScript development dependencies, or source-build configuration, and Host/Worker no longer keep esbuild services resident.
- Added `junius restart` to restart the installed Host and wait for the replacement Host to become healthy.

## 0.0.9-alpha

- Added standard global and Workspace Agent Skill discovery, on-demand reading, local/archive/HTTP(S)/GitHub installation, whole-skill replacement, and explicit-scope removal with Workspace-over-global precedence.
- Skill file reads canonicalize junctioned Windows paths before containment checks, preserving escape protection while supporting canonicalized CI and Workspace roots.
- Windows Job guardian payload handoff now publishes complete JSON atomically after the bootstrap process is assigned to its Job, eliminating partial-payload startup races.

## 0.0.8-alpha

- Workspace editing now uses working-tree-style write/patch/delete/move/copy/mkdir tools; unified patches support delete and rename without a fixed file-count limit, while workspace_mutate provides explicit all-or-nothing batches when required.

## 0.0.7-alpha

- Release validation now runs the Escape interrupt helper self-test with the Python interpreter provided by the CI environment when a project-local virtual environment is not present.

## 0.0.6-alpha

- Physical Escape now interrupts active Desktop and Playwright computer-use operations without treating Junius-injected Escape key events as user cancellation.

## 0.0.5-alpha

- Persistent user prompt overrides now live outside the installed application directory and survive Junius updates; legacy `app\prompts` files are preserved into the override layer before the first replacing update.
- Added MCP tools for reading, changing, and resetting Junius prompts directly from chat.
- Source-test validation failures now expose the captured test output instead of only a generic wrapper error.
- GitHub Release notes are now sourced only from the matching version section in this changelog.
- Release verification now resolves the newly created draft by its exact tag instead of scanning the release list.
- Installation now starts the freshly installed Host directly with the selected Node executable; the PowerShell wrapper is reserved for Windows logon startup.
- Installed releases are presented simply as Junius; source-test terminology is limited to source development.
- Junius version identifiers no longer include a ChatGPT suffix.
