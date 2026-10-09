# Junius Architecture

## Purpose

Junius is a local MCP execution service for ChatGPT.

Its responsibility is execution, lifecycle, routing, persistence, observability, and local computer control.

It is deliberately not a second command-policy engine.

The high-level responsibility split is:

    User
      ↓
    ChatGPT / calling assistant
      ↓
    Junius
      ↓
    local machine

The caller decides what should be done. Junius performs the selected local operation and reports what happened.

## One-command Windows installation

Junius is distributed publicly through GitHub Releases.

A Windows user installs or updates Junius with:

    irm 'https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1' | iex

The bootstrap resolves the newest published GitHub Release, including prereleases, downloads `junius-windows.tgz` plus `SHA256SUMS.txt`, verifies the package SHA-256, extracts the verified package, and invokes the packaged Junius CLI.

The packaged installer reuses the user's existing Node.js 20+ runtime and an existing Python 3.10+ interpreter discovered on the machine. It does not download or replace either runtime.

The persistent per-user application root is:

    %LOCALAPPDATA%\Junius\app

Installation performs:

    copy compiled Junius application
      ↓
    npm install --omit=dev in the persistent app root
      ↓
    create app\.venv from the discovered Python
      ↓
    install Desktop Python requirements
      ↓
    validate the installed compiled runtime and CLI
      ↓
    create %LOCALAPPDATA%\Junius\bin\junius.cmd
      ↓
    add %LOCALAPPDATA%\Junius\bin to the user PATH
      ↓
    register HKCU logon startup
      ↓
    start Junius immediately
      ↓
    wait for Host health

The CLI shim records the exact Node executable used for installation and forwards arguments to the installed `app\bin\junius.mjs`. The installer adds the stable `%LOCALAPPDATA%\Junius\bin` directory to the per-user `PATH` without using `setx`, avoiding PATH truncation; the bootstrap also updates the invoking PowerShell process so `junius` is immediately available after a one-command install.

The logon startup entry records the exact Node executable used for installation and launches scripts/host-launcher.mjs through a hidden per-user PowerShell startup script. The installer itself starts the freshly installed Host directly with that same Node executable and launcher path, rather than routing the immediate health-checked start back through the logon wrapper. No Windows service or administrator elevation is required.

Release construction compiles the TypeScript code first, assembles a compiled installable application, and packages that application directly as `junius-windows.tgz`. The installed package keeps the bootstrap/rollback layer at the application root and places the emitted Host/Worker code under `runtime/`; validated release snapshots therefore start `runtime/src/host.js` and `runtime/src/worker-entry.js` while retaining last-known-good fallback. The installed application does not contain the TypeScript source tree, source tests, `tsx`, TypeScript, or source-build configuration. Source-tree development remains separate and can still run TypeScript through `tsx`.

The installed CLI also exposes `junius restart`. It reuses the installed Host stop/start helpers, stops the existing Host process tree when present, launches the installed Host launcher, and waits for the replacement Host health check before returning.

The installed Browser adapter prefers the app-local @playwright/cli package before PATH. The Desktop adapter uses the app-local .venv, whose base interpreter comes from the user's existing Python installation.

Repository development can still use pnpm, but an installed user does not need pnpm on PATH. npm is used only inside the verified release package to install the locked JavaScript dependency tree; Junius itself is not distributed through the npm registry.

A tag matching `v<package.version>` triggers the Windows release workflow. The workflow validates the repository, builds the release assets, extracts only the matching `## <package.version>` body from `CHANGELOG.md` as the GitHub Release body, creates a draft Release, installs Junius back from those draft assets, verifies Host health, and only then publishes the Release. Missing or empty version changelog sections fail Release creation; GitHub auto-generated release notes are not used.

## Instruction injection model

Junius separates universal operating behavior from large task-specific contracts.

At MCP initialization, `McpServer` sends the Core Operating Contract through the protocol-level `instructions` field.

Core intentionally does not contain Desktop or Browser primitive behavior. Instead it routes the calling assistant to:

    load_junius_contracts(modes)

Supported modes are:

    engineering
    desktop
    browser

The loader is read-only and deterministic. It returns the current effective contract text and a SHA-256 digest for each requested mode, deduplicating repeated modes while retaining first-requested order.

Packaged defaults remain under the installed application `prompts/` directory and may change with a Junius update. Persistent user overrides live separately under `%LOCALAPPDATA%\Junius\prompts` and take precedence by prompt name, so updating `%LOCALAPPDATA%\Junius\app` does not overwrite customization. Before replacing an older installation's application files, the installer migrates any legacy `app\prompts` files whose persistent override does not yet exist; this preserves the previously documented editable-copy behavior without overwriting an already migrated override. The MCP tools `get_junius_prompts`, `set_junius_prompt`, and `reset_junius_prompt` manage that override layer. Specialized contracts are read on each `load_junius_contracts` call; Core is resolved when a new MCP server/session is initialized.

Engineering may be loaded after minimal inspection needed to identify the task, but before substantive engineering work. Desktop must be loaded before the first `desktop` tool call in a task. Browser must be loaded before the first `playwright_cli` call.

Tool descriptions repeat only this short routing requirement; they do not duplicate the full contracts. This keeps the always-injected Core independent from Computer Use details and avoids placing the full specialized text into every tool schema.

The contracts are instructions for the calling assistant, not an authorization or policy engine. They do not restrict `run_command`, `start_job`, Playwright CLI, or Desktop primitives at the Junius execution layer.

## Public MCP model

The stable user-facing surface is MCP.

There is no management Web UI.

The public tools are grouped into eight areas.

### Operating contracts

    load_junius_contracts(modes)

Core is delivered by MCP initialize instructions. This read-only tool injects only the specialized Engineering, Desktop, and Browser contracts required by the current task. Its first text block contains mode/digest metadata; following text blocks contain the selected contracts as raw Markdown.

### Prompt customization

    get_junius_prompts(prompts?)
    set_junius_prompt(prompt, content)
    reset_junius_prompt(prompt)

These tools expose the persistent user override layer without turning prompt customization into application-file editing. Setting an override never modifies the packaged default. Reset deletes the user override so the current packaged default becomes effective again.

### Workspace registration

    list_workspaces()
    create_workspace(id, root_path)
    delete_workspace(id)

A Workspace is only:

    {
      id,
      canonical root path
    }

The root has two uses:

1. cwd for run_command and start_job.
2. root boundary for built-in Workspace file tools.

Workspace registration is persistent.

delete_workspace unregisters the Workspace but never deletes the directory or any file inside it.

### Local Agent Skills

    list_skills(workspace?)
    read_skill(name, workspace?, scope?, path?)
    install_skill(source, scope, workspace?, subpath?, replace?)
    remove_skill(name, scope, workspace?)

Skills remain ordinary Agent Skill directories rather than Junius-owned objects. Global skills live under `%USERPROFILE%\.agents\skills`; Workspace skills live under `<workspace>\.agents\skills`. A Workspace skill with the same manifest name is effective for that Workspace while the global copy remains intact.

Discovery reads only the `SKILL.md` manifest metadata needed to choose a skill. Full `SKILL.md` content and supporting UTF-8 files are read on demand. Skill-contained scripts and assets remain ordinary local files; there is no second execution runtime.

`install_skill` materializes one complete skill from a local directory/archive, an HTTP(S) archive, or a GitHub repository/tree/blob URL. Remote download, archive extraction, candidate selection, Agent Skills manifest/tree validation, staging, replacement, rollback, and cleanup are one execution operation. Installed skills require the standard lowercase hyphenated name, bounded non-empty description, non-empty instruction body, and a single root `SKILL.md`. If a source contains multiple skills and no subpath selects one, Junius returns the candidates instead of guessing.

Workspace scope takes precedence over global scope by name. Workspace install/remove operations run an AGENTS.md preflight for the target `.agents/skills/<name>/SKILL.md` path. Skill storage has its own containment checks; supporting-file reads cannot escape the selected skill root.

### Workspace file operations

    ls
    read
    rg
    workspace_batch

    write_file
    apply_patch
    delete_file
    move_file
    copy_file
    mkdir
    workspace_mutate

All paths are Workspace-relative.

These tools implement their own path checks and do not delegate user paths to a shell.

Workspace inspection also loads directory-scoped AGENTS.md instructions. A file applies to its containing directory and descendants; deeper AGENTS.md files are ordered later and therefore represent the more specific instruction scope. Read-only scans return the applicable instruction chain and digest. Every built-in Workspace mutation requires the current digest when instructions apply, so mutations cannot occur before the caller has received the current scoped instruction set.

The default mutation model is a normal mutable working tree: write_file, delete_file, move_file, copy_file, and mkdir commit one operation at a time, and later failures do not rewind earlier successful calls. apply_patch is one explicit atomic unified-diff operation, while workspace_mutate is the optional all-or-nothing batch for operations that genuinely require shared rollback. Both reuse the same Workspace containment, protected-path, AGENTS.md, target-revalidation, and rollback machinery.

### Direct process execution

    run_command(workspace, executable, args)

The executable and argument vector are supplied directly by the caller.

Junius does not pre-register executables and does not evaluate an argument policy before launch.

The process is launched using direct argument-vector spawning:

    child_process.spawn(executable, args, {
      cwd: Workspace root,
      shell: false
    })

If shell behavior is required, the caller can explicitly select a shell executable and provide its argument vector.

### Background Jobs

    start_job(workspace, executable, args)
    get_job(job)
    wait_job(job, timeout_ms)
    read_job_output(job, stream, offset, limit)
    cancel_job(job)

Job launch uses the same process preparation model as run_command.

### Computer Use

    playwright_cli(session, command, args)
    desktop(session, command, ...)

Browser and Desktop are first-class MCP services rather than Workspace-scoped process adapters. They run without Junius-specific four-way permission widgets; named Browser and Desktop sessions are isolated by Chat. Desktop provides a visible Exit button to stop local control and retains the control_begin/control_end lifecycle.

## Runtime topology

Junius is split into a stable Host and replaceable Workers.

    loopback HTTP :8787
          |
          +---- /mcp
          |
          +---- /__junius/host-health
          |
          +---- /__junius/supervisor
          |
          v
        Host
          |
          +---- active Worker
          |
          +---- retiring Worker(s)
                 retained for affinity,
                 in-flight work,
                 and rollback

The Host owns one fixed loopback HTTP listener and the routing state. Only /mcp is intended for the supported ChatGPT tunnel; /__junius/* remains local diagnostics.

Junius optimizes the two MCP traffic shapes separately. Bursty short work is collapsed into bounded server-side batches (`workspace_batch` and `run_commands`) and the Host/Worker MCP HTTP servers keep idle connections alive for reuse. Long-running process work is detached into Jobs: foreground commands are intentionally short, `start_job` returns immediately, and `wait_job` uses short polls that can return incremental stdout/stderr with cursors in the same response. The HTTP servers do not impose a response socket timeout, so protocol requests that legitimately take time are not killed by Junius itself.

Junius does not add a parallel WebSocket MCP transport. ChatGPT's supported remote MCP path is Streamable HTTP; OpenAI's WebSocket mode is a separate Responses API client transport, not a replacement transport for a ChatGPT custom MCP connection. A Host-to-Worker WebSocket would therefore leave the Secure MCP Tunnel hop unchanged while duplicating the local transport path.

The local supervisor diagnostic keeps a bounded per-request timeline for traffic that reaches `/mcp`. Each entry has one Host trace ID and records request/body handling, Worker acquisition and response timing, downstream response completion or premature close, the terminal outcome, and layered Host/Worker latency when available. The same trace captures the nearest local Secure MCP Tunnel health snapshots at request start and completion. This can distinguish a healthy local Host from a downstream disconnect or Worker/Host failure; a downstream close alone does not identify whether ChatGPT or the tunnel initiated it.

Each Worker listens on random loopback ports.

The Host injects a private high-entropy token into each Worker. Worker MCP and control endpoints reject requests that do not carry that exact token.

The Worker control listener is private infrastructure. It exposes only:

    GET  /__junius/worker-health
    POST /__junius/config-reload

It is not a user management API.

Host diagnostics share the same 8787 loopback listener as MCP:

    GET /__junius/host-health
    GET /__junius/supervisor

There is no separate Host control listener. Unknown Host paths return 404, and all other management interaction is through MCP tools.

## ChatGPT conversation observability panel

Junius registers a native ChatGPT conversation-panel entrypoint on its existing MCP server. The entrypoint uses the ChatGPT Plugin Extension `thread` surface and renders an MCP App resource beside the conversation; there is no browser extension or ChatGPT DOM injection.

The panel can be opened directly by the user from the ChatGPT UI or opened from chat by calling `junius_observability_panel`. There is no separate authorization state. Closing from chat uses `close_junius_test_window`, which emits a session-scoped one-shot close revision; a currently mounted panel observes the revision change and requests closure. A later manual reopen treats the current revision as its baseline and opens normally.

The panel has two tabs, and both are turn-first:

- **Tools** renders only turn accordions. A turn summary title is the current user prompt rendered on one line; every attached file or image is represented by the literal placeholder `[File]`. Expanding a turn first shows Skills actually used in that turn, then tool accordions grouped by tool name. A Skill is recorded as used only after a successful `read_skill`. Expanding a tool reveals each invocation in that turn, including its bounded input snapshot, status, time, and duration.
- **Logs** renders the same turn accordions. Expanding a turn shows its complete ordered event timeline from turn start through tool start/completion and Skill-use events to turn end. It does not group the timeline by tool and does not use the Audit stream as the panel log source.

Observability prefers the real MCP `mcp-session-id` whenever a request carries one. ChatGPT tool calls can arrive without that transport header, so Junius falls back to the documented `_meta["openai/session"]` anonymized conversation id, namespaced as an OpenAI logical observability session. A record is created on first use and updated as turns, tool calls, Skill uses, and panel state change. A successful MCP `DELETE` removes sessionful-transport records exactly. The modern protocol exposes no conversation-deletion event, so ChatGPT logical-session records cannot be synchronously deleted from MCP lifecycle alone. The persisted files live under the Junius runtime root at `observability/sessions`; filenames are SHA-256 hashes of session IDs. Each session keeps at most 200 turns. Worker replacement or restart can therefore restore monitoring history from disk instead of resetting the panel. Persisted monitor snapshots retain the actual prompt titles (with attachments shown as `[File]`) and bounded tool-call inputs/events, so the Tools and Logs tabs remain useful after a restart. These snapshots are stored locally and may contain sensitive text; retention is limited to seven days and at most 256 sessions. Already-obscured older entries cannot be reconstructed from their placeholders.

Junius owns the turn model instead of depending on an OpenAI turn identifier. For every user message that will use Junius, the calling assistant must invoke `junius_turn_begin` before the first other Junius tool and `junius_turn_end` after the final Junius tool. `junius_turn_begin` receives ordered prompt parts: exact user-authored text parts and one file part per attachment. Junius converts each file part to the literal `[File]` title placeholder. Turn boundary tools are internal plumbing and are excluded from tool statistics.

After each turn begins, the assistant must discover installed Skills with `list_skills`, match their descriptions against the current task, and `read_skill` for every applicable Skill before substantive task tools. Global Skills participate in every Workspace; effective Workspace overrides remain authoritative. This makes Skill activation responsive to installation/removal and gives the monitor a factual Skill-use event.

Before any consequential tool call in the same turn, the assistant must call `junius_task_review` with the user's actual objective, work scope and non-goals, risks including alternate paths, and observable verification. The common tool-call boundary refuses potentially state-changing operations if this checkpoint was not recorded for the **active** turn. Read-only discovery stays available, as do cancellation and emergency window closing. A new turn cannot inherit a prior review. Review content is recorded as an ordinary tool invocation; this is a procedural guard, **not** a semantic proof of design quality, a grant to expand the user's requested task, or user approval of material choices.

Every ordinary MCP tool invocation passes through one common observation hook. The hook attaches the call to the active Junius turn for the current MCP session, captures a bounded input snapshot so repeated calls to the same tool can be distinguished, and records ordered start/completion events. These observability inputs are stored only in the session observability record and are not copied into the persistent Audit store. If an ordinary tool arrives without an active `junius_turn_begin`, Junius refuses to execute it and tells the caller to begin the turn first. Every ordinary tool result also reminds the caller to invoke `junius_turn_end` before the final assistant answer when no further Junius tool call is needed. Starting a new explicit turn closes any unfinished prior turn in that MCP session as a recovery path.

The UI uses the standard MCP Apps bridge for `ui/initialize` and app-initiated `tools/call`. ChatGPT-specific metadata is used only for the conversation-panel entrypoint and optional widget state.

The panel resource is part of the validated source fingerprint, source snapshot, compiled runtime, and GitHub Release payload so UI-only changes follow the same validation and last-known-good rules as the rest of Junius.

## Workspace persistence

Workspace state is stored independently from the repository.

Current schema:

    {
      version: 2,
      workspaces: [
        {
          id,
          rootPath
        }
      ]
    }

The loader accepts historical Workspace records containing additional fields. Only id and rootPath are retained in the current in-memory model and in subsequent writes.

The default path is platform-specific local state under Junius.

The path can be overridden through JUNIUS_WORKSPACE_STATE_PATH.

### Cross-Worker mutation barrier

create_workspace and delete_workspace mutate shared persisted configuration.

A successful mutation follows:

    MCP mutation reaches one Worker
      ↓
    Worker updates WorkspaceManager
      ↓
    Worker persists workspace-state.json
      ↓
    Host captures successful MCP response
      ↓
    Host advances configuration epoch
      ↓
    every other live Worker reloads state
      ↓
    only then is the MCP result returned

If a live Worker cannot reload, the Host quarantines it instead of allowing it to continue with stale Workspace state.

A candidate Worker that races with a configuration epoch change is refreshed before promotion.

## Command execution

run_command performs only one pre-launch routing check:

    Is the selected Workspace registered?

If it is, Junius prepares:

    executable = caller value
    args       = caller vector
    cwd        = Workspace root
    env        = inherited Junius process environment
    shell      = false

There is no executable registry and no per-argument authorization layer.

### Synchronous bounds

The synchronous process executor keeps engineering limits that prevent execution bookkeeping from becoming unbounded:

- execution timeout;
- captured-output limit;
- stdout/stderr capture;
- exit code and signal reporting;
- forced process-tree termination.

These controls do not decide whether a command is acceptable. They only bound the execution mechanism.

### Process termination

Forced-stop paths share the common process-termination primitive.

On Windows Junius invokes the system taskkill executable with descendant-tree termination.

On other platforms the current implementation terminates the direct child with SIGTERM and then SIGKILL fallback.

## Job architecture

JobManager starts the same PreparedProcess shape used by direct execution.

A Job record contains:

    id
    workspace
    executable
    pid
    timestamps
    status
    captured output
    truncation state

Terminal state is persisted separately from the live process.

### Windows guardian

On Windows background Jobs run through the Junius guardian path.

The guardian creates a Windows Job Object configured so descendants are killed if ownership is lost. This provides crash containment when the Worker or Host disappears.

Cancellation still uses the shared process-tree termination primitive.

### Persistent history

Current terminal Job history uses schema version 2 and records executable instead of the historical command key.

The reader accepts historical version 1 metadata and running markers and normalizes the old key field into executable.

Terminal history can be lazy-loaded by a later Worker.

Running markers let startup recovery convert abandoned Jobs into interrupted terminal records.

## Resource affinity

Hot Worker replacement is safe only if process-local resources continue to reach the Worker that owns them.

### MCP sessions

MCP session IDs are bound to the Worker that created them.

Routes have an idle TTL so abandoned sessions cannot pin a Worker forever.

### Jobs

A newly returned Job ID is bound to its creating Worker.

Running Jobs have no normal idle expiry.

When terminal state is reported, affinity enters a fallback retention period.

After history persistence is confirmed, Job affinity can be released because later reads can load shared terminal history.

### Browser sessions

Named Browser sessions bind to their owning Worker.

Browser affinity is bounded by idle cleanup.

### Desktop control sessions

A successful desktop control_begin binds:

    desktop:<session>

to the owning Worker.

Every later Desktop call for the same session routes to that Worker even after another Worker becomes active.

A successful control_end releases the binding.

Desktop binding has no arbitrary idle TTL because the task lifecycle is explicit.

If the owning Worker exits, its affinity and helper disappear as the crash fallback.

## Browser architecture

The Browser service exposes the full installed Playwright CLI command surface.

Junius uses a persistent broker when available and provides a persistent Browser state directory. It does not inject --persistent or other browser-behavior options; persistence semantics follow the caller's Playwright CLI command and arguments.

For each MCP call Junius constructs:

    -s=<session>
    <command>
    ...<args>

The command and argument vector are not checked against a Junius whitelist and are not rewritten. This means the Browser surface tracks the capabilities of the installed Playwright CLI version, including eval/run-code, storage and cookie operations, network inspection/routing, recording/tracing/video, WebMCP, attach/detach, install commands, and future CLI commands.

Named sessions are bounded and idle-cleaned. The Host keeps named Browser sessions Worker-affined across hot promotion.

Browser launcher discovery prefers the app-local @playwright/cli installation before the inherited command-search environment.

Browser audit persists the command name and argument count, but not the arbitrary Browser CLI argument vector.

Browser operations use the installed Playwright CLI's normal close and timeout handling. Junius does not register a physical Escape keyboard hook for Browser commands.

## Desktop architecture

Desktop perception is screenshot-based.

The persistent Python helper handles:

- top-level native window enumeration;
- full-screen and window screenshot capture;
- focus;
- coordinate mouse actions;
- first-class drag;
- explicit wait;
- mixed action_batch execution;
- optional post-batch screenshot capture;
- keyboard actions;
- key macros;
- Unicode clipboard read/write;
- direct text input.

action_batch keeps the whole sequence inside one helper request. Explicit wait plus drag durations are bounded, and keys/buttons held by the batch are released in a finally path. screenshot_after turns the same call into an act → observe round trip.

The Desktop banner has a clickable Exit button. Clicking it stops the active Desktop control sessions, and wait, drag, text input, key macros, and action batches cooperatively check the stopped-session state so held input is cleaned up normally. Physical Escape is not an interruption mechanism.

There is intentionally no accessibility-tree, UI Automation, or semantic-control dependency in Desktop perception. The visual model remains screenshot-only.

### Task-level takeover disclosure

Desktop control uses:

    control_begin(session)
      ↓
    zero or more actions
      ↓
    control_end(session)

The disclosure is therefore task-scoped, not action-scoped.

The persistent helper owns the user-visible native windows:

- a top-center banner localized to the current Windows UI language, indicating that ChatGPT is controlling the computer through Junius, with an adjacent clickable Exit button;
- four topmost click-through edge windows;
- breathing alpha animation on the edge windows.

Top/bottom edges own the corners. Left/right edges exclude the top and bottom edge thickness, preventing transparent-window overlap from making corners brighter.

The banner and edge effect stay visible while at least one control session is active.

## Built-in Workspace file boundary

The Workspace file subsystem has its own containment model.

It rejects:

- absolute user paths;
- parent traversal;
- canonicalized existing targets outside the Workspace;
- read traversal through links outside the Workspace;
- symbolic-link or junction write parents;
- the root .junius control directory;
- .git metadata at any depth;
- configured protected Junius runtime/state paths.

Transactional writes prepare all targets first, stage temporary content, perform commit renames, and attempt reverse rollback on commit failure.

This is best-effort transactional behavior and is not described as filesystem-level atomicity.

write parent chains are revalidated around commit to narrow path-replacement races.

rg prefers ripgrep when available, then falls back to `pwsh` and finally `cmd` on Windows. Every backend keeps Workspace target validation and protected-path exclusion authoritative, so user globs cannot re-enable reserved paths.

### AGENTS.md instruction preflight

The Workspace file subsystem discovers AGENTS.md without following symlinked directories or entering reserved/protected paths.

For a target path, Junius loads AGENTS.md from the Workspace root through each containing directory. For recursive scans, it additionally discovers nested AGENTS.md files inside the scan scope. Results are ordered from broadest to most deeply nested scope.

The instruction chain is hashed. Built-in mutation calls must supply the current hash as agents_digest when at least one AGENTS.md applies. A missing or stale digest produces agents_ack_required before any write is staged. The error includes the current digest and complete applicable instruction objects so the caller can apply them and retry.

This mechanism guarantees instruction discovery and pre-action acknowledgement. Junius does not parse natural-language AGENTS.md content into its own policy engine; the calling agent is responsible for following the instructions it was given. Direct system/developer/user instructions remain higher priority.

These restrictions apply only to built-in file tools.

A child process started by run_command or start_job is not confined by Workspace file-tool checks.

## Audit

Audit is shared observational state.

Events include bounded operation metadata such as:

    timestamp
    category
    action
    status
    Workspace
    subject
    duration
    bounded metadata

For arbitrary command and Job execution, the executable and argument count may be recorded, but raw arbitrary argument vectors are not persisted.

Audit also does not persist stdout/stderr content, file contents, edit text, screenshots, typed Browser/Desktop text, or clipboard text.

Browser navigation removes query and fragment components before audit persistence.

Audit failure does not alter the result of the underlying operation.

## Hot reload

Worker source changes follow:

    source change
      ↓
    full source validation
      ↓
    spawn candidate Worker
      ↓
    candidate ready IPC
      ↓
    private Worker health check
      ↓
    configuration epoch reconciliation
      ↓
    atomic promotion

Failure at validation, spawn, ready, health, or promotion leaves the existing active Worker in place.

The previous Worker is retained through a rollback window and until its affinity/in-flight work can drain.

A newly promoted Worker that exits within the rollback window can cause the Host to restore the previous live Worker.

## Host-only source boundary

Some source belongs to the stable Host and cannot be safely replaced by Worker hot reload.

The Host derives this boundary from the transitive relative-import graph rooted at the Host entry plus startup-control files.

A detected Host-only change marks restart-required rather than autonomously restarting the service.

A manual restart is required to use those changes.

## Last-known-good startup

The manual launcher first prefers the last validated bootstrap copy.

The bootstrap fingerprints source, Python helper code, package metadata, TypeScript configuration, and startup validation scripts.

A full successful check records a validation stamp for that exact source/runtime environment.

When source matches a validated release, the bootstrap can reuse that validation and start the release snapshot.

Candidate Host health is still required before persistent current-release pointers advance.

Failed validation or failed startup leaves the previous last-known-good release intact.

## Security model

Junius is not an operating-system sandbox.

The intended policy boundary is above Junius:

    user intent
      ↓
    calling assistant decision
      ↓
    Junius execution

Junius does not independently classify an executable or argument vector as safe, destructive, intended, or appropriate.

Processes run as the operating-system user that started Junius.

Therefore a launched process may access files outside its Workspace, network resources, registry state, credentials, desktop resources, or other services available to that user.

The Workspace root is cwd and the built-in file-tool root. It is not process confinement.

Loopback binding, Worker authentication, request bounds, process cleanup, transactional file handling, resource affinity, Desktop takeover disclosure, and Audit are system-integrity mechanisms. They are not substitutes for the caller's operation-level decision.

## Deferred design items

The following Chat-mode orchestration ideas are intentionally unresolved and are not part of the current Junius architecture:

- a persistent Goal object that outlives one Chat session;
- a Plan mode layered over a Goal, including explicit planning versus execution state;
- first-class ChatGPT entry points for Goal/Plan flows through plugin invocation surfaces such as `@` or the composer `+` menu;
- long-running Goal execution that is not bound to one foreground MCP tool-call lifetime;
- cross-Chat handoff so a later Chat session can resume the same Goal without depending on the previous Chat transcript or context window;
- controller/lease semantics for preventing two Chat sessions from concurrently driving the same persistent Goal.

No persistence model, public MCP API, agent-loop design, or ChatGPT UI integration for these ideas is frozen yet. They remain deferred until the product direction is revisited.

## Validation

The project-level check performs:

    bootstrap syntax validation
    TypeScript type checking
    complete automated tests
    source fingerprint validation commit

Command:

    pnpm run check
