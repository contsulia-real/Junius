export interface JuniusUpdateCheck {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly releaseTag: string;
  readonly updateAvailable: boolean;
}

export interface JuniusUpdateResult
  extends JuniusUpdateCheck {
  readonly updated: boolean;
  readonly restartRequired: boolean;
  readonly installerOutput: string;
}

export interface JuniusUpdateOptions {
  readonly currentVersion?: string;
  readonly packageRoot?: string;
  readonly bootstrapPath?: string;
  readonly platform?: NodeJS.Platform | string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function checkJuniusUpdate(
  options?: JuniusUpdateOptions,
): Promise<JuniusUpdateCheck>;

export function updateJunius(
  options?: JuniusUpdateOptions,
): Promise<JuniusUpdateResult>;
