import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type DesktopHelperClientErrorCode =
  | "spawn_failed"
  | "process_timeout"
  | "output_limit"
  | "helper_failed"
  | "invalid_helper_response";

export class DesktopHelperClientError extends Error {
  constructor(
    readonly code: DesktopHelperClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DesktopHelperResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: string;
  readonly message?: string;
}

export interface DesktopHelperEnvelope {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: string;
  readonly message?: string;
}

export function desktopHelperResponse(
  record: DesktopHelperEnvelope,
): DesktopHelperResponse {
  return {
    ok: record.ok,
    ...(record.result === undefined
      ? {}
      : { result: record.result }),
    ...(record.code === undefined
      ? {}
      : { code: record.code }),
    ...(record.message === undefined
      ? {}
      : { message: record.message }),
  };
}

export function isDesktopHelperReady(
  record: DesktopHelperEnvelope,
): boolean {
  return (
    record.id === 0 &&
    record.ok === true &&
    typeof record.result === "object" &&
    record.result !== null &&
    (record.result as { ready?: unknown }).ready === true
  );
}

function parseDesktopHelperLine(
  line: string,
): DesktopHelperEnvelope {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new DesktopHelperClientError(
      "invalid_helper_response",
      "Desktop helper server returned invalid JSON.",
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("id" in parsed) ||
    typeof (parsed as { id?: unknown }).id !== "number" ||
    !("ok" in parsed) ||
    typeof (parsed as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new DesktopHelperClientError(
      "invalid_helper_response",
      "Desktop helper server returned an invalid response object.",
    );
  }

  const record = parsed as {
    id: number;
    ok: boolean;
    result?: unknown;
    code?: string;
    message?: string;
  };

  return {
    id: record.id,
    ok: record.ok,
    ...(record.result === undefined
      ? {}
      : { result: record.result }),
    ...(record.code === undefined
      ? {}
      : { code: record.code }),
    ...(record.message === undefined
      ? {}
      : { message: record.message }),
  };
}

export class DesktopHelperProtocolDecoder {
  #decoder = new StringDecoder("utf8");
  #buffer = "";

  constructor(
    private readonly maxOutputBytes =
      DEFAULT_MAX_OUTPUT_BYTES,
  ) {}

  reset(): void {
    this.#decoder = new StringDecoder("utf8");
    this.#buffer = "";
  }

  push(
    chunk: Buffer | string,
  ): readonly DesktopHelperEnvelope[] {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    this.#buffer += this.#decoder.write(buffer);

    if (
      Buffer.byteLength(this.#buffer, "utf8") >
      this.maxOutputBytes
    ) {
      throw new DesktopHelperClientError(
        "output_limit",
        `Desktop helper response exceeded ${this.maxOutputBytes} bytes.`,
      );
    }

    const records: DesktopHelperEnvelope[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;

      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);

      if (!line.trim()) continue;
      records.push(parseDesktopHelperLine(line));
    }

    return records;
  }

  finish(): void {
    const tail = this.#decoder.end();
    if (tail) {
      this.#buffer += tail;
    }
  }
}
