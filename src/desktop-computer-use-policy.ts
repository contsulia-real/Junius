import type { DesktopRunRequest } from "./desktop-computer-use-types.js";

export const DESKTOP_SESSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function isFiniteInteger(
  value: number | undefined,
): value is number {
  return (
    value !== undefined &&
    Number.isInteger(value) &&
    Number.isFinite(value)
  );
}

function validHandle(
  handle: number | undefined,
): boolean {
  return (
    handle === undefined ||
    (isFiniteInteger(handle) &&
      handle > 0)
  );
}

export function validateDesktopRequest(
  request: DesktopRunRequest,
): boolean {
  switch (request.command) {
    case "windows":
      return request.handle === undefined;

    case "screenshot":
      return validHandle(
        request.handle,
      );

    case "focus_window":
      return (
        isFiniteInteger(
          request.handle,
        ) &&
        request.handle > 0
      );

    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        validHandle(
          request.handle,
        )
      );

    case "mouse_click":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        validHandle(
          request.handle,
        ) &&
        (request.clicks === undefined ||
          (isFiniteInteger(
            request.clicks,
          ) &&
            request.clicks >= 1 &&
            request.clicks <= 4))
      );

    case "mouse_wheel":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        isFiniteInteger(
          request.amount,
        ) &&
        validHandle(
          request.handle,
        )
      );

    case "key_press":
    case "key_down":
    case "key_up":
      return (
        request.key !== undefined &&
        request.key.length >= 1 &&
        request.key.length <= 64
      );

    case "type":
      return (
        request.text !== undefined &&
        request.text.length <=
          65_536
      );
  }
}
