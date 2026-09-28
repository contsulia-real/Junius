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

## Public MCP model

The stable user-facing surface is MCP.

There is no management Web UI.

The public tools are grouped into five areas.

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

### Workspace file operations

    ls
    read
    write
    rg
    workspace_apply
    workspace_batch

All paths are Workspace-relative.

These tools implement their own path checks and do not delegate user paths to a shell.

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

Browser and Desktop are first-class MCP services rather than Workspace-scoped process adapters.

## Runtime topology

Junius is split into a stable Host and replaceable Workers.

    public MCP :8787
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

The Host owns the public listening ports and routing state.

Each Worker listens on random loopback ports.

The Host injects a private high-entropy token into each Worker. Worker MCP and control endpoints reject requests that do not carry that exact token.

The Worker control listener is private infrastructure. It exposes only:

    GET  /__junius/worker-health
    POST /__junius/config-reload

It is not a user management API.

The Host control listener remains loopback-only and exposes diagnostics such as:

    /__junius/host-health
    /__junius/supervisor

All other management interaction is through MCP tools.

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

The Browser service is a bounded adapter around Playwright CLI.

Junius uses a persistent broker when available and retains a persistent browser profile.

The adapter exposes normal browser interaction primitives but does not expose arbitrary code evaluation, CDP, raw request interception, or generic storage scripting.

Named sessions are bounded and idle-cleaned.

Browser launcher discovery uses the inherited command-search environment.

## Desktop architecture

Desktop perception is screenshot-based.

The persistent Python helper handles:

- top-level native window enumeration;
- full-screen and window screenshot capture;
- focus;
- coordinate mouse actions;
- keyboard actions;
- key macros;
- Unicode clipboard read/write;
- direct text input.

There is no accessibility-tree or semantic-control dependency in the current Desktop implementation.

### Task-level takeover disclosure

Desktop control uses:

    control_begin(session)
      ↓
    zero or more actions
      ↓
    control_end(session)

The disclosure is therefore task-scoped, not action-scoped.

The persistent helper owns the user-visible native windows:

- a top-center banner saying ChatGPT 正通过 Junius 操作电脑;
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

rg applies user globs before Junius protection globs so a user include rule cannot re-enable reserved paths.

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

## Validation

The project-level check performs:

    bootstrap syntax validation
    TypeScript type checking
    complete automated tests
    source fingerprint validation commit

Command:

    pnpm run check
