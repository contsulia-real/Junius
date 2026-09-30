import { z } from "zod";
import type {
  WorkspaceReadBatchOperation,
} from "./workspace-batch.js";
import {
  stableIdSchema,
  workspacePathSchema,
} from "./mcp-tool-shared.js";

export const workspaceVerifySchema =
  z.array(
    z.discriminatedUnion(
      "op",
      [
        z.object({
          id:
            stableIdSchema
              .optional(),
          op:
            z.literal("ls"),
          path:
            workspacePathSchema
              .default("."),
          depth:
            z.number()
              .int()
              .min(1)
              .max(4)
              .default(1),
        }),
        z.object({
          id:
            stableIdSchema
              .optional(),
          op:
            z.literal("read"),
          files:
            z.array(
              z.object({
                path:
                  workspacePathSchema,
                start_line:
                  z.number()
                    .int()
                    .min(1)
                    .optional(),
                end_line:
                  z.number()
                    .int()
                    .min(1)
                    .optional(),
              }),
            )
              .min(1)
              .max(16),
        }),
        z.object({
          id:
            stableIdSchema
              .optional(),
          op:
            z.literal("rg"),
          query:
            z.string()
              .min(1)
              .max(4_096),
          path:
            workspacePathSchema
              .default("."),
          globs:
            z.array(
              z.string()
                .min(1)
                .max(1_024),
            )
              .max(32)
              .default([]),
          case_sensitive:
            z.boolean()
              .default(true),
          fixed_strings:
            z.boolean()
              .default(false),
          hidden:
            z.boolean()
              .default(false),
          max_results:
            z.number()
              .int()
              .min(1)
              .max(500)
              .default(100),
        }),
      ],
    ),
  )
    .max(16)
    .default([]);

export function mapWorkspaceVerifyOperations(
  verify:
    z.infer<
      typeof workspaceVerifySchema
    >,
): readonly WorkspaceReadBatchOperation[] {
  return verify.map(
    (operation) => {
      switch (
        operation.op
      ) {
        case "ls":
          return {
            ...(
              operation.id ===
              undefined
                ? {}
                : {
                    id:
                      operation.id,
                  }
            ),
            op:
              "ls" as const,
            path:
              operation.path,
            depth:
              operation.depth,
          };

        case "read":
          return {
            ...(
              operation.id ===
              undefined
                ? {}
                : {
                    id:
                      operation.id,
                  }
            ),
            op:
              "read" as const,
            files:
              operation.files.map(
                (file) => ({
                  path:
                    file.path,
                  ...(
                    file.start_line ===
                    undefined
                      ? {}
                      : {
                          startLine:
                            file.start_line,
                        }
                  ),
                  ...(
                    file.end_line ===
                    undefined
                      ? {}
                      : {
                          endLine:
                            file.end_line,
                        }
                  ),
                }),
              ),
          };

        case "rg":
          return {
            ...(
              operation.id ===
              undefined
                ? {}
                : {
                    id:
                      operation.id,
                  }
            ),
            op:
              "rg" as const,
            query:
              operation.query,
            path:
              operation.path,
            globs:
              operation.globs,
            caseSensitive:
              operation
                .case_sensitive,
            fixedStrings:
              operation
                .fixed_strings,
            hidden:
              operation.hidden,
            maxResults:
              operation
                .max_results,
          };
      }
    },
  );
}
