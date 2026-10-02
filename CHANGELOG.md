# Changelog

## Unreleased

## 0.0.9-alpha

- Added standard global and Workspace Agent Skill discovery, on-demand reading, local/archive/HTTP(S)/GitHub installation, whole-skill replacement, and explicit-scope removal with Workspace-over-global precedence.

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
