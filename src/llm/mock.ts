export interface LlmProvider {
  name: string;
  mode: "mock" | "remote";
}

export function createMockProvider(): LlmProvider {
  return {
    name: "mock",
    mode: "mock"
  };
}
