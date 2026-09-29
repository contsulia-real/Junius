import type {
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  JUNIUS_CONTRACT_MODES,
  loadJuniusContracts,
} from "./junius-contracts.js";

export function registerContractTool(
  server: McpServer,
): void {
  server.registerTool(
    "load_junius_contracts",
    {
      title:
        "Load Junius Work Contracts",
      description:
        "Load one or more specialized Junius operating contracts into the current context. The Core contract requires this before substantive engineering work and before the first Browser or Desktop tool call. Combine applicable modes in one call.",
      inputSchema: z.object({
        modes: z
          .array(
            z.enum(
              JUNIUS_CONTRACT_MODES,
            ),
          )
          .min(1)
          .max(3),
      }),
      _meta: {
        securitySchemes: [
          { type: "noauth" },
        ],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ modes }) => {
      const contracts =
        loadJuniusContracts(
          modes,
        );

      return {
        content: [
          {
            type:
              "text" as const,
            text:
              JSON.stringify({
                ok: true,
                contracts:
                  contracts.map(
                    ({
                      mode,
                      digest,
                    }) => ({
                      mode,
                      digest,
                    }),
                  ),
              }),
          },
          ...contracts.map(
            (contract) => ({
              type:
                "text" as const,
              text:
                contract.text,
            }),
          ),
        ],
      };
    },
  );
}
