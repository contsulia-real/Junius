import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { JobManager } from "./job-manager.js";
import {
  jobToolError,
  runCommandInputSchema,
} from "./mcp-tool-shared.js";

export function registerJobTools(
  server: McpServer,
  jobs: JobManager,
): void {
  server.registerTool(
    "start_job",
    {
      title: "Start Local Job",
      description:
        "Start a long-running registered process capability in one explicitly selected Junius Workspace. Authorization is identical to run_command, but the process continues in the background and is managed by a returned job ID.",
      inputSchema: runCommandInputSchema,
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, key, args }) => {
      try {
        const job = await jobs.start(workspace, key, args);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job,
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get Local Job",
      description:
        "Get the current status and output-size metadata for one Junius job.",
      inputSchema: z.object({
        job: z.string().uuid(),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job: await jobs.get(job),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "wait_job",
    {
      title: "Wait for Local Job",
      description:
        "Wait briefly for one Junius job to finish. Returns the current status when the job completes or when the wait timeout is reached.",
      inputSchema: z.object({
        job: z.string().uuid(),
        timeout_ms: z.number().int().min(0).max(60_000).default(30_000),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job, timeout_ms }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job: await jobs.wait(job, timeout_ms),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "read_job_output",
    {
      title: "Read Local Job Output",
      description:
        "Read captured stdout or stderr from one Junius job using a character offset cursor.",
      inputSchema: z.object({
        job: z.string().uuid(),
        stream: z.enum(["stdout", "stderr"]).default("stdout"),
        offset: z.number().int().min(0).default(0),
        limit: z
          .number()
          .int()
          .min(1)
          .max(256 * 1024)
          .default(64 * 1024),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job, stream, offset, limit }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                output: await jobs.readOutput(
                  job,
                  stream,
                  offset,
                  limit,
                ),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel Local Job",
      description:
        "Cancel one running Junius job. On Windows Junius uses taskkill /T /F for best-effort process-tree termination.",
      inputSchema: z.object({
        job: z.string().uuid(),
      }),
      _meta: {
        securitySchemes: [{ type: "noauth" }],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                job: await jobs.cancel(job),
              }),
            },
          ],
        };
      } catch (error) {
        return jobToolError(error);
      }
    },
  );

}
