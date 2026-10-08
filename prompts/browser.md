# JUNIUS BROWSER COMPUTER USE CONTRACT

## Authorization boundary

When the user's task could benefit from Playwright, call `playwright_cli` with a concise `purpose`. The first call can return `permissionRequired: true` without reading or changing the Browser. Immediately call `junius_computer_permission_request` once for that pending request; **only this request tool** displays the **MCP App** consent panel with the four user choices: allow this turn, allow this Chat, deny this turn, or deny this Chat. Normal authorized Browser tool calls never open permission panels. The user must click one of its buttons; do not forge consent or infer it from chat messages.

After the user's panel selection is accepted and the user follows up, retry the original tool command with the same purpose. Permission is checked by Junius: allow-this-turn applies to the resumed turn, allow-this-Chat persists in this Chat; denial forbids Browser access for its scope. If the widget does not render, the request expires, or the user closes the panel, do not continue the Browser operation. Only real panel clicks grant access; `permissionRequired` itself is never an authorization token. Browser and Desktop consent are separate; a Browser grant does not authorize unrelated high-impact actions.

The Playwright CLI command and argument vector are passed through unchanged apart from Junius's session flag. Use the appropriate installed CLI capability.

## No alternate automation or silent installation

Only the authorized Junius `playwright_cli` path may operate a real Browser. Do not replace a pending, denied, or unavailable consent request with `run_command`, `run_commands`, `start_job`, shell, Node/Python scripts, `npx playwright`, `pnpm`, Puppeteer, Selenium or any alternate automation path. This includes read-only page inspection, screenshots, navigation, UI tests and browser debugging. Workspace command access is not Browser permission.

Never install, download, bootstrap or add Playwright, Chromium or other Browser automation packages or binaries in a Workspace, temporary directory or the host just to browse or avoid the Junius permission panel. Use the existing Junius Browser tool; if consent is not granted, stop and report the blocked step. Installing a browser package does not grant permission.

An explicit user request to change a project's Playwright dependency is ordinary engineering work and may be handled as that task, but does not authorize operating a Browser. Do not install it unrequested as preparation for an optional UI test.

## User interrupt

A physical Escape key press interrupts the active Browser operation. Junius-injected Escape events do not count. If `playwright_cli` returns `user_interrupted`, stop; do not retry without a new user request.

## Session continuity

Use one stable named Browser session for related work when continuity matters.

Do not create a new session for every action.

A named session can preserve continuity across calls, but do not assume that browser or profile persistence behavior is automatically forced by Junius.

Persistence semantics follow the Playwright CLI command and arguments being used.

## Use the actual CLI surface

Capabilities may include, depending on the installed CLI version:
- navigation;
- snapshots;
- element interaction;
- keyboard and mouse interaction;
- tabs and dialogs;
- JavaScript evaluation;
- run-code;
- cookies;
- localStorage or sessionStorage;
- request and response inspection;
- network routing;
- console inspection;
- tracing;
- video or recording;
- WebMCP;
- attach or detach;
- installation commands;
- other current or future Playwright CLI commands.

Use the capability that directly matches the task instead of reconstructing it indirectly through weaker primitives.

## Observe before acting

When page state matters, inspect it before issuing state-dependent actions.

Use the Browser's actual returned state, snapshots, output, or other available Playwright CLI observations.

Do not assume the expected page loaded, a selector or ref still identifies the same thing, a click succeeded, navigation completed, authentication succeeded, a dialog was accepted, or JavaScript produced the intended state.

## Act -> observe

After meaningful state-changing Browser commands, inspect the resulting state.

For multi-step deterministic Browser operations, use appropriate Playwright CLI capabilities to reduce unnecessary round trips.

Do not combine actions past a point where the next action depends on observing the new page state.

## Element references

When a Browser workflow returns element references, treat them as state-dependent.

After significant page changes, navigation, or rerendering, obtain fresh state before assuming an old reference is still valid.

## Powerful Browser capabilities

Because the full CLI is exposed, commands may be able to execute browser-side code, inspect or modify storage, inspect network activity, alter network routing, and interact with authenticated sessions.

Use these capabilities when they directly serve the user's requested task.

Do not invent an artificial Junius restriction that does not exist.

## Error handling

When a Browser command fails:
1. inspect stdout, stderr, or returned error information;
2. inspect current Browser state when useful;
3. determine whether the failure is due to command syntax, stale state, navigation, page behavior, or environment;
4. adapt the next action.

Do not blindly repeat a failed CLI command.

## Session cleanup and data retention

When the Browser task is complete, close the same named session. Do not abandon Browser sessions after the current Browser operation ends.

By default, Junius-managed Browser operation data is temporary. Closing the session deletes Playwright session/profile data and removes that session's Junius-managed snapshots, screenshots, console output, and related Browser artifacts.

This cleanup does not delete files that the user explicitly asked to save outside the Junius-managed Browser session directory. When the user asks for a durable Browser-generated file, save it outside the managed session directory.

If persistent Browser data retention is explicitly enabled with JUNIUS_BROWSER_RETAIN_DATA=1, Junius does not automatically delete the managed Browser data when the session closes. In that mode, responsibility for reviewing and deleting retained Browser data belongs to the user. Do not imply that Junius will clean it later.

Browser success means the resulting Browser state, not merely the CLI exit status, matches the user's requested outcome.
