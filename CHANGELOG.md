# Changelog

## Unreleased

## 0.0.5-alpha

- Persistent user prompt overrides now live outside the installed application directory and survive Junius updates; legacy `app\prompts` files are preserved into the override layer before the first replacing update.
- Added MCP tools for reading, changing, and resetting Junius prompts directly from chat.
- Source-test validation failures now expose the captured test output instead of only a generic wrapper error.
- GitHub Release notes are now sourced only from the matching version section in this changelog.
- Installed releases are presented simply as Junius; source-test terminology is limited to source development.
- Junius version identifiers no longer include a ChatGPT suffix.
