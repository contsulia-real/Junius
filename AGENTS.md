# Junius Repository Instructions

Scope: this entire repository.

## Product and architecture

- The project name is **Junius**.
- Junius is a personal/local MCP product for ChatGPT Plus and higher. Free and Go are not supported target tiers; do not add degraded or reduced-permission compatibility paths solely for those tiers unless the user explicitly changes the product scope.
- Junius is not intended for the public ChatGPT/Codex plugin directory. The supported connection model is a user-owned local Junius MCP server + OpenAI Secure MCP Tunnel + personal MCP/plugin connection created by the user. GitHub Releases remain the public software distribution channel.
- Junius is an execution service, not a policy engine. Do not introduce command allowlists, capability policy, or speculative safety layers unless the user explicitly changes that architecture.
- Do not invent material product or architecture decisions. Surface unresolved choices that change product behavior, public interfaces, persistence, compatibility, or architecture.
- Reuse existing execution paths, stores, helpers, and sources of truth before creating new ones. Do not maintain parallel implementations of the same behavior.
- Do not add compatibility layers without a concrete compatibility target.

## No god-files

- Do not create or expand catch-all files that own unrelated responsibilities.
- Judge god-files by responsibility concentration, not line count alone.
- A large cohesive module is acceptable when it owns one well-defined concern.
- If a touched file mixes separable responsibilities and a behavior-preserving split is directly relevant to the task, split along those responsibility boundaries instead of adding more unrelated logic.
- Do not split files merely to reduce line count, and do not replace one god-file with tiny pass-through modules, circular dependencies, duplicated helpers, or multiple sources of truth.

## Browser and Desktop privacy

- Never access, inspect, screenshot, enumerate, or control the user's real local Desktop unless the **current user request** explicitly asks ChatGPT to control the local computer.
- Never access, inspect, enumerate, or control the user's real local Browser unless the **current user request** explicitly asks ChatGPT to control the browser.
- Previous authorization does not carry forward.
- Engineering tests must use fake/synthetic helpers by default. Live Desktop access remains explicitly gated.

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
