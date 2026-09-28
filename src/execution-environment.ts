export function environmentForSpawn(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return environment;
  }

  const hasPath = Object.keys(
    environment,
  ).some(
    (name) =>
      name.toUpperCase() === "PATH",
  );
  if (hasPath) {
    return environment;
  }

  return {
    ...environment,
    PATH: "",
  };
}

export function withoutEnvironmentVariables(
  environment: NodeJS.ProcessEnv,
  options: {
    readonly names?: readonly string[];
    readonly prefixes?: readonly string[];
  },
): NodeJS.ProcessEnv {
  const deniedNames = new Set(
    (options.names ?? []).map((name) =>
      name.toUpperCase(),
    ),
  );
  const deniedPrefixes = (
    options.prefixes ?? []
  ).map((prefix) => prefix.toUpperCase());

  const result: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(environment)) {
    const normalizedName = name.toUpperCase();

    if (
      deniedNames.has(normalizedName) ||
      deniedPrefixes.some((prefix) =>
        normalizedName.startsWith(prefix),
      )
    ) {
      continue;
    }

    result[name] = value;
  }

  return result;
}
