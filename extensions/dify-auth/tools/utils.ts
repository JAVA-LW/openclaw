export const resolveToolArguments = (input: unknown) => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : "{}";
  }
  return JSON.stringify(input ?? {});
};

export const stringifyToolOutput = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || typeof value === "undefined") {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

export const resolveToolCallId = (candidate: unknown) => {
  if (typeof candidate === "string" || typeof candidate === "number") {
    const value = String(candidate).trim();
    if (!value) {
      return "";
    }
    return value.startsWith("call_") ? value : `call_${value}`;
  }
  return "";
};

export const buildToolCall = (params: {
  toolName: unknown;
  args: unknown;
  candidates: Array<unknown>;
}) => {
  const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
  if (!toolName) {
    return null;
  }
  const argsString = resolveToolArguments(params.args);
  let callId = "";
  for (const candidate of params.candidates) {
    callId = resolveToolCallId(candidate);
    if (callId) {
      break;
    }
  }
  if (!callId) {
    callId = `call_${Date.now()}`;
  }
  return { toolName, argsString, callId };
};

export const normalizeToolDefinition = (tool: unknown) => {
  if (!tool || typeof tool !== "object") {
    return null;
  }
  const raw = tool as {
    type?: unknown;
    function?: unknown;
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
  const type = typeof raw.type === "string" ? raw.type : "function";
  if (type !== "function") {
    return null;
  }
  if (raw.function && typeof raw.function === "object") {
    const func = raw.function as { name?: unknown; description?: unknown; parameters?: unknown };
    const name = typeof func.name === "string" ? func.name.trim() : "";
    if (!name) {
      return null;
    }
    return {
      type: "function",
      function: {
        name,
        description: typeof func.description === "string" ? func.description : undefined,
        parameters: func.parameters ?? {},
      },
    };
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return null;
  }
  return {
    type: "function",
    function: {
      name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      parameters: raw.parameters ?? {},
    },
  };
};

export const normalizeToolDefinitions = (tools: unknown) => {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const normalized = tools
    .map((tool) => normalizeToolDefinition(tool))
    .filter(
      (
        tool,
      ): tool is {
        type: string;
        function: { name: string; description?: string; parameters: unknown };
      } => tool !== null,
    );
  return normalized.length > 0 ? normalized : undefined;
};

export const normalizeToolChoice = (toolChoice: unknown) => {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  if (typeof toolChoice === "string") {
    const name = toolChoice.trim();
    if (!name) {
      return undefined;
    }
    return {
      type: "function",
      function: { name },
    };
  }
  if (!toolChoice || typeof toolChoice !== "object") {
    return undefined;
  }
  const choice = toolChoice as { type?: unknown; function?: unknown; name?: unknown };
  const func = choice.function as { name?: unknown } | undefined;
  const nameFromFunc = typeof func?.name === "string" ? func.name.trim() : "";
  const nameFromRoot = typeof choice.name === "string" ? choice.name.trim() : "";
  const name = nameFromFunc || nameFromRoot;
  if (!name) {
    return undefined;
  }
  return {
    type: "function",
    function: { name },
  };
};

export const resolveToolResultOutput = (
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
) => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (item) =>
        (item.type === "text" || item.type === "input_text" || item.type === "output_text") &&
        typeof item.text === "string",
    )
    .map((item) => item.text ?? "")
    .join("");
};

export const extractToolOutput = (result: unknown) => {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return resolveToolResultOutput(
        content as Array<{ type: string; text?: string; image_url?: { url: string } }>,
      );
    }
    const details = (result as { details?: unknown }).details;
    if (typeof details === "string") {
      return details;
    }
  }
  return stringifyToolOutput(result);
};

export const isToolRole = (role?: string) => {
  const normalized = role?.toLowerCase() ?? "";
  return normalized === "tool" || normalized === "tool_result" || normalized === "toolresult";
};

export const resolveToolResultPrefix = (message: {
  role?: string;
  name?: string;
  toolName?: string;
  toolCallId?: string;
  toolUseId?: string;
}) => {
  const role = message.role?.toLowerCase();
  if (role !== "toolresult" && role !== "tool" && role !== "tool_result") {
    return "";
  }
  const toolName =
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.name === "string" && message.name.trim()) ||
    "tool";
  const toolCallId =
    (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
    (typeof message.toolUseId === "string" && message.toolUseId.trim()) ||
    "";
  const idSuffix = toolCallId ? ` id=${toolCallId}` : "";
  return `Tool result (${toolName})${idSuffix}:`;
};

export const parseToolArgs = (argsString: string) => {
  if (!argsString.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(argsString);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed } as Record<string, unknown>;
  } catch {
    return { input: argsString } as Record<string, unknown>;
  }
};

// Simple string hash for stable IDs
const simpleHash = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
};

export const parseTextModeToolCalls = (text: string) => {
  const toolCalls: Array<{ toolName: string; argsString: string; callId: string }> = [];
  const regex = /```(?:python|py)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const code = match[1].trim();
    // Support both single-line and multi-line calls
    // First, try to match function calls across newlines
    const callRegex = /([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)/g;
    let callMatch;
    while ((callMatch = callRegex.exec(code)) !== null) {
      const toolName = callMatch[1];
      const rawArgs = callMatch[2].trim().replace(/\n/g, " "); // Flatten newlines for easier regex matching
      let argsString = "{}";

      // Try to parse args
      // 1. Check for single string arg: "value" or 'value'
      const singleStringMatch = /^["'](.*)["']$/.exec(rawArgs);
      if (singleStringMatch) {
        argsString = JSON.stringify({ input: singleStringMatch[1] });
      } else {
        // 2. Try to naive parse key=value
        try {
          const props: string[] = [];
          const argRegex =
            /([a-zA-Z0-9_]+)\s*=\s*(?:([0-9]+(?:\.[0-9]+)?)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(True|False|None))/g;

          let argMatch;
          let hasMatch = false;

          while ((argMatch = argRegex.exec(rawArgs)) !== null) {
            hasMatch = true;
            const key = argMatch[1];
            const numVal = argMatch[2];
            const doubleQuotedVal = argMatch[3];
            const singleQuotedVal = argMatch[4];
            const boolVal = argMatch[5];

            if (numVal !== undefined) {
              props.push(`"${key}":${numVal}`);
            } else if (doubleQuotedVal !== undefined) {
              props.push(`"${key}":"${doubleQuotedVal}"`);
            } else if (singleQuotedVal !== undefined) {
              const escaped = singleQuotedVal.replace(/"/g, '\\"');
              props.push(`"${key}":"${escaped}"`);
            } else if (boolVal !== undefined) {
              const map: Record<string, string> = { True: "true", False: "false", None: "null" };
              props.push(`"${key}":${map[boolVal]}`);
            }
          }

          if (hasMatch) {
            argsString = "{" + props.join(",") + "}";
            JSON.parse(argsString); // Validate
          } else {
            // Fallback
            const naiveJson =
              "{" + rawArgs.replace(/([a-zA-Z0-9_]+)=/g, '"$1":').replace(/'/g, '"') + "}";
            JSON.parse(naiveJson);
            argsString = naiveJson;
          }
        } catch {
          argsString = JSON.stringify({ input: rawArgs });
        }
      }

      // Fix: Map single 'input' argument to tool-specific parameter name
      const TOOL_ARG_MAPPING: Record<string, string> = {
        read: "path",
        exec: "command",
        web_search: "query",
        web_fetch: "url",
        memory_search: "query",
      };

      try {
        const args = JSON.parse(argsString);
        const keys = Object.keys(args);
        if (keys.length === 1 && keys[0] === "input" && TOOL_ARG_MAPPING[toolName]) {
          const val = args["input"];
          argsString = JSON.stringify({ [TOOL_ARG_MAPPING[toolName]]: val });
        }
      } catch {}

      const stableId = `call_${simpleHash(toolName + argsString)}`;

      toolCalls.push({
        toolName,
        argsString,
        callId: stableId,
      });
    }
  }
  return toolCalls;
};

export const resolveDifyToolCalls = (data: Record<string, unknown>, _appType: "chat" | "agent") => {
  const event = typeof data.event === "string" ? data.event : "";
  const toolCalls: Array<{ toolName: string; argsString: string; callId: string }> = [];
  if (event === "agent_thought") {
    const toolCall = buildToolCall({
      toolName: data.tool,
      args: data.tool_input,
      candidates: [data.tool_call_id, data.id, data.task_id],
    });
    if (toolCall) {
      toolCalls.push(toolCall);
    }
    return toolCalls;
  }
  if (event === "tool_call") {
    const toolCall = buildToolCall({
      toolName: data.name,
      args: data.arguments,
      candidates: [data.tool_call_id, data.task_id],
    });
    if (toolCall) {
      toolCalls.push(toolCall);
    }
    return toolCalls;
  }
  if (event === "message" || event === "agent_message") {
    const calls = (data.tool_calls ?? data.toolCalls) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (!call || typeof call !== "object") {
          continue;
        }
        const func = (call.function ?? call.function_call) as Record<string, unknown> | undefined;
        const toolCall = buildToolCall({
          toolName: func?.name ?? call.name,
          args: func?.arguments ?? call.arguments,
          candidates: [call.id, call.call_id, call.tool_call_id],
        });
        if (toolCall) {
          toolCalls.push(toolCall);
        }
      }
    }
  }
  return toolCalls;
};
