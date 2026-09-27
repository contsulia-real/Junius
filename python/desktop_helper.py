from __future__ import annotations

import base64
import ctypes
import io
import json
import sys
from ctypes import wintypes
from typing import Any

import pyautogui
from pywinauto import Desktop

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.03

MAX_INSPECT_NODES = 500

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
ULONG_PTR = wintypes.WPARAM


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
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def rect_dict(rect: Any) -> dict[str, int]:
    return {
        "left": int(rect.left),
        "top": int(rect.top),
        "right": int(rect.right),
        "bottom": int(rect.bottom),
        "width": int(rect.width()),
        "height": int(rect.height()),
    }


def window_wrapper(handle: int, backend: str = "uia") -> Any:
    try:
        return Desktop(backend=backend).window(handle=handle).wrapper_object()
    except Exception as error:
        raise DesktopHelperError(
            "window_not_found",
            f"Window handle is not available: {handle}",
        ) from error


def list_windows() -> dict[str, Any]:
    windows: list[dict[str, Any]] = []

    try:
        wrappers = Desktop(backend="win32").windows(visible_only=True)
    except Exception as error:
        raise DesktopHelperError(
            "windows_failed",
            str(error),
        ) from error

    for wrapper in wrappers:
        try:
            title = wrapper.window_text()
            rect = wrapper.rectangle()
            windows.append(
                {
                    "handle": int(wrapper.handle),
                    "title": title,
                    "className": wrapper.class_name(),
                    "rect": rect_dict(rect),
                    "enabled": bool(wrapper.is_enabled()),
                    "visible": bool(wrapper.is_visible()),
                    "active": bool(wrapper.has_focus()),
                }
            )
        except Exception:
            continue

    return {"windows": windows}


def resolve_element(handle: int, path: list[int]) -> Any:
    current = window_wrapper(handle, backend="uia")

    try:
        for index in path:
            children = current.children()
            if index < 0 or index >= len(children):
                raise DesktopHelperError(
                    "element_not_found",
                    "Desktop element path is stale.",
                )
            current = children[index]
    except DesktopHelperError:
        raise
    except Exception as error:
        raise DesktopHelperError(
            "element_not_found",
            "Desktop element is no longer available.",
        ) from error

    return current


def inspect_window(handle: int, depth: int) -> dict[str, Any]:
    root = window_wrapper(handle, backend="uia")
    elements: list[dict[str, Any]] = []

    def visit(wrapper: Any, path: list[int], remaining: int) -> None:
        if len(elements) >= MAX_INSPECT_NODES:
            return

        try:
            info = wrapper.element_info
            item: dict[str, Any] = {
                "path": path,
                "name": wrapper.window_text(),
                "controlType": getattr(info, "control_type", None),
                "automationId": getattr(info, "automation_id", None),
                "className": getattr(info, "class_name", None),
                "rect": rect_dict(wrapper.rectangle()),
                "enabled": bool(wrapper.is_enabled()),
                "visible": bool(wrapper.is_visible()),
            }
            elements.append(item)
        except Exception:
            return

        if remaining <= 0:
            return

        try:
            children = wrapper.children()
        except Exception:
            return

        for index, child in enumerate(children):
            if len(elements) >= MAX_INSPECT_NODES:
                break
            visit(child, [*path, index], remaining - 1)

    visit(root, [], depth)

    return {
        "handle": handle,
        "elements": elements,
        "truncated": len(elements) >= MAX_INSPECT_NODES,
    }


def element_action(command: str, handle: int, path: list[int], text: str | None) -> dict[str, Any]:
    element = resolve_element(handle, path)

    try:
        if command == "invoke":
            invoke = getattr(element, "invoke", None)
            if not callable(invoke):
                raise DesktopHelperError(
                    "pattern_not_supported",
                    "Element does not expose an invoke action.",
                )
            invoke()

        elif command == "set_value":
            if text is None:
                raise DesktopHelperError(
                    "invalid_request",
                    "set_value requires text.",
                )

            set_edit_text = getattr(element, "set_edit_text", None)
            set_value = getattr(element, "set_value", None)

            if callable(set_edit_text):
                set_edit_text(text)
            elif callable(set_value):
                set_value(text)
            else:
                raise DesktopHelperError(
                    "pattern_not_supported",
                    "Element does not expose a writable value action.",
                )

        elif command == "focus":
            element.set_focus()

        else:
            raise DesktopHelperError(
                "command_not_allowed",
                f"Unknown element action: {command}",
            )
    except DesktopHelperError:
        raise
    except Exception as error:
        raise DesktopHelperError(
            "desktop_action_failed",
            str(error),
        ) from error

    return {"performed": command}


def screenshot(handle: int | None) -> dict[str, Any]:
    if handle is None:
        width, height = pyautogui.size()
        origin_x = 0
        origin_y = 0
        image = pyautogui.screenshot()
    else:
        wrapper = window_wrapper(handle, backend="win32")
        rect = wrapper.rectangle()
        width = max(1, int(rect.width()))
        height = max(1, int(rect.height()))
        origin_x = int(rect.left)
        origin_y = int(rect.top)

        try:
            image = pyautogui.screenshot(
                region=(origin_x, origin_y, width, height)
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
            "data": base64.b64encode(output.getvalue()).decode("ascii"),
        },
        "region": {
            "left": origin_x,
            "top": origin_y,
            "width": width,
            "height": height,
        },
    }


def point(request: dict[str, Any]) -> tuple[int, int]:
    x = int(request["x"])
    y = int(request["y"])
    handle = request.get("handle")

    if handle is None:
        return x, y

    rect = window_wrapper(int(handle), backend="win32").rectangle()
    width = int(rect.width())
    height = int(rect.height())

    if x < 0 or y < 0 or x >= width or y >= height:
        raise DesktopHelperError(
            "point_outside_window",
            (
                "Window-relative coordinates are outside the target window: "
                f"({x}, {y}) not within 0..{max(0, width - 1)}, "
                f"0..{max(0, height - 1)}."
            ),
        )

    return int(rect.left) + x, int(rect.top) + y


def type_unicode(text: str) -> None:
    if not text:
        return

    utf16 = text.encode("utf-16-le")
    units = [
        int.from_bytes(utf16[index:index + 2], "little")
        for index in range(0, len(utf16), 2)
    ]

    for unit in units:
        for flags in (
            KEYEVENTF_UNICODE,
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
        ):
            keyboard = KeyboardInput(
                wVk=0,
                wScan=unit,
                dwFlags=flags,
                time=0,
                dwExtraInfo=0,
            )
            event = Input(type=INPUT_KEYBOARD, ki=keyboard)
            sent = ctypes.windll.user32.SendInput(
                1,
                ctypes.byref(event),
                ctypes.sizeof(Input),
            )
            if sent != 1:
                raise DesktopHelperError(
                    "unicode_input_failed",
                    "Windows SendInput failed while typing Unicode text.",
                )


def input_action(command: str, request: dict[str, Any]) -> dict[str, Any]:
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
                clicks=int(request.get("clicks", 1)),
                button=str(request.get("button", "left")),
            )
            return {"x": x, "y": y}

        if command == "mouse_down":
            x, y = point(request)
            pyautogui.mouseDown(
                x=x,
                y=y,
                button=str(request.get("button", "left")),
            )
            return {"x": x, "y": y}

        if command == "mouse_up":
            x, y = point(request)
            pyautogui.mouseUp(
                x=x,
                y=y,
                button=str(request.get("button", "left")),
            )
            return {"x": x, "y": y}

        if command == "mouse_wheel":
            x, y = point(request)
            pyautogui.moveTo(x, y)
            pyautogui.scroll(int(request["amount"]))
            return {"x": x, "y": y, "amount": int(request["amount"])}

        if command == "key_press":
            pyautogui.press(str(request["key"]))
            return {"key": str(request["key"])}

        if command == "key_down":
            pyautogui.keyDown(str(request["key"]))
            return {"key": str(request["key"])}

        if command == "key_up":
            pyautogui.keyUp(str(request["key"]))
            return {"key": str(request["key"])}

        if command == "type":
            text = str(request["text"])
            type_unicode(text)
            return {"characters": len(text)}

        if command == "focus_window":
            handle = int(request["handle"])
            window_wrapper(handle, backend="win32").set_focus()
            return {"handle": handle}

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


def execute(request: dict[str, Any]) -> dict[str, Any]:
    command = request.get("command")

    if command == "windows":
        return list_windows()

    if command == "screenshot":
        handle = request.get("handle")
        return screenshot(None if handle is None else int(handle))

    if command == "inspect":
        return inspect_window(
            int(request["handle"]),
            int(request.get("depth", 3)),
        )

    if command in {"invoke", "set_value", "focus"}:
        return element_action(
            str(command),
            int(request["handle"]),
            [int(index) for index in request["path"]],
            None if "text" not in request else str(request["text"]),
        )

    if command in {
        "mouse_move",
        "mouse_click",
        "mouse_down",
        "mouse_up",
        "mouse_wheel",
        "key_press",
        "key_down",
        "key_up",
        "type",
        "focus_window",
    }:
        return input_action(str(command), request)

    raise DesktopHelperError(
        "command_not_allowed",
        f"Desktop command is not allowed: {command}",
    )


def main() -> None:
    try:
        raw = sys.stdin.read()
        if not raw:
            raise DesktopHelperError(
                "invalid_request",
                "Desktop helper requires a JSON request on stdin.",
            )

        request = json.loads(raw)
        if not isinstance(request, dict):
            raise DesktopHelperError(
                "invalid_request",
                "Desktop helper request must be an object.",
            )

        result = execute(request)
        sys.stdout.write(
            json.dumps(
                {"ok": True, "result": result},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    except DesktopHelperError as error:
        sys.stdout.write(
            json.dumps(
                {
                    "ok": False,
                    "code": error.code,
                    "message": str(error),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    except Exception as error:
        sys.stdout.write(
            json.dumps(
                {
                    "ok": False,
                    "code": "helper_failed",
                    "message": str(error),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )


if __name__ == "__main__":
    main()
