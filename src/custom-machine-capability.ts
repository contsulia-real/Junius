import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProcessCapability } from "./capabilities/process-capability.js";
import type { WorkspaceArgumentGrant } from "./workspace-profile.js";

export const CUSTOM_CAPABILITY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const SAFE_ARGUMENT_PATTERN =
  /^[^\u0000-\u001f\u007f]{1,4096}$/u;
const ENVIRONMENT_NAME_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENVIRONMENT_VALUE_PATTERN =
  /^[^\u0000]{0,32767}$/u;

const environmentNameSchema = z.string()
  .regex(ENVIRONMENT_NAME_PATTERN);

export const customMachineCapabilityEnvironmentSchema =
  z.object({
    inherit: z.enum([
      "all",
      "allowlist",
      "none",
    ]).default("none"),
    allowNames: z.array(
      environmentNameSchema,
    ).max(256).default([]),
    denyNames: z.array(
      environmentNameSchema,
    ).max(256).default([]),
    denyPrefixes: z.array(
      environmentNameSchema,
    ).max(256).default([]),
    set: z.record(
      environmentNameSchema,
      z.string()
        .regex(ENVIRONMENT_VALUE_PATTERN)
        .max(32767),
    ).default({}),
  });

const argumentGrantSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("exact"),
    args: z.array(
      z.string().regex(SAFE_ARGUMENT_PATTERN),
    ).max(64),
  }),
  z.object({
    mode: z.literal("prefix"),
    args: z.array(
      z.string().regex(SAFE_ARGUMENT_PATTERN),
    ).min(1).max(64),
  }),
]);

const customMachineCapabilityBaseSchema =
  z.object({
    key: z.string().regex(
      CUSTOM_CAPABILITY_KEY_PATTERN,
    ),
    description:
      z.string().min(1).max(1024),
    executable:
      z.string().min(1).max(4096),
    fixedArgs: z.array(
      z.string().regex(
        SAFE_ARGUMENT_PATTERN,
      ),
    ).max(64).default([]),
    argumentPolicy: z.array(
      argumentGrantSchema,
    ).min(1).max(128),
    timeoutMs: z.number()
      .int()
      .min(100)
      .max(600_000)
      .default(15_000),
    maxOutputBytes: z.number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .default(64 * 1024),
  });

export const legacyCustomMachineCapabilityDefinitionSchema =
  customMachineCapabilityBaseSchema;

export const customMachineCapabilityDefinitionSchema =
  customMachineCapabilityBaseSchema.extend({
    environmentPolicy:
      customMachineCapabilityEnvironmentSchema
        .default({
          inherit: "none",
          allowNames: [],
          denyNames: [],
          denyPrefixes: [],
          set: {},
        }),
  });

export type CustomMachineCapabilityDefinition =
  z.infer<
    typeof customMachineCapabilityDefinitionSchema
  >;

export type CustomMachineCapabilityEnvironment =
  z.infer<
    typeof customMachineCapabilityEnvironmentSchema
  >;

export function legacyCustomMachineCapabilityEnvironment():
  CustomMachineCapabilityEnvironment {
  return {
    inherit: "all",
    allowNames: [],
    denyNames: [],
    denyPrefixes: [],
    set: {},
  };
}

function startsWith(
  value: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every(
      (part, index) =>
        value[index] === part,
    )
  );
}

function sameArgs(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    startsWith(left, right)
  );
}

export function customCapabilityGrantCompatible(
  definition: CustomMachineCapabilityDefinition,
  grant: WorkspaceArgumentGrant,
): boolean {
  if (grant.mode === "exact") {
    return definition.argumentPolicy.some(
      (allowed) =>
        allowed.mode === "exact"
          ? sameArgs(
              grant.args,
              allowed.args,
            )
          : startsWith(
              grant.args,
              allowed.args,
            ),
    );
  }

  return definition.argumentPolicy.some(
    (allowed) =>
      allowed.mode === "prefix" &&
      startsWith(
        grant.args,
        allowed.args,
      ),
  );
}

export function customCapabilityInvocationAllowed(
  definition: CustomMachineCapabilityDefinition,
  args: readonly string[],
): boolean {
  return definition.argumentPolicy.some(
    (allowed) =>
      allowed.mode === "exact"
        ? sameArgs(args, allowed.args)
        : startsWith(args, allowed.args),
  );
}

export function customCapabilityAvailable(
  definition: CustomMachineCapabilityDefinition,
): boolean {
  if (!isAbsolute(definition.executable)) {
    return false;
  }

  try {
    return statSync(
      definition.executable,
    ).isFile();
  } catch {
    return false;
  }
}

export function validateCustomMachineCapability(
  input: unknown,
): CustomMachineCapabilityDefinition {
  const definition =
    customMachineCapabilityDefinitionSchema.parse(
      input,
    );

  if (!isAbsolute(definition.executable)) {
    throw new Error(
      "custom_capability_executable_must_be_absolute",
    );
  }

  return definition;
}

function inheritedCustomEnvironment(
  definition:
    CustomMachineCapabilityDefinition,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (
    definition.environmentPolicy.inherit ===
    "none"
  ) {
    return {};
  }

  if (
    definition.environmentPolicy.inherit ===
    "all"
  ) {
    return environment;
  }

  const allowed = new Set(
    definition.environmentPolicy.allowNames
      .map((name) => name.toUpperCase()),
  );
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        allowed.has(
          name.toUpperCase(),
        ),
    ),
  );
}

export function createCustomMachineCapability(
  definition: CustomMachineCapabilityDefinition,
  environment: NodeJS.ProcessEnv = process.env,
): ProcessCapability {
  return new ProcessCapability({
    key: definition.key,
    description: definition.description,
    executable: definition.executable,
    fixedArgs: definition.fixedArgs,
    argumentPolicy: (args) =>
      customCapabilityInvocationAllowed(
        definition,
        args,
      ),
    timeoutMs: definition.timeoutMs,
    maxOutputBytes:
      definition.maxOutputBytes,
    environment:
      definition.environmentPolicy.set,
    inheritedEnvironment:
      inheritedCustomEnvironment(
        definition,
        environment,
      ),
    inheritedEnvironmentDenyNames:
      definition.environmentPolicy
        .denyNames,
    inheritedEnvironmentDenyPrefixes:
      definition.environmentPolicy
        .denyPrefixes,
  });
}

export function customCapabilityPolicyLabels(
  definition: CustomMachineCapabilityDefinition,
): readonly string[] {
  return definition.argumentPolicy.map(
    (rule) =>
      rule.mode +
      ": " +
      rule.args
        .map((arg) =>
          /\s/u.test(arg)
            ? JSON.stringify(arg)
            : arg,
        )
        .join(" "),
  );
}
