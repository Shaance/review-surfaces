export function openAiProjectKeyFixture(): string {
  return ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
}

export function openAiLegacyKeyFixture(): string {
  return ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
}

export function pemBoundaryFixture(
  label: "PRIVATE KEY" | "RSA PRIVATE KEY",
  edge: "BEGIN" | "END"
): string {
  return `${"-".repeat(5)}${edge} ${label}${"-".repeat(5)}`;
}
