import type {
  DesktopBatchAction,
  DesktopRunRequest,
} from "./desktop-computer-use-types.js";

export const DESKTOP_SESSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const MAX_BATCH_ACTIONS = 128;
const MAX_WAIT_MS = 30_000;
const MAX_BATCH_WAIT_MS = 30_000;
const MAX_DRAG_MS = 10_000;

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
    (isFiniteInteger(handle) && handle > 0)
  );
}

function validKey(key: string | undefined): boolean {
  return (
    key !== undefined &&
    key.length >= 1 &&
    key.length <= 64
  );
}

function validText(text: string | undefined): boolean {
  return text !== undefined && text.length <= 65_536;
}

function validSteps(
  steps: DesktopRunRequest["steps"],
): boolean {
  return (
    steps !== undefined &&
    steps.length >= 1 &&
    steps.length <= 128 &&
    steps.every(
      (step) =>
        (
          step.action === "key_press" ||
          step.action === "key_down" ||
          step.action === "key_up"
        ) &&
        validKey(step.key),
    )
  );
}

function validPoint(
  action: {
    readonly handle?: number;
    readonly x?: number;
    readonly y?: number;
  },
): boolean {
  return (
    isFiniteInteger(action.x) &&
    isFiniteInteger(action.y) &&
    validHandle(action.handle)
  );
}

function validWait(durationMs: number | undefined): boolean {
  return (
    isFiniteInteger(durationMs) &&
    durationMs >= 0 &&
    durationMs <= MAX_WAIT_MS
  );
}

function validDrag(
  action: {
    readonly handle?: number;
    readonly x?: number;
    readonly y?: number;
    readonly toX?: number;
    readonly toY?: number;
    readonly durationMs?: number;
  },
): boolean {
  return (
    validPoint(action) &&
    isFiniteInteger(action.toX) &&
    isFiniteInteger(action.toY) &&
    (
      action.durationMs === undefined ||
      (
        isFiniteInteger(action.durationMs) &&
        action.durationMs >= 0 &&
        action.durationMs <= MAX_DRAG_MS
      )
    )
  );
}

function validateBatchAction(
  action: DesktopBatchAction,
): boolean {
  switch (action.action) {
    case "focus_window":
      return isFiniteInteger(action.handle) && action.handle > 0;
    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
      return validPoint(action);
    case "mouse_click":
      return (
        validPoint(action) &&
        (
          action.clicks === undefined ||
          (
            isFiniteInteger(action.clicks) &&
            action.clicks >= 1 &&
            action.clicks <= 4
          )
        )
      );
    case "mouse_wheel":
      return validPoint(action) && isFiniteInteger(action.amount);
    case "drag":
      return validDrag(action);
    case "wait":
      return validWait(action.durationMs);
    case "key_press":
    case "key_down":
    case "key_up":
      return validKey(action.key);
    case "key_macro":
      return validSteps(action.steps);
    case "clipboard_read":
      return true;
    case "clipboard_write":
    case "type":
      return validText(action.text);
  }
}

function hasNoActionArguments(
  request: DesktopRunRequest,
): boolean {
  return (
    request.handle === undefined &&
    request.x === undefined &&
    request.y === undefined &&
    request.toX === undefined &&
    request.toY === undefined &&
    request.button === undefined &&
    request.clicks === undefined &&
    request.amount === undefined &&
    request.durationMs === undefined &&
    request.key === undefined &&
    request.text === undefined &&
    request.steps === undefined &&
    request.actions === undefined &&
    request.screenshotAfter === undefined &&
    request.screenshotHandle === undefined
  );
}

export function validateDesktopRequest(
  request: DesktopRunRequest,
): boolean {
  switch (request.command) {
    case "control_begin":
    case "control_end":
      return hasNoActionArguments(request);

    case "windows":
      return request.handle === undefined;

    case "screenshot":
      return validHandle(request.handle);

    case "focus_window":
      return (
        isFiniteInteger(request.handle) &&
        request.handle > 0
      );

    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
      return validPoint(request);

    case "mouse_click":
      return (
        validPoint(request) &&
        (
          request.clicks === undefined ||
          (
            isFiniteInteger(request.clicks) &&
            request.clicks >= 1 &&
            request.clicks <= 4
          )
        )
      );

    case "mouse_wheel":
      return (
        validPoint(request) &&
        isFiniteInteger(request.amount)
      );

    case "drag":
      return validDrag(request);

    case "wait":
      return validWait(request.durationMs);

    case "action_batch": {
      if (
        request.actions === undefined ||
        request.actions.length < 1 ||
        request.actions.length > MAX_BATCH_ACTIONS ||
        !validHandle(request.screenshotHandle) ||
        !request.actions.every(validateBatchAction)
      ) {
        return false;
      }

      const totalTimedMs = request.actions.reduce(
        (total, action) =>
          total +
          (
            action.action === "wait"
              ? action.durationMs
              : action.action === "drag"
                ? action.durationMs ?? 0
                : 0
          ),
        0,
      );
      return totalTimedMs <= MAX_BATCH_WAIT_MS;
    }

    case "key_press":
    case "key_down":
    case "key_up":
      return validKey(request.key);

    case "key_macro":
      return validSteps(request.steps);

    case "clipboard_read":
      return request.text === undefined;

    case "clipboard_write":
    case "type":
      return validText(request.text);
  }
}
