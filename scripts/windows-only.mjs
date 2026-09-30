export const WINDOWS_ONLY_MESSAGE =
  "Junius supports Windows only.";

export function assertWindowsPlatform(
  platform = process.platform,
) {
  if (platform !== "win32") {
    throw new Error(
      WINDOWS_ONLY_MESSAGE,
    );
  }
}
