# Junius

**English** | [简体中文](README.zh-CN.md)

**Local computer control for ChatGPT over MCP.**

Junius is a local MCP execution service designed for ChatGPT chat. It gives the calling assistant direct access to local Workspace files, local processes, background Jobs, browser automation, and Windows desktop interaction.

> **Junius is an execution service, not a policy engine.**
>
> Decisions about whether an operation is appropriate, destructive, or intended belong to the user and the calling assistant. Junius does not maintain a second command-authorization system.

Junius is **not an operating-system sandbox**. Processes launched by Junius run with the permissions of the operating-system user that started Junius.

## MCP surface

    load_junius_contracts(modes)

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

## Injected operating contracts

Junius uses MCP-native instructions for its ChatGPT execution contract.

The Core Operating Contract is sent in the MCP initialize result through the server's `instructions` field. It contains only cross-cutting Junius behavior: explicit user constraints, truthful state reporting, real-path problem handling, instruction precedence, Workspace/AGENTS.md semantics, process and Job semantics, verification, cleanup, and final constraint convergence.

Large task-specific behavior is deliberately not embedded in Core. Junius keeps three separate contracts:

- `engineering` — software-engineering decision boundaries, reuse-before-creation, avoiding speculative compatibility and unnecessary machinery, bug reproduction and RED → GREEN discipline, relevant structural convergence, real-surface QA, Git discipline, and final engineering review;
- `desktop` — screenshot-only Desktop Computer Use, control lifecycle, coordinate semantics, primitive selection including `key_macro` and `action_batch`, act-observe verification, and cleanup;
- `browser` — the unrestricted Playwright CLI surface, Browser session continuity, state-dependent references, act-observe verification, and session cleanup.

ChatGPT loads only the modes needed for the current task:

    load_junius_contracts(
      modes = ["engineering"]
    )

or, when several apply:

    load_junius_contracts(
      modes = ["engineering", "browser"]
    )

The result starts with mode/digest metadata and then returns each selected contract as its own raw Markdown text block. Duplicate modes are deduplicated while requested order is preserved.

The Core contract requires the Engineering contract before substantive software-engineering work, the Desktop contract before the first `desktop` call in a task, and the Browser contract before the first `playwright_cli` call.

These contracts guide the calling assistant. They are not executable authorization rules and do not reintroduce a Junius command/capability policy layer. The existing AGENTS.md mutation preflight remains a separate built-in file-tool mechanism.

### Customizing Junius prompts

The operating contracts are not hardcoded in TypeScript. Junius loads them as UTF-8 Markdown from the repository's `prompts/` directory:

- `prompts/core.md` — the Core Operating Contract sent through MCP `instructions`;
- `prompts/engineering.md` — software-engineering work mode;
- `prompts/desktop.md` — Desktop Computer Use contract;
- `prompts/browser.md` — Browser Computer Use contract.

Edit these Markdown files to customize the instructions Junius supplies to ChatGPT. The files are included in source fingerprints, last-known-good snapshots, installed release packages, and normal source validation. A running Host watches `prompts/*.md`; a prompt edit follows the same validated Worker hot-reload path as other Worker-side source changes.

For a normal Windows installation, the editable copies live under `%LOCALAPPDATA%\Junius\app\prompts`. In-place Junius updates refresh the packaged `prompts` directory, so keep any long-lived custom prompt changes under version control or reapply them after updating.

## One-command installation

The current one-command installer targets Windows.

Prerequisites already present on the user's computer:

- Node.js 20+ with npm/npx
- Python 3.10+

Install Junius on Windows with one PowerShell command:

    irm https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1 | iex

GitHub Releases is the public Junius distribution channel. The bootstrap script:

- resolves the newest published Junius GitHub Release, including prereleases;
- downloads `junius-windows.tgz` and `SHA256SUMS.txt`;
- verifies the release package SHA-256 before executing anything from it;
- unpacks the verified package into a temporary directory;
- invokes the packaged Junius installer with the user's existing Node.js runtime.

The installer does not download or replace Node or Python. It requires Node.js 20 or newer, finds an existing compatible Python installation, and then:

- installs Junius under %LOCALAPPDATA%\Junius\app;
- materializes the packaged dependency lock as npm-shrinkwrap.json;
- installs Junius's npm dependencies, including the Browser CLI;
- creates %LOCALAPPDATA%\Junius\app\.venv using the user's Python;
- installs requirements-desktop.txt into that virtual environment;
- runs the complete installed-runtime Junius validation suite;
- registers Junius under the current user's Windows logon startup;
- starts Junius immediately and waits for the Host health check to pass.

No administrator elevation is required for the normal per-user installation path.

After installation, Junius starts automatically when that Windows user signs in. The startup entry records the exact Node executable used for installation, and the Desktop helper uses the installed .venv created from the user's existing Python.

Running the same PowerShell command again performs an in-place update from the newest published GitHub Release: Junius copies and validates the new package first, then restarts an existing Host so the installed version becomes active immediately. If the installer itself is invoked through a running Junius tool call, it does not terminate its own execution tree; in that case it installs and validates the update, then reports that Junius must be restarted to activate it.

The Host uses one loopback HTTP listener:

    http://127.0.0.1:8787

Its routes are:

    MCP:        /mcp
    Health:     /__junius/host-health
    Supervisor: /__junius/supervisor

There is no separate Host-control port and no management UI.

## Connect Junius to ChatGPT

The GitHub Release installer installs and starts the local Junius service. It does **not** create an OpenAI Secure MCP Tunnel or configure a ChatGPT plugin connection for you.

ChatGPT cannot connect directly to a loopback-only MCP server. For a local Junius installation, use OpenAI Secure MCP Tunnel:

1. Create or select a tunnel in OpenAI Platform tunnel settings.
2. Install and configure the current OpenAI `tunnel-client` on the same Windows machine.
3. Point that tunnel profile at the exact Junius MCP URL:

       http://127.0.0.1:8787/mcp

4. Run `tunnel-client doctor` for the profile and confirm it is healthy.
5. Keep `tunnel-client run` running while Junius is used.
6. In ChatGPT, open **Plugins**, select the plus button, and add the MCP connection in Developer mode.
7. Choose **Tunnel** as the connection type and select the corresponding Secure MCP Tunnel.
8. Review the discovered Junius tools and create the personal plugin connection.

Do not point the tunnel at the bare `http://127.0.0.1:8787` origin. The co-located `/__junius/*` routes are local operational diagnostics and are not part of the public MCP surface.

Secure MCP Tunnel setup requires the appropriate OpenAI Platform tunnel permissions, a tunnel ID, and a runtime API key. These are OpenAI account/workspace resources and are intentionally not collected or stored by the Junius installer.

Current OpenAI developer documentation:
- ChatGPT developer platform overview: https://developers.openai.com/chatgpt
- Plugins quickstart: https://developers.openai.com/plugins/quickstart
- Connect and test a plugin: https://developers.openai.com/plugins/deploy/connect-chatgpt
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

OpenAI's current developer documentation states that ChatGPT Developer mode provides full Model Context Protocol support for read and write tools in ChatGPT Plus and Pro. Junius relies on that full MCP tool surface. Availability and UI can change independently of Junius, so prefer the current OpenAI Developers documentation over older product-help articles when they disagree.

## Development from source

Repository development uses pnpm 12.6.0:

    pnpm install
    pnpm dev

Release assets are built with:

    npm run release:build

That produces `dist/junius-windows.tgz`, `dist/SHA256SUMS.txt`, `dist/install.ps1`, and `dist/release.json`.

The one-command installer does not require the user to have pnpm installed. npm remains an internal dependency installer inside the verified Junius application package; npm is not the public Junius distribution channel.

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

### AGENTS.md behavior

Workspace inspection follows Codex-style directory scoping for AGENTS.md:

- an AGENTS.md applies to the directory that contains it and the entire subtree below that directory;
- more deeply nested AGENTS.md files appear later in the instruction chain and take precedence for files in their narrower scope;
- ls, read, rg, and workspace_batch automatically return applicable AGENTS.md content together with each file's scope and a SHA-256 digest;
- recursive scans also discover nested AGENTS.md files inside the scanned subtree;
- write and workspace_apply perform a mandatory AGENTS.md preflight. If applicable instructions exist and the caller has not supplied the current agents_digest, Junius rejects the mutation before changing files and returns the complete applicable instruction chain plus the digest;
- if an applicable AGENTS.md changes, the old digest no longer authorizes the built-in file mutation;
- oversized AGENTS.md instruction sets fail explicitly rather than being silently omitted.

The calling agent must treat those instructions as binding within their scope. Direct system/developer/user instructions remain higher priority than AGENTS.md instructions.

These checks apply only to Junius's built-in file tools. They do not restrict an executable launched by run_command or start_job; process execution remains unrestricted by Workspace file-tool policy.

## Browser Computer Use

playwright_cli exposes the full installed Playwright CLI command surface.

Junius injects only the named session option:

    -s=<session>

The requested command and argument vector are otherwise forwarded unchanged. There is no Junius Browser command whitelist or per-command argument policy. Commands such as eval, run-code, storage/cookie operations, network request inspection and routing, recording/tracing/video, WebMCP, attach/detach, install commands, and future Playwright CLI commands are available when supported by the installed CLI version.

Named Browser sessions are Worker-affined across hot promotion. Idle sessions are bounded and cleaned up independently.

Junius provides a persistent Browser state directory, but it does not force Playwright CLI persistence options. Browser/profile persistence therefore follows the command and options supplied by the caller, such as --persistent or explicit state-save/state-load. Browser audit records the command identity and argument count, but not the arbitrary argument vector.

## Windows Desktop Computer Use

Desktop access is opt-in per user task. Junius must not call the Desktop tool unless the current user request explicitly asks ChatGPT to control the local computer. This includes read-only access: without current-task authorization, Junius must not enumerate windows, capture screenshots, or read the clipboard. Previous authorization does not carry forward, and loading the Desktop contract does not grant authorization. Authorization is established only by a successful `control_begin` carrying `explicit_user_authorization=true`; follow-up calls omit that assertion and are accepted only for the same active session. `control_end` revokes the session authorization immediately.

The Desktop helper is lazy-started on the first authorized Desktop call; normal Host/Worker startup and ordinary project validation do not prewarm or inspect the Desktop.

Desktop perception is deliberately screenshot-only. Junius does not use Windows UI Automation or an accessibility/semantic control tree. Once explicitly authorized, it can enumerate top-level native windows, capture the screen or one window, focus a window, perform coordinate mouse actions, drag, wait, send keyboard actions and macros, read/write Unicode clipboard text, and type text directly where supported.

action_batch executes up to 128 mixed Desktop actions in one helper round trip. Batch actions can combine focus, mouse movement/click/down/up/wheel, drag, wait, keyboard actions/macros, clipboard access, and text input. Explicit wait and drag durations are bounded, and held keys/buttons are released on batch failure.

For act → observe loops, action_batch supports screenshot_after. When enabled, the post-action screenshot is returned in the same MCP response; screenshot_handle can target one top-level window instead of the full screen.

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

The single Host HTTP listener remains bound to loopback. Worker private endpoints require their internal token. If Junius is tunneled to ChatGPT, expose only the exact /mcp endpoint; do not expose the co-located /__junius/* diagnostic routes.

See SECURITY.md and docs/architecture.md for more detail.

## Validation

Run the complete project validation:

    pnpm run check

This performs bootstrap syntax validation, TypeScript checking, the complete test suite, and source-validation fingerprint commit.

## License

ISC.
