# Junius Repository Instructions

Scope: this entire repository.

## Product and architecture

- The project name is **Junius**.
- Junius supports **Windows only**. Linux, macOS, and every other operating system are unsupported product targets and must be rejected by Junius entrypoints rather than accommodated with fallback behavior.
- Junius is one product. Normal users install a Release and should be presented simply with **Junius**, not asked to choose between "development" and "production" editions. The installed Junius instance owns port **8787** and is the default tool for ordinary work, including editing the Junius repository itself. Source-tree development may use the test-only `pnpm dev` launcher on port **18787**; that source-test instance is an internal contributor mechanism and should be used only when the current user request explicitly asks to test, exercise, validate, or debug the source build.
- Junius is a personal/local MCP product for ChatGPT Plus and higher. Free and Go are not supported target tiers; do not add degraded or reduced-permission compatibility paths solely for those tiers unless the user explicitly changes the product scope.
- Junius is not intended for the public ChatGPT/Codex plugin directory. The supported connection model is a user-owned local Junius MCP server + OpenAI Secure MCP Tunnel + personal MCP/plugin connection created by the user. GitHub Releases remain the public software distribution channel.
- Junius is an execution service, not a policy engine. Do not introduce command allowlists, capability policy, or speculative safety layers unless the user explicitly changes that architecture.
- Do not invent material product or architecture decisions. Surface unresolved choices that change product behavior, public interfaces, persistence, compatibility, or architecture.
- Reuse existing execution paths, stores, helpers, and sources of truth before creating new ones. Do not maintain parallel implementations of the same behavior.
- Do not add compatibility layers without a concrete compatibility target.

## Product reasoning discipline

- Start from the complete user-facing action in Chat, not from the MCP schema, internal module boundaries, or the smallest API that is convenient to implement.
- Before designing a feature, write down the natural things a user would say to accomplish it and treat those as the primary behavioral contract.
- Junius is an execution service, not a primitive-only service. When the user has already chosen an action, deterministic mechanical steps needed to complete that action should normally be encapsulated by Junius instead of being pushed back onto ChatGPT as multi-call orchestration.
- The `execution service, not policy engine` rule limits Junius from making policy or product decisions for the user; it does not forbid high-level execution operations.
- Do not let an external protocol, SDK abstraction, or similarly named platform feature redefine the Junius product model. Establish the Junius user need first, then use external mechanisms only when they serve that need.
- Do not narrow a requested feature merely to minimize a first implementation. Before deferring something, distinguish an actually separate future feature from a normal input form, source, destination, or completion path of the requested user action.
- Common ways a user naturally supplies input in Chat, including local paths and remote URLs when relevant to the requested action, are part of the action unless the user explicitly excludes them or a real platform constraint prevents support.
- Avoid exposing deterministic plumbing as separate user-facing steps when one coherent Junius operation can own download, staging, validation, transformation, installation, cleanup, or similar mechanics.
- Ask the user only when a choice materially changes product behavior or intent. Do not force the user to enumerate obvious completion paths one at a time.
- When proposing scope, evaluate it from `user intent -> complete observable result -> deterministic execution chain -> internal implementation`, in that order.

## Release notes

- Starting with the next new Release after this rule was introduced, every Release must be documented in `CHANGELOG.md`.
- Before tagging a Release, move the relevant entries out of `## Unreleased` into an exact `## <package.version>` section. Release creation must fail when that section is missing or empty.
- Starting with `0.0.5-alpha`, Junius package versions and Git tags must not contain the `ChatGPT` brand or a `-ChatGPT` suffix. Historical tags/releases keep their original names.
- The GitHub Release body must contain **only** the changelog body for that exact package version. Do not use GitHub auto-generated notes, commit lists, contributor lists, installation instructions, duplicated asset lists, or unrelated prose in the Release body.
- Do not rewrite historical Releases merely to make them conform to this rule.

## No god-files

- Do not create or expand catch-all files that own unrelated responsibilities.
- Judge god-files by responsibility concentration, not line count alone.
- A large cohesive module is acceptable when it owns one well-defined concern.
- If a touched file mixes separable responsibilities and a behavior-preserving split is directly relevant to the task, split along those responsibility boundaries instead of adding more unrelated logic.
- Do not split files merely to reduce line count, and do not replace one god-file with tiny pass-through modules, circular dependencies, duplicated helpers, or multiple sources of truth.

## Browser and Desktop execution

- Junius does not impose an additional four-way consent panel, per-Chat permission gate, or special user authorization flag for Browser or Desktop. The user has explicitly chosen to remove this product-level restriction. `playwright_cli` and `desktop` run under the Windows account that owns the Junius instance.
- Retain per-Chat session separation, normal browser profile cleanup, the Desktop control_begin/control_end lifecycle, and the visible Desktop Exit button. Do not install physical Escape keyboard hooks for Computer Use. Never access unrelated device state merely because the tool is available; follow the user's requested task.
- Windows and platform permissions are independent of Junius and cannot be assumed disabled.
- Prefer the existing Junius Browser service, and do not silently install another browser automation dependency without a concrete task-related reason. Engineering tests should use synthetic helpers unless live GUI work is specifically requested.

## Deliberate execution boundary

- Before any consequential Junius tool call, inspect the relevant design using read-only tools and submit `junius_task_review` with the user's actual goal, scope/non-goals, risk and alternate paths, and verifiable result. The execution layer must refuse consequential tools without a per-turn review; this checkpoint is not proof of correctness or user authorization.
- A correction about rushed execution is a systemic design concern, not permission to modify unrelated project prompts or invent migrations/backups. Prioritize full task comprehension, ownership boundaries, alternative execution routes, and end-to-end verification over quickly patching the last observed symptom.
- Reject premature completion claims: passing tests proves only tested behavior; verify the original failure and state which installed or user-facing surfaces remain untested.

## Engineering workflow

- Inspect the real implementation path before changing behavior.
- Preserve unrelated user changes.
- Prefer focused RED -> GREEN regression coverage for confirmed bugs.
- Validate the real relevant surface when it can be exercised without violating Browser/Desktop privacy.
- Run `pnpm run check` before completing substantive engineering changes.
- Run `pnpm run check:release` when release/distribution inputs change.
- Review the final diff for duplicate logic, stale replacement paths, unintended scope expansion, and temporary artifacts.
- Keep commits coherent and verified.
- Do not push unless the user explicitly asks for a push.
