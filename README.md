# Junius

<p align="center">
  <img src="icon.svg" alt="Junius" width="128" height="128" />
</p>

**English** | [简体中文](README.zh-CN.md)

**Local computer control for ChatGPT over MCP.**

Junius is a local MCP execution service designed for ChatGPT chat. It gives the calling assistant direct access to local Workspace files, local processes, background Jobs, browser automation, and Windows desktop interaction.

> **Junius is an execution service, not a policy engine.**
>
> Decisions about whether an operation is appropriate, destructive, or intended belong to the user and the calling assistant. Junius does not maintain a second command-authorization system.

Junius is **not an operating-system sandbox**. Processes launched by Junius run with the permissions of the operating-system user that started Junius.

## One-command installation

Junius supports **Windows only**. Linux, macOS, and every other operating system are intentionally unsupported, and Junius runtime entrypoints refuse to start on them.

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

After installation, Junius starts automatically when that Windows user signs in. The per-user HKCU Run entry launches a hidden PowerShell startup script that records the exact Node executable used for installation; Junius no longer depends on VBScript/WScript for startup. The Desktop helper uses the installed .venv created from the user's existing Python.

Junius has a first-class updater. The CLI supports `junius update --check` to compare the current package version with the newest published GitHub Release and `junius update` to install it. Installed Junius exposes the same capability directly to ChatGPT through the MCP tools `check_junius_update` and `update_junius`. The source-tree test connection does not expose installed-copy update tools.

The updater reuses the same GitHub Release bootstrap and SHA-256 verification as installation. A CLI update running outside Junius stops and restarts the installed Host so the new version becomes active immediately. An MCP self-update never kills its own active tool call; it installs and validates the new version, returns `restartRequired: true`, and requires Junius to be restarted afterward. Re-running the original PowerShell install command remains a valid in-place update path.

The Host uses one loopback HTTP listener:

    http://127.0.0.1:8787

Its routes are:

    MCP:        /mcp
    Health:     /__junius/host-health
    Supervisor: /__junius/supervisor

There is no separate Host-control port and no management UI.

## Supported usage scope and distribution model

Junius is deliberately a **Windows-only personal/local MCP product**, not a public-directory plugin.

Its supported product scope is **ChatGPT Plus and higher**. Junius is designed around the paid ChatGPT experience where a user can create a personal MCP connection in Developer mode and give ChatGPT a sufficiently capable model plus the MCP tool surface needed for open-ended local execution. Free and Go are not target tiers for Junius. The project will not add a degraded read-only path, reduced-permission compatibility layer, or lower-capability-model-specific UX solely to make Junius fit those tiers.

This is a Junius support policy, not a promise that OpenAI will keep every plan, model, Developer mode entitlement, or MCP permission unchanged. OpenAI product availability can change independently of Junius; the current OpenAI developer documentation should be checked when setting up a connection.

### Why Junius is not published to the public plugin directory

Junius is intentionally **not** submitted to the public ChatGPT/Codex plugin directory.

The intended deployment model is:

1. install and run Junius on your own Windows machine;
2. keep the Junius MCP server bound to local loopback;
3. create your own OpenAI Secure MCP Tunnel to the exact `/mcp` endpoint;
4. create a **personal** MCP/plugin connection in ChatGPT Developer mode;
5. use that connection only for the local machine you chose to expose.

A public-directory listing is the wrong distribution model for Junius for several reasons:

- **There is no shared hosted Junius service.** Each Junius instance belongs to one user's computer and executes with that user's local operating-system permissions.
- **The connection is intentionally private and machine-specific.** Tunnel IDs, runtime credentials, local paths, Workspaces, Browser state, and Desktop access belong to the user who owns that machine.
- **Junius should not expose its Host publicly.** The Host remains loopback-only; only the exact `/mcp` route is bridged through the user's Secure MCP Tunnel. The co-located diagnostic routes remain local.
- **Discovery is not the product goal.** Users obtain Junius as local software, then explicitly create their own personal MCP connection. Public catalog discovery adds no useful step to that workflow.
- **A public listing would create the wrong expectation.** Installing a directory entry cannot install Junius on a user's PC, start its local Host, create the user's tunnel, or grant access to that machine. Those steps must remain explicit and user-owned.
- **Junius does not need lowest-tier compatibility to widen directory reach.** Its supported baseline is Plus and higher, so the project can optimize for capable models and the intended MCP execution workflow instead of carrying Free/Go fallback behavior.

GitHub Releases remain Junius's **public software distribution channel**. That is separate from publishing Junius as a public ChatGPT/Codex plugin: the release distributes the local program; the ChatGPT connection remains personal.

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

Junius's own supported baseline starts at ChatGPT Plus. In practice, the account or workspace used for Junius must expose the Developer mode, Secure MCP Tunnel, and MCP read/write capabilities required by the workflow above. OpenAI can change plan entitlements, model availability, UI, and workspace policy independently of Junius, and OpenAI documentation can temporarily describe different rollout states. Treat the capabilities actually available to the account together with the latest OpenAI Developers documentation as the setup authority. Junius does not add a Free/Go fallback when those capabilities are absent.

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

The repository `prompts/*.md` files are the versioned defaults. They are included in source fingerprints, last-known-good snapshots, installed Release packages, and normal source validation. When developing Junius from source, editing those files changes the defaults and follows the normal validated Worker reload path.

Installed Junius keeps those packaged defaults under `%LOCALAPPDATA%\Junius\app\prompts`, where an update may replace them. Long-lived user customization instead lives in `%LOCALAPPDATA%\Junius\prompts`. That directory is outside the application root, is not replaced by updates, and takes precedence over the matching packaged default. On the first update from an older installation, existing legacy `app\prompts` files are conservatively copied into the persistent override directory before the packaged defaults are replaced; existing persistent overrides are never overwritten by this migration.

ChatGPT can manage the persistent overrides directly through `get_junius_prompts`, `set_junius_prompt`, and `reset_junius_prompt`. Resetting an override returns that prompt to the default supplied by the currently installed Junius version. Specialized Engineering/Desktop/Browser changes are used by the next `load_junius_contracts` call; Core changes are supplied to newly initialized MCP sessions because an already initialized session retains the Core instructions it received at initialization.

## Development from source

Repository development uses pnpm 12.6.0:

    pnpm install
    pnpm dev

`pnpm dev` starts a source-tree test instance on `127.0.0.1:18787` for contributors working on Junius itself. This is not a separate Junius edition, and normal installed users do not choose between "development" and "production" versions. Installed Releases are simply **Junius** on `127.0.0.1:8787`. The source-test connection identifies itself as **Junius (Source Test)** and is only for requests that explicitly test, exercise, validate, or debug the source build. Ordinary Junius work — including editing the repository without testing the source instance — should use installed Junius.

`pnpm start` retains the normal launcher behavior and default port `8787`; `pnpm dev` is only the source-test launcher.

Release assets are built with:

    npm run release:build

That produces `dist/junius-windows.tgz`, `dist/SHA256SUMS.txt`, `dist/install.ps1`, and `dist/release.json`. Release notes follow `CHANGELOG.md`: before tagging, the new version must have an exact `## <package.version>` section, and the GitHub Release body contains only that section's body.

The one-command installer does not require the user to have pnpm installed. npm remains an internal dependency installer inside the verified Junius application package; npm is not the public Junius distribution channel.

## Higher-level engineering tools

Junius keeps the low-level execution primitives, but common engineering round trips also have higher-level equivalents:

- `workspace_patch` applies a standard multi-file unified diff transactionally, with the same Workspace path protections and AGENTS.md acknowledgement as other writes, and can verify the result in the same call.
- `run_commands` runs up to 16 short commands in one Workspace, in parallel or serially, through the same unrestricted execution path as `run_command`.
- `git_snapshot` returns branch/status, staged and unstaged summaries, and recent commits in one call.
- `git_prepare_commit` stages only explicit paths, checks the staged diff, and returns the full staged diff plus a Git tree token for review.
- `git_commit` commits only when the staged tree still matches that reviewed token. It never pushes.

Long-running commands still use Jobs. Junius does not turn these helpers into an automatic engineering policy engine.

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

Workspace registrations are persisted outside the repository:

    %LOCALAPPDATA%\Junius\workspace-state.json

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

If shell semantics are required, the caller can explicitly launch a Windows shell executable such as cmd.exe or PowerShell and provide that shell's arguments. Junius does not parse a command for safety or intent.

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

Terminal Job history is retained for 7 days by default. The default applies by age only; there is no default entry-count limit, so high Job volume does not evict otherwise unexpired history. `JUNIUS_JOB_HISTORY_MAX_AGE_MS` overrides the age window, and `JUNIUS_JOB_HISTORY_MAX_ENTRIES` can add an explicit count limit. Captured stdout/stderr are part of Job history and are deleted with the Job record when it expires.

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

Browser access is opt-in per user task. Junius must not call `playwright_cli` unless the current user request explicitly asks ChatGPT to control the browser. This includes read-only inspection such as snapshots, tab/session listing, cookies, storage, console, and network data. Previous authorization does not carry forward, and loading the Browser contract does not grant authorization.

The first Browser call for a session must carry `explicit_user_authorization=true`. Once that current-task authorization is accepted, follow-up calls for the same active session omit the assertion even if an individual Browser command fails. `close` revokes authorization and ends that Browser operation lifecycle.

`playwright_cli` exposes the full installed Playwright CLI command surface. Junius injects only the named session option:

    -s=<session>

The requested command and argument vector are otherwise forwarded unchanged. There is no Junius Browser command whitelist or per-command argument policy. Commands such as eval, run-code, storage/cookie operations, network request inspection and routing, recording/tracing/video, WebMCP, attach/detach, install commands, and future Playwright CLI commands are available when supported by the installed CLI version.

Browser startup is lazy. Normal Worker startup and ordinary project validation do not prewarm the Playwright broker or start Browser Computer Use.

Named Browser sessions are Worker-affined across hot promotion. Idle sessions are bounded and closed independently.

By default, Junius-managed Browser data lasts only for the current Browser operation. Each session uses its own managed directory; on `close`, Junius invokes Playwright `delete-data` for that session and deletes the managed session directory, including automatically generated snapshots, screenshots, console output, and related Browser artifacts. Files the user explicitly requested to save outside that managed directory are not treated as disposable Browser data.

Set `JUNIUS_BROWSER_RETAIN_DATA=1` to keep Junius-managed Browser data after `close`. When this is enabled, automatic cleanup is disabled for that retained data and the user is responsible for reviewing and deleting it later. Browser audit records the command identity and argument count, but not the arbitrary argument vector.

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

`pnpm dev` and `pnpm start` both enter `scripts/host-launcher.mjs`. The `--dev` path is a contributor-only source-test path pinned to `18787`; the normal installed identity remains simply Junius on `8787`. This separation exists to test source changes without replacing the installed copy, not to define two user-facing editions.

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
