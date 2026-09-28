import {
  DesktopComputerUseError,
  type DesktopCommand,
  type DesktopHelperImage,
  type DesktopRunRequest,
} from "./desktop-computer-use-types.js";
import type { DesktopSessionRegistry } from "./desktop-session-registry.js";

function isHelperImage(
  value: unknown,
): value is DesktopHelperImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "mimeType" in value &&
    "data" in value &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
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
  sessions: DesktopSessionRegistry,
): Record<string, unknown> {
  if (
    request.command === "invoke" ||
    request.command === "set_value" ||
    request.command === "focus"
  ) {
    const ref = request.ref!;
    const resolved =
      sessions
        .session(request.session)
        .refs.get(ref);

    if (resolved === undefined) {
      throw new DesktopComputerUseError(
        "desktop_ref_not_found",
        `Desktop ref is not available in session ${request.session}: ${ref}. Run inspect again.`,
      );
    }

    return {
      command: request.command,
      handle: resolved.handle,
      path: [...resolved.path],
      ...(request.text === undefined
        ? {}
        : { text: request.text }),
    };
  }

  return {
    command: request.command,
    ...(request.handle === undefined
      ? {}
      : { handle: request.handle }),
    ...(request.depth === undefined
      ? {}
      : { depth: request.depth }),
    ...(request.x === undefined
      ? {}
      : { x: request.x }),
    ...(request.y === undefined
      ? {}
      : { y: request.y }),
    ...(request.button === undefined
      ? {}
      : { button: request.button }),
    ...(request.clicks === undefined
      ? {}
      : { clicks: request.clicks }),
    ...(request.amount === undefined
      ? {}
      : { amount: request.amount }),
    ...(request.key === undefined
      ? {}
      : { key: request.key }),
    ...(request.text === undefined
      ? {}
      : { text: request.text }),
  };
}

export function transformDesktopHelperResult(
  sessionName: string,
  command: DesktopCommand,
  value: unknown,
  sessions: DesktopSessionRegistry,
): {
  readonly result: unknown;
  readonly image?: DesktopHelperImage;
} {
  if (command === "inspect") {
    const record = asRecord(value);
    const elements = record?.elements;

    if (
      record === undefined ||
      !Array.isArray(elements) ||
      typeof record.handle !== "number"
    ) {
      throw new DesktopComputerUseError(
        "invalid_helper_response",
        "Desktop inspect helper returned an invalid response.",
      );
    }

    const session =
      sessions.session(sessionName);
    session.refs.clear();
    session.nextRef = 1;

    const mapped = elements.map((element) => {
      const item = asRecord(element);
      const path = item?.path;

      if (
        item === undefined ||
        !Array.isArray(path) ||
        !path.every((part) =>
          Number.isInteger(part),
        )
      ) {
        throw new DesktopComputerUseError(
          "invalid_helper_response",
          "Desktop inspect helper returned an invalid element.",
        );
      }

      const ref = `d${session.nextRef}`;
      session.nextRef += 1;
      session.refs.set(ref, {
        handle: record.handle as number,
        path: path as number[],
      });

      const {
        path: _path,
        ...metadata
      } = item;

      return {
        ref,
        ...metadata,
      };
    });

    return {
      result: {
        ...record,
        elements: mapped,
      },
    };
  }

  if (command === "screenshot") {
    const record = asRecord(value);
    const image = record?.image;

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

  return { result: value };
}
