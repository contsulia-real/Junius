from __future__ import annotations

import ctypes
import time
from typing import Any

from desktop_helper_common import (
    CF_UNICODETEXT,
    GMEM_MOVEABLE,
    DesktopHelperError,
    kernel32,
    user32,
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
