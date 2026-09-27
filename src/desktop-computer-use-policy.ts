import type { DesktopRunRequest } from "./desktop-computer-use-types.js";

export const DESKTOP_SESSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REF_PATTERN = /^d\d+$/u;

function isFiniteInteger(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isInteger(value) &&
    Number.isFinite(value)
  );
}

export function validateDesktopRequest(request: DesktopRunRequest): boolean {
  switch (request.command) {
    case "windows":
      return (
        request.handle === undefined &&
        request.ref === undefined
      );

    case "screenshot":
      return (
        request.handle === undefined ||
        (isFiniteInteger(request.handle) && request.handle > 0)
      );

    case "inspect":
      return (
        isFiniteInteger(request.handle) &&
        request.handle > 0 &&
        (request.depth === undefined ||
          (isFiniteInteger(request.depth) &&
            request.depth >= 0 &&
            request.depth <= 8))
      );

    case "invoke":
    case "focus":
      return request.ref !== undefined && REF_PATTERN.test(request.ref);

    case "set_value":
      return (
        request.ref !== undefined &&
        REF_PATTERN.test(request.ref) &&
        request.text !== undefined
      );

    case "focus_window":
      return isFiniteInteger(request.handle) && request.handle > 0;

    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        (request.handle === undefined ||
          (isFiniteInteger(request.handle) && request.handle > 0))
      );

    case "mouse_click":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        (request.handle === undefined ||
          (isFiniteInteger(request.handle) && request.handle > 0)) &&
        (request.clicks === undefined ||
          (isFiniteInteger(request.clicks) &&
            request.clicks >= 1 &&
            request.clicks <= 4))
      );

    case "mouse_wheel":
      return (
        isFiniteInteger(request.x) &&
        isFiniteInteger(request.y) &&
        isFiniteInteger(request.amount) &&
        (request.handle === undefined ||
          (isFiniteInteger(request.handle) && request.handle > 0))
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
      return request.text !== undefined && request.text.length <= 65_536;
  }
}


