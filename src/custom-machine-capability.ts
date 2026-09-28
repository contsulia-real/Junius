import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProcessCapability } from "./capabilities/process-capability.js";
import type { WorkspaceArgumentGrant } from "./workspace-profile.js";

export const CUSTOM_CAPABILITY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const SAFE_ARGUMENT_PATTERN =
  /^[^\u0000-\u001f\u007f]{1,4096}$/u;

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

export const customMachineCapabilityDefinitionSchema =
  z.object({
    key: z.string().regex(
      CUSTOM_CAPABILITY_KEY_PATTERN,
    ),
    description: z.string().min(1).max(1024),
    executable: z.string().min(1).max(4096),
    fixedArgs: z.array(
      z.string().regex(SAFE_ARGUMENT_PATTERN),
    ).max(64).default([]),
    argumentPolicy: z.array(
      argumentGrantSchema,
    ).min(1).max(128),
    timeoutMs: z.number().int().min(100).max(600_000)
      .default(15_000),
    maxOutputBytes: z.number().int().min(1024)
      .max(16 * 1024 * 1024)
      .default(64 * 1024),
  });

export type CustomMachineCapabilityDefinition =
  z.infer<
    typeof customMachineCapabilityDefinitionSchema
  >;

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
    inheritedEnvironment: environment,
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
