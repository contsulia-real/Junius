import {
  DesktopComputerUseError,
  type DesktopCommand,
  type DesktopHelperImage,
  type DesktopRunRequest,
} from "./desktop-computer-use-types.js";

function isHelperImage(
  value: unknown,
): value is DesktopHelperImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "mimeType" in value &&
    "data" in value &&
    typeof value.mimeType ===
      "string" &&
    typeof value.data ===
      "string"
  );
}

function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return undefined;
  }

  return value as Record<
    string,
    unknown
  >;
}

export function desktopHelperRequest(
  request: DesktopRunRequest,
): Record<string, unknown> {
  return {
    command: request.command,
    session: request.session,
    ...(request.handle === undefined
      ? {}
      : { handle: request.handle }),
    ...(request.x === undefined
      ? {}
      : { x: request.x }),
    ...(request.y === undefined
      ? {}
      : { y: request.y }),
    ...(request.toX === undefined
      ? {}
      : { to_x: request.toX }),
    ...(request.toY === undefined
      ? {}
      : { to_y: request.toY }),
    ...(request.button === undefined
      ? {}
      : { button: request.button }),
    ...(request.clicks === undefined
      ? {}
      : { clicks: request.clicks }),
    ...(request.amount === undefined
      ? {}
      : { amount: request.amount }),
    ...(request.durationMs === undefined
      ? {}
      : { duration_ms: request.durationMs }),
    ...(request.key === undefined
      ? {}
      : { key: request.key }),
    ...(request.text === undefined
      ? {}
      : { text: request.text }),
    ...(request.steps === undefined
      ? {}
      : { steps: request.steps }),
    ...(request.actions === undefined
      ? {}
      : {
          actions: request.actions.map((action) => ({
            ...action,
            ...("toX" in action ? { to_x: action.toX } : {}),
            ...("toY" in action ? { to_y: action.toY } : {}),
            ...("durationMs" in action
              ? { duration_ms: action.durationMs }
              : {}),
            action: action.action,
            toX: undefined,
            toY: undefined,
            durationMs: undefined,
          })),
        }),
    ...(request.screenshotAfter === undefined
      ? {}
      : { screenshot_after: request.screenshotAfter }),
    ...(request.screenshotHandle === undefined
      ? {}
      : { screenshot_handle: request.screenshotHandle }),
  };
}

export function transformDesktopHelperResult(
  command: DesktopCommand,
  value: unknown,
): {
  readonly result: unknown;
  readonly image?: DesktopHelperImage;
} {
  const record = asRecord(value);
  const image = record?.image;

  if (command !== "screenshot" && !isHelperImage(image)) {
    return { result: value };
  }

  if (
    record === undefined ||
    !isHelperImage(image)
  ) {
    throw new DesktopComputerUseError(
      "invalid_helper_response",
      "Desktop screenshot helper returned an invalid image.",
    );
  }

  const {
    image: _image,
    ...metadata
  } = record;

  return {
    result: metadata,
    image,
  };
}
