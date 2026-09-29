from __future__ import annotations

import base64
import ctypes
import io
import json
import sys
import time
from ctypes import wintypes
from typing import Any, Callable

import pyautogui

from desktop_indicator import DesktopActivityIndicator

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.03

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
SW_RESTORE = 9
ULONG_PTR = wintypes.WPARAM
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

kernel32.GlobalAlloc.argtypes = [
    wintypes.UINT,
    ctypes.c_size_t,
]
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [
    ctypes.c_void_p,
]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [
    ctypes.c_void_p,
]
kernel32.GlobalUnlock.restype = wintypes.BOOL
kernel32.GlobalFree.argtypes = [
    ctypes.c_void_p,
]
kernel32.GlobalFree.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = [
    wintypes.UINT,
    ctypes.c_void_p,
]
user32.SetClipboardData.restype = ctypes.c_void_p
user32.GetClipboardData.argtypes = [
    wintypes.UINT,
]
user32.GetClipboardData.restype = ctypes.c_void_p

ACTIVITY_INDICATOR = DesktopActivityIndicator()


class KeyboardInput(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class InputUnion(ctypes.Union):
    _fields_ = [("ki", KeyboardInput)]


class Input(ctypes.Structure):
    _anonymous_ = ("union",)
    _fields_ = [
        ("type", wintypes.DWORD),
        ("union", InputUnion),
    ]


class DesktopHelperError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
    ) -> None:
        super().__init__(message)
        self.code = code


def window_rect(
    handle: int,
) -> tuple[int, int, int, int]:
    hwnd = wintypes.HWND(handle)
    if not user32.IsWindow(hwnd):
        raise DesktopHelperError(
            "window_not_found",
            f"Window handle is not available: {handle}",
        )

    rect = wintypes.RECT()
    if not user32.GetWindowRect(
        hwnd,
        ctypes.byref(rect),
    ):
        raise DesktopHelperError(
            "window_rect_failed",
            f"Could not read window rectangle: {handle}",
        )

    return (
        int(rect.left),
        int(rect.top),
        int(rect.right),
        int(rect.bottom),
    )


def rect_dict(
    rect: tuple[int, int, int, int],
) -> dict[str, int]:
    left, top, right, bottom = rect
    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "width": max(0, right - left),
        "height": max(0, bottom - top),
    }


def window_text(handle: int) -> str:
    hwnd = wintypes.HWND(handle)
    length = int(
        user32.GetWindowTextLengthW(hwnd)
    )
    buffer = ctypes.create_unicode_buffer(
        max(1, length + 1)
    )
    user32.GetWindowTextW(
        hwnd,
        buffer,
        len(buffer),
    )
    return buffer.value


def window_class_name(handle: int) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(
        wintypes.HWND(handle),
        buffer,
        len(buffer),
    )
    return buffer.value


def list_windows() -> dict[str, Any]:
    windows: list[dict[str, Any]] = []
    foreground = int(
        user32.GetForegroundWindow() or 0
    )

    callback_type = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HWND,
        wintypes.LPARAM,
    )

    def visit(
        hwnd: wintypes.HWND,
        _lparam: wintypes.LPARAM,
    ) -> bool:
        handle = int(hwnd)
        if not user32.IsWindowVisible(hwnd):
            return True

        try:
            rect = window_rect(handle)
            windows.append(
                {
                    "handle": handle,
                    "title": window_text(handle),
                    "className": window_class_name(
                        handle
                    ),
                    "rect": rect_dict(rect),
                    "enabled": bool(
                        user32.IsWindowEnabled(hwnd)
                    ),
                    "visible": True,
                    "active": (
                        handle == foreground
                    ),
                }
            )
        except DesktopHelperError:
            pass

        return True

    callback = callback_type(visit)
    if not user32.EnumWindows(
        callback,
        0,
    ):
        raise DesktopHelperError(
            "windows_failed",
            "EnumWindows failed.",
        )

    return {"windows": windows}


def screenshot(
    handle: int | None,
) -> dict[str, Any]:
    if handle is None:
        width, height = pyautogui.size()
        origin_x = 0
        origin_y = 0
        image = pyautogui.screenshot()
    else:
        left, top, right, bottom = (
            window_rect(handle)
        )
        width = max(1, right - left)
        height = max(1, bottom - top)
        origin_x = left
        origin_y = top

        try:
            image = pyautogui.screenshot(
                region=(
                    origin_x,
                    origin_y,
                    width,
                    height,
                )
            )
        except Exception as error:
            raise DesktopHelperError(
                "screenshot_failed",
                str(error),
            ) from error

    output = io.BytesIO()
    image.convert("RGB").save(
        output,
        format="JPEG",
        quality=85,
        optimize=True,
    )

    return {
        "image": {
            "mimeType": "image/jpeg",
            "data": base64.b64encode(
                output.getvalue()
            ).decode("ascii"),
        },
        "region": {
            "left": origin_x,
            "top": origin_y,
            "width": int(width),
            "height": int(height),
        },
    }


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


def type_unicode(text: str) -> None:
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


def open_clipboard() -> None:
    for _attempt in range(20):
        if user32.OpenClipboard(None):
            return
        time.sleep(0.01)

    raise DesktopHelperError(
        "clipboard_open_failed",
        "Windows clipboard is currently unavailable.",
    )


def clipboard_read() -> dict[str, Any]:
    open_clipboard()
    try:
        if not user32.IsClipboardFormatAvailable(
            CF_UNICODETEXT
        ):
            raise DesktopHelperError(
                "clipboard_text_unavailable",
                (
                    "Windows clipboard does not contain "
                    "Unicode text."
                ),
            )

        handle = user32.GetClipboardData(
            CF_UNICODETEXT
        )
        if not handle:
            raise DesktopHelperError(
                "clipboard_read_failed",
                "Windows GetClipboardData failed.",
            )

        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            raise DesktopHelperError(
                "clipboard_read_failed",
                "Windows GlobalLock failed for clipboard text.",
            )

        try:
            text = ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)

        return {
            "text": text,
            "characters": len(text),
        }
    finally:
        user32.CloseClipboard()


def clipboard_write(text: str) -> dict[str, Any]:
    encoded = (text + "\0").encode("utf-16-le")
    memory = kernel32.GlobalAlloc(
        GMEM_MOVEABLE,
        len(encoded),
    )
    if not memory:
        raise DesktopHelperError(
            "clipboard_write_failed",
            "Windows GlobalAlloc failed for clipboard text.",
        )

    transferred = False
    try:
        pointer = kernel32.GlobalLock(memory)
        if not pointer:
            raise DesktopHelperError(
                "clipboard_write_failed",
                "Windows GlobalLock failed for clipboard text.",
            )

        try:
            ctypes.memmove(
                pointer,
                encoded,
                len(encoded),
            )
        finally:
            kernel32.GlobalUnlock(memory)

        open_clipboard()
        try:
            if not user32.EmptyClipboard():
                raise DesktopHelperError(
                    "clipboard_write_failed",
                    "Windows EmptyClipboard failed.",
                )

            if not user32.SetClipboardData(
                CF_UNICODETEXT,
                memory,
            ):
                raise DesktopHelperError(
                    "clipboard_write_failed",
                    "Windows SetClipboardData failed.",
                )
            transferred = True
        finally:
            user32.CloseClipboard()
    finally:
        if not transferred:
            kernel32.GlobalFree(memory)

    return {
        "characters": len(text),
    }


def key_macro(
    steps: list[dict[str, Any]],
) -> dict[str, Any]:
    held_keys: list[str] = []

    try:
        for step in steps:
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
) -> dict[str, Any]:
    time.sleep(duration_ms / 1000.0)
    return {"durationMs": duration_ms}


def drag_action(
    request: dict[str, Any],
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
    pyautogui.moveTo(
        start_x,
        start_y,
    )
    pyautogui.dragTo(
        end_x,
        end_y,
        duration=(
            duration_ms
            / 1000.0
        ),
        button=button,
    )
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
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    held_keys: list[str] = []
    held_buttons: list[str] = []

    try:
        for action in actions:
            command = str(
                action["action"]
            )

            if command == "wait":
                result = wait_action(
                    int(
                        action[
                            "duration_ms"
                        ]
                    )
                )
            elif command == "drag":
                result = drag_action(
                    action
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
) -> dict[str, Any]:
    try:
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
                request
            )

        if command == "wait":
            return wait_action(
                int(
                    request[
                        "duration_ms"
                    ]
                )
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
            return key_macro(steps)

        if command == "clipboard_read":
            return clipboard_read()

        if command == "clipboard_write":
            text = str(request["text"])
            return clipboard_write(text)

        if command == "type":
            text = str(request["text"])
            type_unicode(text)
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


def execute(
    request: dict[str, Any],
) -> dict[str, Any]:
    command = request.get("command")

    allowed_commands = {
        "control_begin",
        "control_end",
        "windows",
        "screenshot",
        "focus_window",
        "mouse_move",
        "mouse_click",
        "mouse_down",
        "mouse_up",
        "mouse_wheel",
        "drag",
        "wait",
        "action_batch",
        "key_press",
        "key_down",
        "key_up",
        "key_macro",
        "clipboard_read",
        "clipboard_write",
        "type",
    }

    session = str(
        request.get("session", "")
    )

    if command == "control_begin":
        try:
            ACTIVITY_INDICATOR.begin(session)
        except RuntimeError as error:
            raise DesktopHelperError(
                "activity_indicator_failed",
                str(error),
            ) from error
        return {
            "active": True,
            "session": session,
        }

    if command == "control_end":
        try:
            ACTIVITY_INDICATOR.end(session)
        except RuntimeError as error:
            raise DesktopHelperError(
                "activity_indicator_failed",
                str(error),
            ) from error
        return {
            "active": False,
            "session": session,
        }

    if (
        command in allowed_commands
        and not ACTIVITY_INDICATOR.is_active(
            session
        )
    ):
        raise DesktopHelperError(
            "control_not_started",
            (
                "Desktop control_begin must be called "
                "before desktop actions for this session."
            ),
        )

    if command == "windows":
        return list_windows()

    if command == "screenshot":
        handle = request.get("handle")
        return screenshot(
            None
            if handle is None
            else int(handle)
        )

    if command == "action_batch":
        actions = request.get(
            "actions"
        )
        if not isinstance(
            actions,
            list,
        ):
            raise DesktopHelperError(
                "invalid_batch_actions",
                (
                    "Desktop action batch "
                    "must be a list."
                ),
            )
        screenshot_handle = (
            request.get(
                "screenshot_handle"
            )
        )
        return action_batch(
            actions,
            bool(
                request.get(
                    "screenshot_after",
                    False,
                )
            ),
            (
                None
                if screenshot_handle
                is None
                else int(
                    screenshot_handle
                )
            ),
        )

    if command in {
        "mouse_move",
        "mouse_click",
        "mouse_down",
        "mouse_up",
        "mouse_wheel",
        "drag",
        "wait",
        "key_press",
        "key_down",
        "key_up",
        "key_macro",
        "clipboard_read",
        "clipboard_write",
        "type",
        "focus_window",
    }:
        return input_action(
            str(command),
            request,
        )

    raise DesktopHelperError(
        "command_not_allowed",
        (
            "Desktop command is not allowed: "
            f"{command}"
        ),
    )


def execute_response(
    request: Any,
) -> dict[str, Any]:
    try:
        if not isinstance(request, dict):
            raise DesktopHelperError(
                "invalid_request",
                (
                    "Desktop helper request "
                    "must be an object."
                ),
            )

        return {
            "ok": True,
            "result": execute(request),
        }
    except DesktopHelperError as error:
        return {
            "ok": False,
            "code": error.code,
            "message": str(error),
        }
    except Exception as error:
        return {
            "ok": False,
            "code": "helper_failed",
            "message": str(error),
        }


def write_response(
    response: dict[str, Any],
) -> None:
    sys.stdout.write(
        json.dumps(
            response,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def one_shot_main() -> None:
    raw = sys.stdin.read()
    if not raw:
        write_response(
            {
                "ok": False,
                "code": "invalid_request",
                "message": (
                    "Desktop helper requires a "
                    "JSON request on stdin."
                ),
            }
        )
        return

    try:
        request = json.loads(raw)
    except Exception as error:
        write_response(
            {
                "ok": False,
                "code": "invalid_request",
                "message": str(error),
            }
        )
        return

    write_response(
        execute_response(request)
    )


def server_main() -> None:
    write_response(
        {
            "id": 0,
            "ok": True,
            "result": {
                "ready": True,
            },
        }
    )
    sys.stdout.write("\n")
    sys.stdout.flush()

    for raw_line in sys.stdin:
        raw = raw_line.strip()
        if not raw:
            continue

        request_id: Any = None

        try:
            envelope = json.loads(raw)
            if not isinstance(
                envelope,
                dict,
            ):
                raise DesktopHelperError(
                    "invalid_request",
                    (
                        "Desktop helper server "
                        "envelope must be an object."
                    ),
                )

            request_id = envelope.get("id")
            response = execute_response(
                envelope.get("request")
            )
        except DesktopHelperError as error:
            response = {
                "ok": False,
                "code": error.code,
                "message": str(error),
            }
        except Exception as error:
            response = {
                "ok": False,
                "code": "invalid_request",
                "message": str(error),
            }

        write_response(
            {
                "id": request_id,
                **response,
            }
        )
        sys.stdout.write("\n")
        sys.stdout.flush()


def main() -> None:
    if "--server" in sys.argv[1:]:
        server_main()
        return

    one_shot_main()


if __name__ == "__main__":
    main()
