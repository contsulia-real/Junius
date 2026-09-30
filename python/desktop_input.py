from __future__ import annotations

import ctypes
import time
from ctypes import wintypes
from typing import Any, Callable

from desktop_clipboard import (
    clipboard_read,
    clipboard_write,
)
from desktop_helper_common import (
    INPUT_KEYBOARD,
    KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE,
    SW_RESTORE,
    DesktopHelperError,
    Input,
    KeyboardInput,
    pyautogui,
    user32,
)
from desktop_windows import (
    screenshot,
    window_rect,
)

def point(
    request: dict[str, Any],
) -> tuple[int, int]:
    x = int(request["x"])
    y = int(request["y"])
    handle = request.get("handle")

    if handle is None:
        return x, y

    left, top, right, bottom = window_rect(
        int(handle)
    )
    width = right - left
    height = bottom - top

    if (
        x < 0
        or y < 0
        or x >= width
        or y >= height
    ):
        raise DesktopHelperError(
            "point_outside_window",
            (
                "Window-relative coordinates are outside "
                "the target window: "
                f"({x}, {y}) not within "
                f"0..{max(0, width - 1)}, "
                f"0..{max(0, height - 1)}."
            ),
        )

    return left + x, top + y


InterruptCheck = Callable[[], None]


def no_interrupt() -> None:
    return


def type_unicode(
    text: str,
    interrupt_check: InterruptCheck = no_interrupt,
) -> None:
    if not text:
        return

    utf16 = text.encode("utf-16-le")
    units = [
        int.from_bytes(
            utf16[index : index + 2],
            "little",
        )
        for index in range(
            0,
            len(utf16),
            2,
        )
    ]

    for unit in units:
        interrupt_check()
        for flags in (
            KEYEVENTF_UNICODE,
            KEYEVENTF_UNICODE
            | KEYEVENTF_KEYUP,
        ):
            keyboard = KeyboardInput(
                wVk=0,
                wScan=unit,
                dwFlags=flags,
                time=0,
                dwExtraInfo=0,
            )
            event = Input(
                type=INPUT_KEYBOARD,
                ki=keyboard,
            )
            sent = user32.SendInput(
                1,
                ctypes.byref(event),
                ctypes.sizeof(Input),
            )
            if sent != 1:
                raise DesktopHelperError(
                    "unicode_input_failed",
                    (
                        "Windows SendInput failed "
                        "while typing Unicode text."
                    ),
                )



def key_macro(
    steps: list[dict[str, Any]],
    interrupt_check: InterruptCheck = no_interrupt,
) -> dict[str, Any]:
    held_keys: list[str] = []

    try:
        for step in steps:
            interrupt_check()
            action = str(step["action"])
            key = str(step["key"])

            if action == "key_press":
                pyautogui.press(key)
                continue

            if action == "key_down":
                pyautogui.keyDown(key)
                held_keys.append(key)
                continue

            if action == "key_up":
                pyautogui.keyUp(key)
                for index in range(
                    len(held_keys) - 1,
                    -1,
                    -1,
                ):
                    if held_keys[index] == key:
                        del held_keys[index]
                        break
                continue

            raise DesktopHelperError(
                "invalid_macro_step",
                (
                    "Unsupported keyboard macro action: "
                    f"{action}"
                ),
            )
    finally:
        for key in reversed(held_keys):
            try:
                pyautogui.keyUp(key)
            except Exception:
                pass

    return {
        "steps": len(steps),
    }


def focus_window(
    handle: int,
) -> dict[str, Any]:
    hwnd = wintypes.HWND(handle)
    if not user32.IsWindow(hwnd):
        raise DesktopHelperError(
            "window_not_found",
            f"Window handle is not available: {handle}",
        )

    user32.ShowWindow(
        hwnd,
        SW_RESTORE,
    )
    user32.BringWindowToTop(hwnd)
    focused = bool(
        user32.SetForegroundWindow(hwnd)
    )

    if not focused:
        raise DesktopHelperError(
            "focus_failed",
            (
                "Windows rejected foreground focus "
                f"for window: {handle}"
            ),
        )

    return {
        "handle": handle,
        "active": (
            int(
                user32.GetForegroundWindow()
                or 0
            )
            == handle
        ),
    }


def wait_action(
    duration_ms: int,
    interrupt_check: InterruptCheck = no_interrupt,
) -> dict[str, Any]:
    deadline = time.perf_counter() + (
        duration_ms / 1000.0
    )
    while True:
        interrupt_check()
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            break
        time.sleep(min(0.02, remaining))
    interrupt_check()
    return {"durationMs": duration_ms}


def drag_action(
    request: dict[str, Any],
    interrupt_check: InterruptCheck = no_interrupt,
) -> dict[str, Any]:
    start_x, start_y = point(request)
    destination: dict[str, Any] = {
        "x": int(request["to_x"]),
        "y": int(request["to_y"]),
    }
    if request.get("handle") is not None:
        destination["handle"] = int(
            request["handle"]
        )
    end_x, end_y = point(destination)

    button = str(
        request.get(
            "button",
            "left",
        )
    )
    duration_ms = int(
        request.get(
            "duration_ms",
            0,
        )
    )
    interrupt_check()
    pyautogui.moveTo(
        start_x,
        start_y,
    )
    pyautogui.mouseDown(button=button)
    try:
        if duration_ms <= 0:
            interrupt_check()
            user32.SetCursorPos(
                end_x,
                end_y,
            )
        else:
            started_at = time.perf_counter()
            duration_seconds = (
                duration_ms / 1000.0
            )
            while True:
                interrupt_check()
                progress = min(
                    1.0,
                    (
                        time.perf_counter()
                        - started_at
                    )
                    / duration_seconds,
                )
                user32.SetCursorPos(
                    round(
                        start_x
                        + (end_x - start_x)
                        * progress
                    ),
                    round(
                        start_y
                        + (end_y - start_y)
                        * progress
                    ),
                )
                if progress >= 1.0:
                    break
                time.sleep(0.02)
    finally:
        pyautogui.mouseUp(button=button)
    interrupt_check()
    return {
        "from": {
            "x": start_x,
            "y": start_y,
        },
        "to": {
            "x": end_x,
            "y": end_y,
        },
        "button": button,
        "durationMs": duration_ms,
    }


def action_batch(
    actions: list[dict[str, Any]],
    screenshot_after: bool,
    screenshot_handle: int | None,
    interrupt_check: InterruptCheck = no_interrupt,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    held_keys: list[str] = []
    held_buttons: list[str] = []

    try:
        for action in actions:
            interrupt_check()
            command = str(
                action["action"]
            )

            if command == "wait":
                result = wait_action(
                    int(
                        action[
                            "duration_ms"
                        ]
                    ),
                    interrupt_check,
                )
            elif command == "drag":
                result = drag_action(
                    action,
                    interrupt_check,
                )
            elif command == "key_down":
                key = str(
                    action["key"]
                )
                pyautogui.keyDown(key)
                held_keys.append(key)
                result = {"key": key}
            elif command == "key_up":
                key = str(
                    action["key"]
                )
                pyautogui.keyUp(key)
                for index in range(
                    len(held_keys) - 1,
                    -1,
                    -1,
                ):
                    if (
                        held_keys[index]
                        == key
                    ):
                        del held_keys[index]
                        break
                result = {"key": key}
            elif command == "mouse_down":
                x, y = point(action)
                button = str(
                    action.get(
                        "button",
                        "left",
                    )
                )
                pyautogui.mouseDown(
                    x=x,
                    y=y,
                    button=button,
                )
                held_buttons.append(
                    button
                )
                result = {
                    "x": x,
                    "y": y,
                    "button": button,
                }
            elif command == "mouse_up":
                x, y = point(action)
                button = str(
                    action.get(
                        "button",
                        "left",
                    )
                )
                pyautogui.mouseUp(
                    x=x,
                    y=y,
                    button=button,
                )
                for index in range(
                    len(held_buttons) - 1,
                    -1,
                    -1,
                ):
                    if (
                        held_buttons[index]
                        == button
                    ):
                        del held_buttons[
                            index
                        ]
                        break
                result = {
                    "x": x,
                    "y": y,
                    "button": button,
                }
            else:
                result = input_action(
                    command,
                    action,
                    interrupt_check,
                )

            results.append(
                {
                    "action": command,
                    "result": result,
                }
            )
    finally:
        for key in reversed(
            held_keys
        ):
            try:
                pyautogui.keyUp(key)
            except Exception:
                pass
        for button in reversed(
            held_buttons
        ):
            try:
                pyautogui.mouseUp(
                    button=button
                )
            except Exception:
                pass

    interrupt_check()
    response: dict[str, Any] = {
        "actions": results,
        "actionCount": len(
            actions
        ),
    }
    if screenshot_after:
        response.update(
            screenshot(
                screenshot_handle
            )
        )
    return response


def input_action(
    command: str,
    request: dict[str, Any],
    interrupt_check: InterruptCheck = no_interrupt,
) -> dict[str, Any]:
    try:
        interrupt_check()
        if command == "mouse_move":
            x, y = point(request)
            pyautogui.moveTo(x, y)
            return {"x": x, "y": y}

        if command == "mouse_click":
            x, y = point(request)
            pyautogui.click(
                x=x,
                y=y,
                clicks=int(
                    request.get(
                        "clicks",
                        1,
                    )
                ),
                button=str(
                    request.get(
                        "button",
                        "left",
                    )
                ),
            )
            return {"x": x, "y": y}

        if command == "mouse_down":
            x, y = point(request)
            pyautogui.mouseDown(
                x=x,
                y=y,
                button=str(
                    request.get(
                        "button",
                        "left",
                    )
                ),
            )
            return {"x": x, "y": y}

        if command == "mouse_up":
            x, y = point(request)
            pyautogui.mouseUp(
                x=x,
                y=y,
                button=str(
                    request.get(
                        "button",
                        "left",
                    )
                ),
            )
            return {"x": x, "y": y}

        if command == "mouse_wheel":
            x, y = point(request)
            pyautogui.moveTo(x, y)
            pyautogui.scroll(
                int(request["amount"])
            )
            return {
                "x": x,
                "y": y,
                "amount": int(
                    request["amount"]
                ),
            }

        if command == "drag":
            return drag_action(
                request,
                interrupt_check,
            )

        if command == "wait":
            return wait_action(
                int(
                    request[
                        "duration_ms"
                    ]
                ),
                interrupt_check,
            )

        if command == "key_press":
            key = str(request["key"])
            pyautogui.press(key)
            return {"key": key}

        if command == "key_down":
            key = str(request["key"])
            pyautogui.keyDown(key)
            return {"key": key}

        if command == "key_up":
            key = str(request["key"])
            pyautogui.keyUp(key)
            return {"key": key}

        if command == "key_macro":
            steps = request["steps"]
            if not isinstance(steps, list):
                raise DesktopHelperError(
                    "invalid_macro_steps",
                    "Keyboard macro steps must be a list.",
                )
            return key_macro(
                steps,
                interrupt_check,
            )

        if command == "clipboard_read":
            return clipboard_read()

        if command == "clipboard_write":
            text = str(request["text"])
            return clipboard_write(text)

        if command == "type":
            text = str(request["text"])
            type_unicode(
                text,
                interrupt_check,
            )
            return {
                "characters": len(text)
            }

        if command == "focus_window":
            return focus_window(
                int(request["handle"])
            )

    except DesktopHelperError:
        raise
    except Exception as error:
        raise DesktopHelperError(
            "desktop_action_failed",
            str(error),
        ) from error

    raise DesktopHelperError(
        "command_not_allowed",
        f"Unknown input action: {command}",
    )
