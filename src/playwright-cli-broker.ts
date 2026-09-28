import {
  loadProgram,
  type Program,
} from "./playwright-cli-broker-loader.js";

interface BrokerRequest {
  readonly id: number;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface BrokerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message?: string;
}

function writeProtocol(response: BrokerResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function captureWrite(
  target: string[],
): typeof process.stdout.write {
  return ((chunk: unknown, ...args: unknown[]) => {
    if (typeof chunk === "string") {
      target.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      target.push(Buffer.from(chunk).toString("utf8"));
    } else {
      target.push(String(chunk));
    }

    const callback = args.find(
      (value) => typeof value === "function",
    ) as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;
}

async function execute(
  program: Program,
  request: BrokerRequest,
): Promise<BrokerResponse> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const previousArgv = process.argv;
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;

  process.argv = [
    process.execPath,
    "playwright-cli",
    ...request.args,
  ];
  process.chdir(request.cwd);
  process.exitCode = 0;
  process.stdout.write = captureWrite(stdout);
  process.stderr.write = captureWrite(stderr);

  try {
    await program();
    const exitCode =
      typeof process.exitCode === "number"
        ? process.exitCode
        : 0;

    return {
      id: request.id,
      ok: exitCode === 0,
      exitCode,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      exitCode: 1,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      message:
        error instanceof Error
          ? error.stack ?? error.message
          : String(error),
    };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.argv = previousArgv;
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
  }
}

async function main(): Promise<void> {
  let program: Program;

  try {
    program = await loadProgram();
  } catch (error) {
    writeProtocol({
      id: 0,
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "",
      message:
        error instanceof Error
          ? error.stack ?? error.message
          : String(error),
    });
    process.exitCode = 1;
    return;
  }

  writeProtocol({
    id: 0,
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
  });

  let buffer = "";
  let queue = Promise.resolve();

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;

    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;

      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;

      queue = queue.then(async () => {
        let request: BrokerRequest;

        try {
          request = JSON.parse(line) as BrokerRequest;
          if (
            !Number.isInteger(request.id) ||
            !Array.isArray(request.args) ||
            !request.args.every(
              (value) => typeof value === "string",
            ) ||
            typeof request.cwd !== "string"
          ) {
            throw new Error("invalid_broker_request");
          }
        } catch (error) {
          writeProtocol({
            id: 0,
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "",
            message:
              error instanceof Error
                ? error.message
                : String(error),
          });
          return;
        }

        writeProtocol(await execute(program, request));
      });
    }
  });
}

void main();
