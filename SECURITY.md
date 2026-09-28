# Security Policy

Junius gives ChatGPT controlled access to capabilities on the machine where
Junius is running. Security reports are therefore treated as high priority.

## Supported versions

Until Junius reaches 1.0, only the current `main` branch is supported for
security fixes.

## Reporting a vulnerability

Prefer GitHub Private Vulnerability Reporting for this repository when it is
available.

If private reporting is unavailable, open a public issue containing only a
request for a private reporting channel. Do **not** include exploit details,
tokens, local paths, screenshots containing secrets, or reproduction steps
that would expose users before a fix is available.

Please include, privately:

- the affected commit or version;
- operating system and relevant runtime versions;
- which Junius capability is involved;
- the expected security boundary;
- reproduction steps or a minimal proof of concept;
- the impact you observed.

## Security boundary

Junius is not an operating-system sandbox.

An executable that is authorized through a Workspace runs with the permissions
of the operating-system user that started Junius. Workspace grants and machine
capability policies constrain what Junius itself will launch; they do not
isolate an already-authorized executable from the filesystem, network,
registry, desktop, credentials, or other resources available to that user.

The local MCP and management services bind to loopback interfaces. Processes
already running as the same local user are therefore inside the local trust
boundary. The management WebUI is not intended to be exposed to a LAN or the
public Internet.

Browser and Desktop capabilities can act on user-visible applications and may
interact with authenticated sessions. Desktop clipboard access can also read or
replace Unicode text currently held by the user's Windows clipboard. Treat
enabling those capabilities as granting ChatGPT the corresponding local
interaction ability.

For additional implementation details, see the Security boundary section in
the README and `docs/architecture.md`.
