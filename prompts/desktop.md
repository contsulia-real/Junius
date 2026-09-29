# JUNIUS DESKTOP COMPUTER USE CONTRACT

The current task uses Junius Desktop Computer Use.

Desktop perception is screenshot-only.

Do not assume Windows UI Automation, accessibility trees, semantic controls, or hidden structured UI state.

## Control lifecycle

Every Desktop control task must use exactly one control lifecycle:

control_begin(session)
-> observe
-> act
-> observe
-> control_end(session)

Use the same session throughout the task.

If control_begin succeeded, always call control_end before finishing, including success, failure, inability to complete the task, or an unexpected application state.

Do not leave an active Desktop control scope behind.

## Establish the visible state first

Before acting, inspect the current Desktop state.

When the target native window is uncertain:
- use windows to enumerate top-level windows;
- use focus_window when explicit focus is required;
- use screenshot to establish the visual state.

Do not assume that the expected application or window is already active.

## Coordinate semantics

When a top-level window handle is supplied, screenshot and mouse coordinates are relative to that window.

Without a handle, coordinates are screen-relative.

Do not mix coordinate spaces.

## Primitive selection

Choose the most specific primitive for the intended action.

Use:
- mouse_move for pointer movement;
- mouse_click for one or more clicks at a point;
- mouse_down or mouse_up when explicit button state is required;
- mouse_wheel for scrolling;
- drag for a complete drag gesture;
- key_press for a simple key event;
- key_down or key_up only when explicit key state must span actions;
- key_macro for a bounded keyboard-only sequence or shortcut;
- clipboard_read or clipboard_write for Unicode clipboard interaction;
- type for direct text input where it is reliable;
- wait when the graphical interface genuinely needs time to settle;
- action_batch for a deterministic mixed sequence.

## key_macro

Prefer key_macro when a sequence contains only keyboard operations.

For a shortcut requiring held modifiers, use one macro rather than several independent MCP calls.

A macro may contain key_press, key_down, and key_up.

Junius releases keys still held by the macro before it returns, including on failure.

Do not use action_batch merely because multiple keyboard events are involved when key_macro expresses the operation more directly.

## action_batch

Use action_batch when several deterministic actions can safely execute in one helper round trip.

A batch may combine window focus, mouse move or click or down or up or wheel, drag, wait, keyboard events, key_macro, clipboard read or write, and text input.

Prefer a batch over many MCP round trips when no intermediate visual decision is required.

Do NOT batch across a point where the next action depends on what appears on screen. In that case, act -> screenshot -> decide -> act.

## Act -> observe

Use screenshot_after on action_batch when the resulting state can be observed immediately after the deterministic sequence.

Use screenshot_handle when only one top-level native window needs to be captured.

A successful input call does not prove that the application reacted as intended.

Do not claim that a click, double click, drag, keyboard shortcut, text entry, window focus, launch, navigation, menu selection, or dialog confirmation succeeded until the visible result has been observed.

## Waiting

Use wait only for real interface settling requirements such as application launch, animation, asynchronous view transition, delayed dialog, or operation completion.

Do not insert arbitrary sleeps when visual observation can determine readiness.

## Text input

Choose between type and clipboard based on reliability.

For Unicode text or applications where simulated direct typing is unreliable, prefer clipboard_write followed by a paste shortcut.

When a paste shortcut consists only of keyboard events, use key_macro.

Do not overwrite the user's clipboard unnecessarily.

## Failure handling

If an input action produces an unexpected result:
1. capture the new visible state;
2. determine what actually happened;
3. adapt the next action.

Do not blindly repeat the same coordinates or keystrokes.

## Cleanup

Before finishing:
- ensure any held input state has been released;
- ensure the Desktop control scope is closed with control_end;
- leave the application in the state requested by the user.

Desktop success means the requested visible state was actually observed.
