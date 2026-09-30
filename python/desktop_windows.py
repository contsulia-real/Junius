from __future__ import annotations

import base64
import ctypes
import io
from ctypes import wintypes
from typing import Any

from desktop_helper_common import (
    DesktopHelperError,
    pyautogui,
    user32,
)

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
