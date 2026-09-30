from __future__ import annotations

import ctypes
from ctypes import wintypes

import pyautogui

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
