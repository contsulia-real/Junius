export type WorkspaceFileErrorCode =
  | "workspace_not_registered"
  | "invalid_path"
  | "path_outside_workspace"
  | "path_not_found"
  | "not_a_directory"
  | "not_a_file"
  | "binary_file"
  | "invalid_write"
  | "edit_not_found"
  | "edit_not_unique"
  | "write_too_large"
  | "write_failed"
  | "rg_not_available"
  | "rg_failed"
  | "agents_ack_required"
  | "agents_instructions_too_large";

export class WorkspaceFileError extends Error {
  constructor(
    readonly code: WorkspaceFileErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
