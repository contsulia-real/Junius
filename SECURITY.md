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

### Arbitrary process execution

run_command and start_job accept an executable and argument vector without a Junius executable allowlist or argument-authorization layer.

The launched process runs with the permissions of the operating-system user that started Junius.

Selecting a Workspace sets the process working directory. It does not confine that process to the Workspace filesystem or prevent it from using network, registry, credentials, environment variables, desktop resources, or other resources available to that user.

The caller and user are responsible for deciding whether an operation should be executed.

### Built-in file tools

The built-in Workspace file tools have their own path-containment implementation. They reject traversal and protected control paths and perform link/canonicalization checks.

Those checks apply only to the built-in file tools. They are not a sandbox for processes launched through command or Job execution.

### Network surfaces

The public MCP listener and Host-control listener bind to loopback.

Only the MCP endpoint is intended to be exposed through the supported ChatGPT tunnel path. The Host-control endpoint is local diagnostics only.

Workers use random loopback ports and require a private Host-injected token for MCP, health, and configuration-reload traffic.

### Browser and Desktop

Browser automation can interact with authenticated browser sessions.

Desktop Computer Use can view and operate user-visible applications. Desktop clipboard access can read or replace Unicode text currently held by the user's Windows clipboard.

During an active Desktop control scope Junius displays a top-center disclosure plus a breathing edge effect so the local user can see that ChatGPT is controlling the desktop.

### Audit

Audit is observational and best-effort. It intentionally avoids persisting raw arbitrary command arguments, stdout/stderr contents, file contents/edit text, screenshots, typed Browser/Desktop text, and clipboard text.

For implementation details, see README.md and docs/architecture.md.
