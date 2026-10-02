export type SkillErrorCode =
  | "workspace_not_registered"
  | "skill_not_found"
  | "skill_already_exists"
  | "invalid_skill"
  | "invalid_source"
  | "multiple_skills_found"
  | "path_outside_skill"
  | "remote_fetch_failed"
  | "archive_extract_failed"
  | "skill_install_failed"
  | "skill_remove_failed";

export class SkillError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message: string,
    readonly details?: Readonly<
      Record<string, unknown>
    >,
  ) {
    super(message);
  }
}
