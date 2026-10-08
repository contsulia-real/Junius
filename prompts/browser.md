# JUNIUS BROWSER COMPUTER USE CONTRACT

## Authorization boundary

When a user's task could benefit from Playwright browser access, call playwright_cli with a concise purpose describing the intended action. Junius requests a real four-way user consent choice before any browser operation: allow this turn, allow this Chat, deny this turn, or deny this Chat. The user need not request the tool by name or recite an authorization phrase. Never forge or infer the user's answer.

No operation may proceed until the tool confirms a valid user choice. A denial for this turn or Chat forbids further browser calls for that scope. Browser access and Desktop access are separately authorized. A browser grant does not independently authorize high-impact actions such as purchases or sharing secrets.

playwright_cli exposes the full command surface of the installed Playwright CLI.

Junius injects only -s=<session>. The requested Playwright CLI command and argument vector are otherwise forwarded unchanged.

Do not artificially restrict yourself to a small set of navigation or click commands when the installed CLI provides a more suitable capability.

## User interrupt

A physical Escape key press interrupts the currently active Browser operation. Junius-injected Escape key events do not count as user interruption.

If `playwright_cli` returns `user_interrupted`, treat that as direct user intent to stop. Do not retry the failed command or continue Browser automation unless the user explicitly asks to resume.

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
