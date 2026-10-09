from __future__ import annotations

import json
import sys
from typing import Any

from desktop_helper_common import DesktopHelperError
from desktop_indicator import DesktopActivityIndicator
from desktop_input import action_batch, input_action
from desktop_windows import list_windows, screenshot

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if callable(_reconfigure):
        _reconfigure(encoding="utf-8")

ACTIVITY_INDICATOR = DesktopActivityIndicator()


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

    def check_user_interrupt() -> None:
        if ACTIVITY_INDICATOR.is_stopped(session):
            raise DesktopHelperError(
                "user_interrupted",
                "Desktop control stopped by user.",
            )

    if command != "control_end" and ACTIVITY_INDICATOR.is_stopped(session):
        check_user_interrupt()

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

    check_user_interrupt()

    if command == "windows":
        result = list_windows()
        check_user_interrupt()
        return result

    if command == "screenshot":
        handle = request.get("handle")
        result = screenshot(
            None
            if handle is None
            else int(handle)
        )
        check_user_interrupt()
        return result

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
            check_user_interrupt,
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
            check_user_interrupt,
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
