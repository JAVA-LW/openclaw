export const toolCache = new Map<
  string,
  {
    tools?: Array<{
      type: string;
      function: { name: string; description?: string; parameters: unknown };
    }>;
    tool_choice?: unknown;
  }
>();
