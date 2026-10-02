import type {
  SkillManifest,
} from "./skill-frontmatter.js";
import type {
  SkillSourceOptions,
} from "./skill-source.js";

export type SkillScope =
  | "global"
  | "workspace";

export interface SkillSummary
  extends SkillManifest {
  readonly scope:
    SkillScope;
  readonly effective:
    boolean;
  readonly path:
    string;
  readonly shadows?:
    "global";
  readonly shadowedBy?:
    "workspace";
}

export interface InvalidSkill {
  readonly scope:
    SkillScope;
  readonly path:
    string;
  readonly message:
    string;
}

export interface SkillListResult {
  readonly skills:
    readonly SkillSummary[];
  readonly invalid:
    readonly InvalidSkill[];
}

export interface SkillReadRequest {
  readonly name:
    string;
  readonly workspace?:
    string;
  readonly scope?:
    | "effective"
    | SkillScope;
  readonly path?:
    string;
}

export interface SkillReadResult
  extends SkillManifest {
  readonly scope:
    SkillScope;
  readonly rootPath:
    string;
  readonly path:
    string;
  readonly content:
    string;
}

export interface SkillInstallRequest {
  readonly source:
    string;
  readonly scope:
    SkillScope;
  readonly workspace?:
    string;
  readonly subpath?:
    string;
  readonly replace?:
    boolean;
  readonly agentsDigest?:
    string;
}

export interface SkillInstallResult
  extends SkillManifest {
  readonly scope:
    SkillScope;
  readonly path:
    string;
  readonly source:
    string;
  readonly replaced:
    boolean;
}

export interface SkillRemoveRequest {
  readonly name:
    string;
  readonly scope:
    SkillScope;
  readonly workspace?:
    string;
  readonly agentsDigest?:
    string;
}

export interface SkillRemoveResult {
  readonly removed:
    SkillSummary;
  readonly effectiveAfter?:
    SkillSummary;
}

export interface SkillServiceOptions
  extends SkillSourceOptions {
  readonly globalSkillsRoot?:
    string;
}

export interface LocatedSkill
  extends SkillManifest {
  readonly scope:
    SkillScope;
  readonly rootPath:
    string;
}

export interface CandidateSkill
  extends SkillManifest {
  readonly rootPath:
    string;
}
