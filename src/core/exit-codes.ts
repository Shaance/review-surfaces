export const ExitCodes = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
  schemaValidationFailed: 3,
  evidenceValidationFailed: 4,
  privacyBlocked: 5,
  qualityGateFailed: 10
} as const;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = ExitCodes.runtimeError) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
