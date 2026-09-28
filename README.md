# Junius

**Local computer control for ChatGPT over MCP.**

Junius is a local MCP execution service designed for ChatGPT chat. It gives the calling assistant direct access to local Workspace files, local processes, background Jobs, browser automation, and Windows desktop interaction.

> **Junius is an execution service, not a policy engine.**
>
> Decisions about whether an operation is appropriate, destructive, or intended belong to the user and the calling assistant. Junius does not maintain a second command-authorization system.

Junius is **not an operating-system sandbox**. Processes launched by Junius run with the permissions of the operating-system user that started Junius.

## MCP surface

    list_workspaces()
    create_workspace(id, root_path)
    delete_workspace(id)

    ls(workspace, ...)
    read(workspace, ...)
    write(workspace, ...)
    workspace_apply(workspace, files, verify)
    rg(workspace, ...)
    workspace_batch(workspace, operations)

    run_command(workspace, executable, args)

    start_job(workspace, executable, args)
    get_job(job)
    wait_job(job, timeout_ms)
    read_job_output(job, stream, offset, limit)
    cancel_job(job)

    playwright_cli(session, command, args)

    desktop(session, command, ...)

There is no management Web UI. Workspace creation, removal, inspection, command execution, Jobs, Browser control, and Desktop control are intended to be driven through ChatGPT conversation.

## Requirements

Core requirements:

- Windows, macOS, or Linux for the Node service
- Node.js 20+
- pnpm 12.6.0

Browser automation additionally requires a compatible playwright-cli / @playwright/cli installation available to Junius.

Windows Desktop Computer Use additionally requires Python and the packages listed in requirements-desktop.txt. Junius prefers the project-owned .venv beside its Desktop helper.

## Quick start

    pnpm install
    pnpm dev

The Host binds locally to:

    MCP:          http://127.0.0.1:8787/mcp
    Host control: http://127.0.0.1:8788/__junius/host-health

Port 8788 is not a management UI. It exposes only local Host diagnostics such as health and supervisor state.

To use Junius from ChatGPT, expose only the MCP endpoint through the supported Secure MCP Tunnel flow and point the tunnel at:

    http://127.0.0.1:8787/mcp

Do not expose the Host-control endpoint.

## Chat-first Workspace management

A Workspace is deliberately small:

    Workspace
    = stable ID
    + canonical local root path

It has no command permissions, executable registration, or argument rules.

Create a Workspace from ChatGPT:

    create_workspace(
      id = "weave",
      root_path = "C:\Projects\Weave"
    )

Inspect all Workspaces:

    list_workspaces()

Remove a Workspace registration:

    delete_workspace(id = "weave")

delete_workspace removes only the Junius registration. It never deletes the directory or its files.

Workspace registrations are persisted outside the repository.

    Windows:
    %LOCALAPPDATA%\Junius\workspace-state.json

    Linux/macOS:
    $XDG_STATE_HOME/Junius/workspace-state.json
    or ~/.local/state/Junius/workspace-state.json

Override with JUNIUS_WORKSPACE_STATE_PATH.

Legacy Workspace state containing older authorization fields is accepted during migration; those fields are ignored and new writes use the root-only schema.

## Command execution

run_command launches any executable with any argument vector:

    run_command(
      workspace,
      executable,
      args
    )

Example:

    run_command(
      workspace = "default",
      executable = "git",
      args = ["status", "--short", "--branch"]
    )

Junius does not require executables to be registered first and does not apply an argument allowlist.

The selected Workspace determines the child process working directory:

    cwd = Workspace root

Execution uses direct process spawning with shell disabled:

    child_process.spawn(executable, args, {
      cwd,
      shell: false
    })

If shell semantics are required, the caller can explicitly launch a shell executable such as cmd.exe, PowerShell, or /bin/sh and provide that shell's arguments. Junius does not parse a command for safety or intent.

Synchronous execution retains runtime engineering bounds:

- bounded captured output;
- bounded execution time;
- stdout/stderr and exit diagnostics;
- process-tree termination on forced stop;
- Windows descendant termination through taskkill /T /F.

These are execution-integrity controls, not command-authorization rules.

## Background Jobs

Long-running commands use the same executable model:

    start_job(workspace, executable, args)

The returned Job ID is used with get_job, wait_job, read_job_output, and cancel_job.

Jobs preserve:

- bounded captured stdout/stderr;
- persistent terminal history;
- cancellation;
- Worker ownership and affinity while running;
- Windows Job Object crash containment through the guardian path;
- interrupted-job recovery when a Worker or Host disappears.

Current Job history writes use the executable-oriented v2 schema. Historical v1 records that stored a command key are still read and normalized.

## Workspace file tools

Built-in file tools are intentionally different from process execution. They use Workspace-relative paths and apply their own path-containment implementation.

Important properties include:

- absolute paths and .. traversal are rejected;
- reads do not follow links outside the Workspace;
- writes reject symbolic-link/junction parent aliases;
- transactional multi-file writes stage, commit, and attempt reverse rollback on commit failure;
- write parents are revalidated around commit to narrow path-replacement races;
- the .junius control directory is reserved;
- .git metadata is reserved from generic Workspace file tools;
- configured Junius runtime/state and Browser profile paths are protected if they fall inside a Workspace;
- rg cannot use later include globs to re-enable protected paths.

These checks apply only to Junius's built-in file tools. They do not restrict an executable launched by run_command or start_job.

## Browser Computer Use

playwright_cli is a bounded adapter over Playwright CLI.

It supports the browser workflow needed by ChatGPT: navigation, snapshots, element-reference interaction, keyboard/mouse actions, tabs, dialogs, and session lifecycle. Arbitrary JavaScript/eval, CDP, request interception, and raw storage access are not exposed by this adapter.

Named Browser sessions are Worker-affined across hot promotion. Idle sessions are bounded and cleaned up independently.

Browser profile data is persistent so normal authenticated browser sessions can survive between calls.

## Windows Desktop Computer Use

Desktop perception is screenshot-based. Junius can enumerate top-level native windows, capture the screen or one window, focus a window, perform coordinate mouse actions, send keyboard actions and macros, read/write Unicode clipboard text, and type text directly where supported.

Desktop tasks have an explicit control lifecycle:

    control_begin(session)
    → desktop actions
    → control_end(session)

The same session must be used for the whole task.

While at least one Desktop control scope is active, Junius shows a top-center local disclosure:

    ChatGPT 正通过 Junius 操作电脑

Four click-through topmost edge windows provide the breathing-light effect. Top and bottom edges own the corner pixels; left and right edges exclude the corner thickness so alpha does not overlap.

The disclosure remains visible for the entire control scope, not for an inactivity timeout. Helper or Worker exit destroys the native windows as the crash fallback.

Desktop sessions are Worker-affined until successful control_end, so hot Worker promotion cannot split the visible takeover lifecycle from the Worker performing the actions.

## Host / Worker architecture

Junius uses a stable Host plus replaceable Workers:

    ChatGPT
       |
       v
    127.0.0.1:8787
       |
      Host
       |
       +--> active Worker
       |
       +--> retiring Worker(s) while affinity/in-flight work drains

The Host owns public routing. Workers listen on random loopback ports and require a private 256-bit token injected by the Host.

Source hot reload follows:

    source change
    → full validation
    → spawn candidate Worker
    → ready IPC
    → private health check
    → promote candidate
    → retain previous Worker for rollback/drain

Failed validation or failed candidate startup leaves the active Worker unchanged. A newly promoted Worker that exits during the rollback window can fall back to the previous live Worker.

### Resource affinity

Process-local resources stay with their owning Worker:

- MCP session IDs retain their owning Worker while the route is active;
- running Jobs retain the Worker that created them;
- named Browser sessions retain their Worker until close or idle expiry;
- Desktop control sessions retain their Worker from control_begin through successful control_end.

Workspace mutation is shared persistent configuration.

A successful create_workspace or delete_workspace response is buffered by the Host until every other live Worker has reloaded the persisted Workspace state. A Worker that cannot reload is quarantined rather than continuing with stale registration state.

## Last-known-good startup

pnpm dev and pnpm start enter scripts/host-launcher.mjs.

The launcher prefers the last validated bootstrap copy. The bootstrap fingerprints source/runtime control inputs and uses full validation before advancing the last-known-good release.

Failed validation or failed startup leaves the previous validated release intact.

The newest three Host releases are retained under:

    .junius/runtime/releases

Host-only changes require a manual Junius restart rather than an autonomous self-restart.

## Audit

Audit is observational, not an authorization layer.

It stores bounded metadata such as category/action/status, Workspace, executable identity, argument count, exit code, output sizes, durations, and Browser/Desktop action metadata.

It intentionally does not copy:

- command stdout/stderr contents;
- raw arbitrary command argument vectors;
- file contents or edit text;
- screenshots;
- Browser/Desktop typed text;
- clipboard text.

Browser navigation audit strips query/hash.

Audit persistence is best-effort and must not change the result of the underlying operation.

## Security boundary

Junius intentionally does not decide whether a requested local command is safe, destructive, appropriate, or intended.

The intended decision chain is:

    User
      ↓
    ChatGPT / calling assistant
      ↓
    Junius execution

Any executable launched through run_command or start_job has the operating-system permissions of the user running Junius.

A process can therefore access resources outside its selected Workspace if that operating-system user can access them.

The Workspace is:

    cwd + built-in file-tool root

It is not a process sandbox, filesystem jail for launched executables, network isolation, registry isolation, or credential isolation.

The MCP and Host-control listeners remain bound to loopback. Worker private endpoints require their internal token. If the MCP endpoint is tunneled to ChatGPT, only that endpoint should be exposed.

See SECURITY.md and docs/architecture.md for more detail.

## Validation

Run the complete project validation:

    pnpm run check

This performs bootstrap syntax validation, TypeScript checking, the complete test suite, and source-validation fingerprint commit.

## License

ISC.
