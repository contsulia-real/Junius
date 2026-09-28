import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  WorkspaceManager,
  WorkspaceState,
} from "./workspace-manager.js";

const workspaceStateSchema =
  z.object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      ),
    rootPath:
      z.string().min(1),
  }).passthrough();

const persistedStateSchema =
  z.object({
    version:
      z.number()
        .int()
        .positive()
        .optional(),
    workspaces:
      z.array(
        workspaceStateSchema,
      ),
  }).passthrough();

export class WorkspaceStateStore {
  #saveQueue:
    Promise<void> =
      Promise.resolve();

  constructor(
    readonly filePath: string,
  ) {}

  async load():
    Promise<
      readonly WorkspaceState[] |
      undefined
    > {
    let raw: string;

    try {
      raw = await readFile(
        this.filePath,
        "utf8",
      );
    } catch (error) {
      if (
        typeof error ===
          "object" &&
        error !== null &&
        "code" in error &&
        error.code ===
          "ENOENT"
      ) {
        return undefined;
      }

      throw error;
    }

    const parsedJson =
      JSON.parse(
        raw.replace(
          /^\uFEFF/u,
          "",
        ),
      ) as unknown;
    const parsed =
      persistedStateSchema
        .parse(parsedJson);

    return parsed.workspaces
      .map(
        (workspace) => ({
          id: workspace.id,
          rootPath:
            workspace.rootPath,
        }),
      );
  }

  save(
    workspaces:
      WorkspaceManager,
  ): Promise<void> {
    const snapshot = {
      version: 2,
      workspaces:
        workspaces.list(),
    };

    const operation =
      this.#saveQueue.then(
        async () => {
          const directory =
            dirname(
              this.filePath,
            );
          await mkdir(
            directory,
            {
              recursive: true,
            },
          );

          const tempPath =
            `${this.filePath}.${process.pid}.tmp`;
          const payload =
            JSON.stringify(
              snapshot,
              null,
              2,
            );

          await writeFile(
            tempPath,
            `${payload}\n`,
            "utf8",
          );
          await rename(
            tempPath,
            this.filePath,
          );
        },
      );

    this.#saveQueue =
      operation.catch(
        () => undefined,
      );
    return operation;
  }
}
