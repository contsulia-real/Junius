from __future__ import annotations

import ctypes
import json
import sys
import threading
from ctypes import wintypes
from typing import Callable


WH_KEYBOARD_LL = 13
WM_KEYDOWN = 0x0100
WM_SYSKEYDOWN = 0x0104
WM_QUIT = 0x0012
VK_ESCAPE = 0x1B
LLKHF_LOWER_IL_INJECTED = 0x00000002
LLKHF_INJECTED = 0x00000010


class KbdLlHookStruct(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


HookProc = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t,
    ctypes.c_int,
    wintypes.WPARAM,
    wintypes.LPARAM,
)

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

user32.SetWindowsHookExW.argtypes = [
    ctypes.c_int,
    HookProc,
    wintypes.HINSTANCE,
    wintypes.DWORD,
]
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.CallNextHookEx.argtypes = [
    wintypes.HHOOK,
    ctypes.c_int,
    wintypes.WPARAM,
    wintypes.LPARAM,
]
user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
user32.UnhookWindowsHookEx.restype = wintypes.BOOL
user32.GetMessageW.argtypes = [
    ctypes.POINTER(wintypes.MSG),
    wintypes.HWND,
    wintypes.UINT,
    wintypes.UINT,
]
user32.GetMessageW.restype = ctypes.c_int
user32.PostThreadMessageW.argtypes = [
    wintypes.DWORD,
    wintypes.UINT,
    wintypes.WPARAM,
    wintypes.LPARAM,
]
user32.PostThreadMessageW.restype = wintypes.BOOL


def is_physical_escape(
    vk_code: int,
    message: int,
    flags: int,
) -> bool:
    return (
        vk_code == VK_ESCAPE
        and message in (WM_KEYDOWN, WM_SYSKEYDOWN)
        and flags
        & (
            LLKHF_INJECTED
            | LLKHF_LOWER_IL_INJECTED
        )
        == 0
    )


class EscapeInterruptMonitor:
    def __init__(
        self,
        on_escape: Callable[[], None] | None = None,
    ) -> None:
        self._on_escape = on_escape
        self._event = threading.Event()
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._hook = None
        self._hook_proc = None
        self._startup_error: BaseException | None = None

    def start(self) -> None:
        if self._thread is not None:
            return

        self._thread = threading.Thread(
            target=self._run,
            name="junius-escape-interrupt",
            daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(timeout=2.0):
            raise RuntimeError(
                "Escape interrupt monitor did not become ready."
            )
        if self._startup_error is not None:
            raise RuntimeError(
                "Escape interrupt monitor failed to start."
            ) from self._startup_error

    def clear(self) -> None:
        self._event.clear()

    def interrupted(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float) -> bool:
        return self._event.wait(timeout)

    def close(self) -> None:
        thread = self._thread
        if thread is None:
            return

        thread_id = self._thread_id
        if thread_id:
            user32.PostThreadMessageW(
                thread_id,
                WM_QUIT,
                0,
                0,
            )
        thread.join(timeout=1.0)
        self._thread = None
        self._thread_id = 0

    def _run(self) -> None:
        self._thread_id = int(
            kernel32.GetCurrentThreadId()
        )

        @HookProc
        def hook_proc(
            code: int,
            w_param: int,
            l_param: int,
        ) -> int:
            if code >= 0:
                info = ctypes.cast(
                    l_param,
                    ctypes.POINTER(
                        KbdLlHookStruct
                    ),
                ).contents
                if is_physical_escape(
                    int(info.vkCode),
                    int(w_param),
                    int(info.flags),
                ):
                    self._event.set()
                    if self._on_escape is not None:
                        try:
                            self._on_escape()
                        except Exception:
                            pass

            return int(
                user32.CallNextHookEx(
                    self._hook,
                    code,
                    w_param,
                    l_param,
                )
            )

        self._hook_proc = hook_proc
        try:
            self._hook = user32.SetWindowsHookExW(
                WH_KEYBOARD_LL,
                hook_proc,
                None,
                0,
            )
            if not self._hook:
                raise ctypes.WinError()
        except BaseException as error:
            self._startup_error = error
            self._ready.set()
            return

        self._ready.set()
        message = wintypes.MSG()
        try:
            while user32.GetMessageW(
                ctypes.byref(message),
                None,
                0,
                0,
            ) > 0:
                pass
        finally:
            if self._hook:
                user32.UnhookWindowsHookEx(
                    self._hook
                )
                self._hook = None


def stream_escape_events() -> int:
    output_lock = threading.Lock()

    def emit() -> None:
        with output_lock:
            sys.stdout.write(
                json.dumps(
                    {"event": "escape"},
                    separators=(",", ":"),
                )
                + "\n"
            )
            sys.stdout.flush()

    monitor = EscapeInterruptMonitor(emit)
    monitor.start()
    sys.stdout.write(
        json.dumps(
            {"event": "ready"},
            separators=(",", ":"),
        )
        + "\n"
    )
    sys.stdout.flush()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        return 0
    finally:
        monitor.close()
    return 0


def self_test() -> int:
    assert is_physical_escape(
        VK_ESCAPE,
        WM_KEYDOWN,
        0,
    )
    assert not is_physical_escape(
        VK_ESCAPE,
        WM_KEYDOWN,
        LLKHF_INJECTED,
    )
    assert not is_physical_escape(
        VK_ESCAPE,
        WM_KEYDOWN,
        LLKHF_LOWER_IL_INJECTED,
    )
    assert not is_physical_escape(
        0x41,
        WM_KEYDOWN,
        0,
    )
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    raise SystemExit(stream_escape_events())
