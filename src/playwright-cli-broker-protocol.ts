const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type PlaywrightCliBrokerErrorCode =
  | "broker_unavailable"
  | "broker_spawn_failed"
  | "broker_timeout"
  | "broker_interrupted"
  | "broker_output_limit"
  | "broker_protocol_error";

export class PlaywrightCliBrokerError extends Error {
  constructor(
    readonly code: PlaywrightCliBrokerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PlaywrightCliBrokerResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message?: string;
}

export interface PlaywrightCliBrokerEnvelope
  extends PlaywrightCliBrokerResponse {
  readonly id: number;
}

export function playwrightCliBrokerResponse(
  record: PlaywrightCliBrokerEnvelope,
): PlaywrightCliBrokerResponse {
  return {
    exitCode: record.exitCode,
    stdout: record.stdout,
    stderr: record.stderr,
    ...(record.message === undefined
      ? {}
      : { message: record.message }),
  };
}

function parseBrokerLine(
  line: string,
): PlaywrightCliBrokerEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new PlaywrightCliBrokerError(
      "broker_protocol_error",
      "Playwright CLI broker returned invalid JSON.",
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { id?: unknown }).id !== "number" ||
    typeof (parsed as { exitCode?: unknown }).exitCode !==
      "number" ||
    typeof (parsed as { stdout?: unknown }).stdout !==
      "string" ||
    typeof (parsed as { stderr?: unknown }).stderr !==
      "string"
  ) {
    throw new PlaywrightCliBrokerError(
      "broker_protocol_error",
      "Playwright CLI broker returned an invalid response.",
    );
  }

  const record = parsed as {
    id: number;
    exitCode: number;
    stdout: string;
    stderr: string;
    message?: string;
  };

  return {
    id: record.id,
    exitCode: record.exitCode,
    stdout: record.stdout,
    stderr: record.stderr,
    ...(record.message === undefined
      ? {}
      : { message: record.message }),
  };
}

export class PlaywrightCliBrokerProtocolDecoder {
  #buffer = "";

  constructor(
    private readonly maxOutputBytes =
      DEFAULT_MAX_OUTPUT_BYTES,
  ) {}

  reset(): void {
    this.#buffer = "";
  }

  push(
    chunk: string,
  ): readonly PlaywrightCliBrokerEnvelope[] {
    this.#buffer += chunk;

    if (
      Buffer.byteLength(this.#buffer, "utf8") >
      this.maxOutputBytes
    ) {
      throw new PlaywrightCliBrokerError(
        "broker_output_limit",
        `Playwright CLI broker output exceeded ${this.maxOutputBytes} bytes.`,
      );
    }

    const records: PlaywrightCliBrokerEnvelope[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;

      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;

      records.push(parseBrokerLine(line));
    }

    return records;
  }
}
