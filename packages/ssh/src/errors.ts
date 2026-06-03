import * as Schema from "effect/Schema";

const SshCommandArgs = Schema.Array(Schema.String);

export class SshHostDiscoveryError extends Schema.TaggedErrorClass<SshHostDiscoveryError>()(
  "SshHostDiscoveryError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class SshInvalidTargetError extends Schema.TaggedErrorClass<SshInvalidTargetError>()(
  "SshInvalidTargetError",
  {
    message: Schema.String,
  },
) {}

export class SshCommandError extends Schema.TaggedErrorClass<SshCommandError>()("SshCommandError", {
  message: Schema.String,
  command: SshCommandArgs,
  exitCode: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SshLaunchError extends Schema.TaggedErrorClass<SshLaunchError>()("SshLaunchError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SshPairingError extends Schema.TaggedErrorClass<SshPairingError>()("SshPairingError", {
  message: Schema.String,
  stdout: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SshHttpBridgeError extends Schema.TaggedErrorClass<SshHttpBridgeError>()(
  "SshHttpBridgeError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SshReadinessError extends Schema.TaggedErrorClass<SshReadinessError>()(
  "SshReadinessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class SshPasswordPromptError extends Schema.TaggedErrorClass<SshPasswordPromptError>()(
  "SshPasswordPromptError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const SshEnvironmentError = Schema.Union([
  SshCommandError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshReadinessError,
  SshPasswordPromptError,
]);
export type SshEnvironmentError = typeof SshEnvironmentError.Type;

export const SshError = Schema.Union([
  SshHostDiscoveryError,
  SshHttpBridgeError,
  SshEnvironmentError,
]);
export type SshError = typeof SshError.Type;
