import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import {
  createConfigFromPolicy,
  spawnSandboxFromConfig,
} from "@microsoft/mxc-sdk";

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\\s"]/u.test(value)) {
    return value;
  }

  let result = '"';
  let backslashes = 0;

  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }

    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }

    result += "\\".repeat(backslashes);
    result += character;
    backslashes = 0;
  }

  result += "\\".repeat(backslashes * 2);
  result += '"';
  return result;
}

async function waitForChild(child: ChildProcess): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [exitCode, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];

  return { exitCode, signal, stdout, stderr };
}

if (process.platform !== "win32") {
  throw new Error("The MXC network probe must run on Windows.");
}

const probeRootRaw = await mkdtemp(join(tmpdir(), "junius-mxc-network-"));
const probeRoot = await realpath(probeRootRaw);
const workspaceRoot = join(probeRoot, "workspace");
const resultFile = join(workspaceRoot, "network-result.json");

const server = createServer((socket) => {
  socket.end("host-ok");
});

try {
  await mkdir(workspaceRoot, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = "127.0.0.1";
  const port = address.port;

  // Prove the listener is genuinely reachable from the host before asking the
  // sandbox to connect. This prevents "blocked" from being a false positive
  // caused by a dead test server.
  const hostControlSource = `import { connect } from "node:net";

const [host, portText] = process.argv.slice(1);
const port = Number(portText);

const result = await new Promise((resolve) => {
  const socket = connect({ host, port });
  let data = "";

  socket.setEncoding("utf8");
  socket.setTimeout(2000);

  socket.on("connect", () => {
    socket.end();
  });
  socket.on("data", (chunk) => {
    data += chunk;
  });
  socket.on("close", () => {
    resolve({ connected: true, data });
  });
  socket.on("timeout", () => {
    socket.destroy(new Error("timeout"));
  });
  socket.on("error", (error) => {
    resolve({ connected: false, error: error.message });
  });
});

process.stdout.write(JSON.stringify(result));
`;

  const control = await import("node:child_process").then(({ spawnSync }) =>
    spawnSync(
      process.execPath,
      ["-e", hostControlSource, host, String(port)],
      {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
      },
    )
  );

  const hostControl = control.stdout
    ? JSON.parse(control.stdout) as {
        connected: boolean;
        data?: string;
        error?: string;
      }
    : { connected: false, error: control.stderr || control.error?.message };

  if (!hostControl.connected) {
    throw new Error(
      `Host control connection failed before sandbox test: ${JSON.stringify(hostControl)}`,
    );
  }

  const sandboxSource = `import { connect } from "node:net";
import { writeFile } from "node:fs/promises";

const [host, portText, resultPath] = process.argv.slice(1);
const port = Number(portText);

const result = await new Promise((resolve) => {
  const socket = connect({ host, port });

  socket.setTimeout(2000);

  socket.on("connect", () => {
    socket.destroy();
    resolve({ connected: true });
  });

  socket.on("timeout", () => {
    socket.destroy();
    resolve({ connected: false, error: "timeout" });
  });

  socket.on("error", (error) => {
    resolve({
      connected: false,
      code: error?.code,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

await writeFile(resultPath, JSON.stringify(result), "utf8");
`;

  const config = createConfigFromPolicy(
    {
      version: "0.8.0-alpha",
      filesystem: {
        readwritePaths: [workspaceRoot],
        readonlyPaths: [],
      },
      network: {
        defaultPolicy: "block",
        allowLocalNetwork: false,
      },
      ui: {
        allowWindows: true,
        clipboard: "none",
        allowInputInjection: false,
      },
      timeoutMs: 10_000,
    },
    "process",
  );

  const commandLine = [
    process.execPath,
    "-e",
    sandboxSource,
    host,
    String(port),
    resultFile,
  ]
    .map(quoteWindowsArgument)
    .join(" ");

  config.process!.commandLine = commandLine;
  config.process!.cwd = workspaceRoot;

  const child = spawnSandboxFromConfig(
    config,
    {
      usePty: false,
      experimental: true,
      debug: true,
    },
    workspaceRoot,
  );

  const execution = await waitForChild(child);

  if (execution.exitCode !== 0) {
    console.error(
      JSON.stringify(
        {
          probeExecuted: false,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          execution,
          workspaceRoot,
          listener: { host, port },
          hostControl,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    const sandboxResult = JSON.parse(
      await readFile(resultFile, "utf8"),
    ) as {
      connected: boolean;
      code?: string;
      error?: string;
    };

    console.log(
      JSON.stringify(
        {
          probeExecuted: true,
          sdk: "@microsoft/mxc-sdk@0.8.0",
          requestedContainment: "process",
          workspaceRoot,
          listener: { host, port },
          hostControl,
          executor: execution,
          sandboxResult,
          conclusions: {
            hostLoopbackReachable: hostControl.connected,
            sandboxLoopbackBlocked: !sandboxResult.connected,
          },
        },
        null,
        2,
      ),
    );
  }
} finally {
  server.close();
  await rm(probeRoot, { recursive: true, force: true });
}
