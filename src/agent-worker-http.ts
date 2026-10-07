import {
  createServer as createHttpServer,
  type Server,
} from "node:http";
import {
  sendJson,
  toWebRequest,
  writeWebResponse,
} from "./http-bridge.js";
import type { McpRuntime } from "./mcp-runtime.js";
import { configureMcpHttpServer } from "./mcp-http-tuning.js";
import {
  workerRequestAuthorized,
} from "./worker-auth.js";

export interface AgentWorkerHttpServerOptions {
  readonly workerId: string;
  readonly internalToken: string;
  readonly publicMcpOrigin: string;
  readonly mcpRuntime:
    McpRuntime;
  readonly reloadConfiguration:
    () => Promise<void>;
}

export interface AgentWorkerHttpServers {
  readonly mcpHttpServer:
    Server;
  readonly controlHttpServer:
    Server;
}

function destroyWithError(
  error: unknown,
  destroy:
    (error: Error) => void,
): void {
  destroy(
    error instanceof Error
      ? error
      : new Error(
          String(error),
        ),
  );
}

export function createAgentWorkerHttpServers(
  options:
    AgentWorkerHttpServerOptions,
): AgentWorkerHttpServers {
  const {
    workerId,
    internalToken,
    publicMcpOrigin,
    mcpRuntime,
    reloadConfiguration,
  } = options;

  const mcpHttpServer =
    createHttpServer(
      (req, res) => {
        if (
          !workerRequestAuthorized(
            req,
            internalToken,
          )
        ) {
          sendJson(
            res,
            403,
            {
              error:
                "worker_auth_required",
            },
          );
          return;
        }

        void (async () => {
          const request =
            toWebRequest(
              req,
              publicMcpOrigin,
            );
          const url =
            new URL(
              request.url,
            );

          if (
            url.pathname !==
            "/mcp"
          ) {
            sendJson(
              res,
              404,
              {
                error:
                  "not_found",
              },
            );
            return;
          }

          const startedAt =
            performance.now();
          const response =
            await mcpRuntime
              .handle(
                request,
              );
          res.setHeader(
            "x-junius-worker-duration-ms",
            String(
              Math.round(
                performance.now() -
                  startedAt,
              ),
            ),
          );

          const traceId =
            req.headers[
              "x-junius-trace-id"
            ];
          if (
            typeof traceId ===
              "string" &&
            traceId.length > 0
          ) {
            res.setHeader(
              "x-junius-trace-id",
              traceId,
            );
          }

          await writeWebResponse(
            res,
            response,
          );
        })().catch(
          (
            error: unknown,
          ) => {
            console.error(
              `[worker ${workerId} mcp]`,
              error,
            );

            if (
              !res.headersSent
            ) {
              sendJson(
                res,
                500,
                {
                  error:
                    "internal_error",
                },
              );
              return;
            }

            destroyWithError(
              error,
              (failure) =>
                res.destroy(
                  failure,
                ),
            );
          },
        );
      },
    );
  configureMcpHttpServer(mcpHttpServer);

  const controlHttpServer =
    createHttpServer(
      (req, res) => {
        if (
          !workerRequestAuthorized(
            req,
            internalToken,
          )
        ) {
          sendJson(
            res,
            403,
            {
              error:
                "worker_auth_required",
            },
          );
          return;
        }

        if (
          req.method ===
            "GET" &&
          req.url ===
            "/__junius/worker-health"
        ) {
          sendJson(
            res,
            200,
            {
              ok: true,
              workerId,
              pid:
                process.pid,
            },
          );
          return;
        }

        if (
          req.method ===
            "POST" &&
          req.url ===
            "/__junius/config-reload"
        ) {
          void reloadConfiguration()
            .then(() => {
              sendJson(
                res,
                200,
                {
                  ok: true,
                  workerId,
                },
              );
            })
            .catch(
              (
                error:
                  unknown,
              ) => {
                sendJson(
                  res,
                  500,
                  {
                    error:
                      "configuration_reload_failed",
                    message:
                      error instanceof
                      Error
                        ? error.message
                        : String(
                            error,
                          ),
                  },
                );
              },
            );
          return;
        }

        sendJson(
          res,
          404,
          {
            error:
              "not_found",
          },
        );
      },
    );

  return {
    mcpHttpServer,
    controlHttpServer,
  };
}
