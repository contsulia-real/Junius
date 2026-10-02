# Security Policy

Junius gives ChatGPT direct execution access to the machine where Junius is running. Security reports are therefore treated as high priority.

## Supported versions

Until Junius reaches 1.0, only the current main branch is supported for security fixes.

## Reporting a vulnerability

Prefer GitHub Private Vulnerability Reporting for this repository when it is available.

If private reporting is unavailable, open a public issue containing only a request for a private reporting channel. Do not include exploit details, tokens, local paths, screenshots containing secrets, or reproduction steps that would expose users before a fix is available.

Please include privately:

- the affected commit or version;
- operating system and relevant runtime versions;
- the affected Junius tool or subsystem;
- the expected security boundary;
- reproduction steps or a minimal proof of concept;
- the observed impact.

## Security boundary

Junius is an execution service, not a command-policy engine, and it is not an operating-system sandbox.

Its MCP Core, Engineering, Desktop, and Browser contracts are assistant instructions, not authorization gates. Core is sent through MCP server instructions and specialized contracts are loaded on demand with load_junius_contracts. They do not reduce the underlying command, Browser, or Desktop execution surface.

### Arbitrary process execution

run_command and start_job accept an executable and argument vector without a Junius executable allowlist or argument-authorization layer.

The launched process runs with the permissions of the operating-system user that started Junius.

Selecting a Workspace sets the process working directory. It does not confine that process to the Workspace filesystem or prevent it from using network, registry, credentials, environment variables, desktop resources, or other resources available to that user.

The caller and user are responsible for deciding whether an operation should be executed.

### Built-in file tools

The built-in Workspace file tools have their own path-containment implementation. They reject traversal and protected control paths and perform link/canonicalization checks.

When scoped AGENTS.md files apply, built-in mutations also require a digest acknowledgement of the current applicable instruction chain before changing files. This is an agent-instruction preflight, not an operating-system security boundary or a natural-language policy evaluator.

Those checks apply only to the built-in file tools. They are not a sandbox for processes launched through command or Job execution.

### Local Agent Skills

`list_skills` and `read_skill` discover standard Agent Skills from `%USERPROFILE%\.agents\skills` and registered Workspace `.agents\skills` directories. Workspace skills override same-name global skills for effective resolution but do not modify the global copy.

`install_skill` can write outside a Workspace when the user explicitly selects global scope. It may also fetch HTTP(S) or GitHub sources, so it is an open-world network operation. Downloaded archives are size-bounded, checked for traversal paths before extraction, validated as skill trees, staged, and then moved into the selected skill root. Installing a skill does not execute scripts contained by the skill.

Workspace-scoped skill installation and removal require the applicable AGENTS.md digest before mutation. Global skill operations use the dedicated `%USERPROFILE%\.agents\skills` boundary rather than weakening Workspace file containment.

### Network surfaces

The Host uses one HTTP listener bound to loopback. It serves the MCP endpoint and local /__junius/* diagnostics on the same port.

Only the exact /mcp endpoint is intended to be forwarded through OpenAI Secure MCP Tunnel. Configure tunnel-client with http://127.0.0.1:8787/mcp, not the bare 8787 origin. The co-located /__junius/* routes are local diagnostics only and should not be exposed.

The Junius installer does not request or persist OpenAI tunnel IDs, runtime API keys, or ChatGPT workspace credentials. Secure MCP Tunnel and ChatGPT developer-mode configuration are separate user-managed OpenAI account/workspace setup steps.

Public Junius installation uses GitHub Release assets. The PowerShell bootstrap verifies the SHA-256 of `junius-windows.tgz` against the release's `SHA256SUMS.txt` before extracting or executing the package. npm is used only after verification to materialize the dependency tree described by the packaged install lock; the npm registry is not the Junius distribution channel.

Workers use random loopback ports and require a private Host-injected token for MCP, health, and configuration-reload traffic.

### Browser and Desktop

Browser automation exposes the full installed Playwright CLI command surface and can interact with authenticated browser sessions, execute Playwright/browser code exposed by that CLI, inspect or modify browser storage, and inspect or route network activity.

Desktop Computer Use is screenshot-only perception and can view and operate user-visible applications through coordinate input, drag, mixed action batches, keyboard/text input, and clipboard access. Desktop clipboard access can read or replace Unicode text currently held by the user's Windows clipboard.

During an active Desktop control scope Junius displays a top-center disclosure plus a breathing edge effect so the local user can see that ChatGPT is controlling the desktop.

### Audit

Audit is observational and best-effort. It intentionally avoids persisting raw arbitrary command arguments, stdout/stderr contents, file contents/edit text, screenshots, typed Browser/Desktop text, and clipboard text.

For implementation details, see README.md and docs/architecture.md.
