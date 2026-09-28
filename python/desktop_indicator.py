from __future__ import annotations

import ctypes
import math
import threading
import time
from ctypes import wintypes

ACTIVITY_INDICATOR_TEXT = (
    "ChatGPT 正通过 Junius 操作电脑"
)
WS_POPUP = 0x80000000
WS_BORDER = 0x00800000
SS_CENTER = 0x00000001
SS_CENTERIMAGE = 0x00000200
WM_SETFONT = 0x0030
WS_EX_TOPMOST = 0x00000008
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_LAYERED = 0x00080000
WS_EX_NOACTIVATE = 0x08000000

SW_HIDE = 0
SW_SHOWNOACTIVATE = 4
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040

LWA_ALPHA = 0x00000002
PM_REMOVE = 0x0001
WM_PAINT = 0x000F
WM_ERASEBKGND = 0x0014
WM_NCHITTEST = 0x0084
HTTRANSPARENT = -1

DT_CENTER = 0x00000001
DT_VCENTER = 0x00000004
DT_SINGLELINE = 0x00000020
DT_NOPREFIX = 0x00000800
TRANSPARENT = 1

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

EDGE_THICKNESS = 12
BANNER_WIDTH = 460
BANNER_HEIGHT = 48
BANNER_TOP_MARGIN = 16
PULSE_SECONDS = 1.8

CLASS_NAME = "JuniusDesktopActivityIndicatorWindow"
BANNER_KIND = "banner"

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(
    LRESULT,
    wintypes.HWND,
    wintypes.UINT,
    wintypes.WPARAM,
    wintypes.LPARAM,
)


class WndClassW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", ctypes.c_void_p),
        ("hIcon", ctypes.c_void_p),
        ("hCursor", ctypes.c_void_p),
        ("hbrBackground", ctypes.c_void_p),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


class PaintStruct(ctypes.Structure):
    _fields_ = [
        ("hdc", ctypes.c_void_p),
        ("fErase", wintypes.BOOL),
        ("rcPaint", wintypes.RECT),
        ("fRestore", wintypes.BOOL),
        ("fIncUpdate", wintypes.BOOL),
        ("rgbReserved", ctypes.c_byte * 32),
    ]


def rgb(
    red: int,
    green: int,
    blue: int,
) -> int:
    return (
        red
        | (green << 8)
        | (blue << 16)
    )


_WINDOW_KIND: dict[int, str] = {}
_EDGE_BRUSH = gdi32.CreateSolidBrush(
    rgb(16, 163, 127)
)
_BANNER_BRUSH = gdi32.CreateSolidBrush(
    rgb(24, 26, 30)
)
_BANNER_FONT = gdi32.CreateFontW(
    -20,
    0,
    0,
    0,
    600,
    0,
    0,
    0,
    1,
    0,
    0,
    5,
    0,
    "Segoe UI",
)


@WNDPROC
def _window_proc(
    hwnd: wintypes.HWND,
    message: int,
    wparam: int,
    lparam: int,
) -> int:
    handle = int(hwnd)

    if message == WM_NCHITTEST:
        return HTTRANSPARENT

    if message == WM_ERASEBKGND:
        return 1

    if message == WM_PAINT:
        paint = PaintStruct()
        hdc = user32.BeginPaint(
            hwnd,
            ctypes.byref(paint),
        )
        rect = wintypes.RECT()
        user32.GetClientRect(
            hwnd,
            ctypes.byref(rect),
        )

        kind = _WINDOW_KIND.get(
            handle,
            "edge",
        )

        user32.FillRect(
            hdc,
            ctypes.byref(rect),
            (
                _BANNER_BRUSH
                if kind == BANNER_KIND
                else _EDGE_BRUSH
            ),
        )

        if kind == BANNER_KIND:
            gdi32.SetBkMode(
                hdc,
                TRANSPARENT,
            )
            gdi32.SetTextColor(
                hdc,
                rgb(255, 255, 255),
            )
            previous_font = None
            if _BANNER_FONT:
                previous_font = gdi32.SelectObject(
                    hdc,
                    _BANNER_FONT,
                )

            user32.DrawTextW(
                hdc,
                ACTIVITY_INDICATOR_TEXT,
                -1,
                ctypes.byref(rect),
                (
                    DT_CENTER
                    | DT_VCENTER
                    | DT_SINGLELINE
                    | DT_NOPREFIX
                ),
            )

            if previous_font:
                gdi32.SelectObject(
                    hdc,
                    previous_font,
                )

        user32.EndPaint(
            hwnd,
            ctypes.byref(paint),
        )
        return 0

    return user32.DefWindowProcW(
        hwnd,
        message,
        wparam,
        lparam,
    )


class DesktopActivityIndicator:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._ready = threading.Event()
        self._shown = threading.Event()
        self._hidden = threading.Event()
        self._hidden.set()
        self._started = False
        self._visible = False
        self._active_sessions: set[str] = set()
        self._windows: list[int] = []
        self._error: str | None = None

    def begin(self, session: str) -> None:
        start_thread = False
        should_wait_for_show = False

        with self._lock:
            was_active = bool(
                self._active_sessions
            )
            self._active_sessions.add(session)
            if not self._started:
                self._started = True
                start_thread = True
            elif not was_active or not self._visible:
                self._shown.clear()
                should_wait_for_show = True

        if start_thread:
            threading.Thread(
                target=self._run,
                name="JuniusDesktopActivityIndicator",
                daemon=True,
            ).start()

        self._wake.set()

        if start_thread:
            if not self._ready.wait(timeout=1.0):
                raise RuntimeError(
                    (
                        "Timed out while creating the "
                        "Junius desktop activity indicator."
                    )
                )
        elif should_wait_for_show:
            if not self._shown.wait(timeout=0.25):
                raise RuntimeError(
                    (
                        "Timed out while showing the "
                        "Junius desktop activity indicator."
                    )
                )

        with self._lock:
            error = self._error
        if error is not None:
            raise RuntimeError(error)

    def end(self, session: str) -> None:
        should_wait_for_hide = False

        with self._lock:
            self._active_sessions.discard(session)
            if (
                self._started
                and self._visible
                and not self._active_sessions
            ):
                self._hidden.clear()
                should_wait_for_hide = True

        self._wake.set()

        if should_wait_for_hide:
            if not self._hidden.wait(timeout=0.25):
                raise RuntimeError(
                    (
                        "Timed out while hiding the "
                        "Junius desktop activity indicator."
                    )
                )

    def is_active(self, session: str) -> bool:
        with self._lock:
            return (
                session in self._active_sessions
            )

    def _register_window_class(self) -> None:
        window_class = WndClassW()
        window_class.lpfnWndProc = _window_proc
        window_class.hInstance = (
            kernel32.GetModuleHandleW(None)
        )
        window_class.lpszClassName = (
            CLASS_NAME
        )

        if not user32.RegisterClassW(
            ctypes.byref(window_class)
        ):
            raise RuntimeError(
                "Windows RegisterClassW failed."
            )

    def _virtual_screen(
        self,
    ) -> tuple[int, int, int, int]:
        return (
            int(
                user32.GetSystemMetrics(
                    SM_XVIRTUALSCREEN
                )
            ),
            int(
                user32.GetSystemMetrics(
                    SM_YVIRTUALSCREEN
                )
            ),
            int(
                user32.GetSystemMetrics(
                    SM_CXVIRTUALSCREEN
                )
            ),
            int(
                user32.GetSystemMetrics(
                    SM_CYVIRTUALSCREEN
                )
            ),
        )

    def _create_window(
        self,
        *,
        kind: str,
        title: str,
        x: int,
        y: int,
        width: int,
        height: int,
    ) -> int:
        is_banner = (
            kind == BANNER_KIND
        )
        hwnd = user32.CreateWindowExW(
            (
                WS_EX_TOPMOST
                | WS_EX_TRANSPARENT
                | WS_EX_TOOLWINDOW
                | WS_EX_LAYERED
                | WS_EX_NOACTIVATE
            ),
            (
                "STATIC"
                if is_banner
                else CLASS_NAME
            ),
            title,
            (
                WS_POPUP
                | (
                    WS_BORDER
                    | SS_CENTER
                    | SS_CENTERIMAGE
                    if is_banner
                    else 0
                )
            ),
            x,
            y,
            width,
            height,
            None,
            None,
            kernel32.GetModuleHandleW(
                None
            ),
            None,
        )
        if not hwnd:
            raise RuntimeError(
                "Windows CreateWindowExW failed."
            )

        handle = int(hwnd)
        _WINDOW_KIND[handle] = kind

        if is_banner and _BANNER_FONT:
            user32.SendMessageW(
                hwnd,
                WM_SETFONT,
                _BANNER_FONT,
                True,
            )

        if is_banner:
            region = gdi32.CreateRoundRectRgn(
                0,
                0,
                width + 1,
                height + 1,
                18,
                18,
            )
            if region:
                user32.SetWindowRgn(
                    hwnd,
                    region,
                    True,
                )

        if not user32.SetLayeredWindowAttributes(
            hwnd,
            0,
            (
                248
                if is_banner
                else 180
            ),
            LWA_ALPHA,
        ):
            user32.DestroyWindow(hwnd)
            raise RuntimeError(
                (
                    "Windows "
                    "SetLayeredWindowAttributes failed."
                )
            )

        user32.SetWindowPos(
            hwnd,
            wintypes.HWND(-1),
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE,
        )

        return handle

    def _create_windows(self) -> None:
        self._register_window_class()

        x, y, width, height = (
            self._virtual_screen()
        )
        if width <= 0 or height <= 0:
            raise RuntimeError(
                (
                    "Windows reported an invalid "
                    "virtual-screen size."
                )
            )

        banner_x = (
            x
            + max(
                0,
                (width - BANNER_WIDTH) // 2,
            )
        )
        banner_y = (
            y + BANNER_TOP_MARGIN
        )

        windows = [
            self._create_window(
                kind=BANNER_KIND,
                title=ACTIVITY_INDICATOR_TEXT,
                x=banner_x,
                y=banner_y,
                width=BANNER_WIDTH,
                height=BANNER_HEIGHT,
            ),
            self._create_window(
                kind="edge_top",
                title="Junius Activity Glow Top",
                x=x,
                y=y,
                width=width,
                height=EDGE_THICKNESS,
            ),
            self._create_window(
                kind="edge_bottom",
                title="Junius Activity Glow Bottom",
                x=x,
                y=y + height - EDGE_THICKNESS,
                width=width,
                height=EDGE_THICKNESS,
            ),
            self._create_window(
                kind="edge_left",
                title="Junius Activity Glow Left",
                x=x,
                y=y + EDGE_THICKNESS,
                width=EDGE_THICKNESS,
                height=max(
                    1,
                    height - (2 * EDGE_THICKNESS),
                ),
            ),
            self._create_window(
                kind="edge_right",
                title="Junius Activity Glow Right",
                x=x + width - EDGE_THICKNESS,
                y=y + EDGE_THICKNESS,
                width=EDGE_THICKNESS,
                height=max(
                    1,
                    height - (2 * EDGE_THICKNESS),
                ),
            ),
        ]

        with self._lock:
            self._windows = windows

        self._set_visible(True)

    def _set_visible(
        self,
        visible: bool,
    ) -> None:
        with self._lock:
            windows = list(self._windows)

        for handle in windows:
            hwnd = wintypes.HWND(handle)
            if visible:
                user32.SetWindowPos(
                    hwnd,
                    wintypes.HWND(-1),
                    0,
                    0,
                    0,
                    0,
                    (
                        SWP_NOMOVE
                        | SWP_NOSIZE
                        | SWP_NOACTIVATE
                        | SWP_SHOWWINDOW
                    ),
                )
                user32.ShowWindow(
                    hwnd,
                    SW_SHOWNOACTIVATE,
                )
                user32.InvalidateRect(
                    hwnd,
                    None,
                    True,
                )
            else:
                user32.ShowWindow(
                    hwnd,
                    SW_HIDE,
                )

        with self._lock:
            self._visible = visible

        if visible:
            self._hidden.clear()
            self._shown.set()
        else:
            self._hidden.set()

    def _update_pulse(self) -> None:
        now = time.monotonic()
        pulse = (
            0.5
            + 0.5
            * math.sin(
                now
                * (2.0 * math.pi)
                / PULSE_SECONDS
            )
        )
        alpha = int(
            70 + (155 * pulse)
        )

        with self._lock:
            windows = list(self._windows)

        for handle in windows:
            if (
                _WINDOW_KIND.get(handle)
                == BANNER_KIND
            ):
                continue

            user32.SetLayeredWindowAttributes(
                wintypes.HWND(handle),
                0,
                alpha,
                LWA_ALPHA,
            )

    def _pump_messages(self) -> None:
        message = wintypes.MSG()
        while user32.PeekMessageW(
            ctypes.byref(message),
            None,
            0,
            0,
            PM_REMOVE,
        ):
            user32.TranslateMessage(
                ctypes.byref(message)
            )
            user32.DispatchMessageW(
                ctypes.byref(message)
            )

    def _run(self) -> None:
        try:
            self._create_windows()
            self._ready.set()

            while True:
                self._pump_messages()

                with self._lock:
                    active = bool(
                        self._active_sessions
                    )
                    visible = self._visible

                if active:
                    if not visible:
                        self._set_visible(
                            True
                        )
                    self._update_pulse()
                elif visible:
                    self._set_visible(
                        False
                    )

                self._wake.wait(
                    timeout=1.0 / 30.0
                )
                self._wake.clear()
        except Exception as error:
            with self._lock:
                self._error = str(error)
            self._ready.set()
            self._shown.set()
