export const resolveToolArguments = (input: unknown, allowEmptyString = false) => {
  if (typeof input === "string") {
    // For deltas, we want to preserve empty strings or whitespace if needed, 
    // but usually args are JSON fragments. 
    // If allowEmptyString is true, we return the raw string (even if empty).
    if (allowEmptyString) {
        return input;
    }
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
  allowEmptyArgs?: boolean;
}) => {
  const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
  if (!toolName) {
    return null;
  }
  const argsString = resolveToolArguments(params.args, params.allowEmptyArgs);
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
  return normalized === "tool" || normalized === "tool_result" || normalized === "toolresult" || normalized === "function";
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

export const resolveDifyToolCalls = (data: Record<string, unknown>, _appType: "chat" | "agent") => {
  const event = typeof data.event === "string" ? data.event : "";
  const toolCalls: Array<{ toolName: string; argsString: string; callId: string; isDelta: boolean }> = [];
  
  // Log incoming data for debugging
  if (event === "node_finished" || event === "message" || event === "agent_message") {
     if (JSON.stringify(data).includes("tool_calls") || JSON.stringify(data).includes("toolCalls")) {
         console.log(`[dify-auth] Resolving tool calls for event ${event}:`, JSON.stringify(data, null, 2));
         try {
            // Write to a log file for easier inspection
            const fs = require('fs');
            const path = require('path');
            const logDir = path.join(__dirname, '..', 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logPath = path.join(logDir, 'dify_tool_calls_debug.log');
            const logEntry = `[${new Date().toISOString()}] Event: ${event}\nData: ${JSON.stringify(data, null, 2)}\n----------------------------------------\n`;
            fs.appendFileSync(logPath, logEntry);

             if (event === "node_finished") {
                 const outputs = (data.data as any)?.outputs;
                 if (outputs?.tool_calls) {
                     console.log(`[dify-auth] Raw tool_calls in outputs:`, JSON.stringify(outputs.tool_calls, null, 2));
                 }
             }
         } catch (e) {
             console.error("[dify-auth] Error logging raw tool calls:", e);
         }
     }
  }

  if (event === "agent_thought") {
    const toolCall = buildToolCall({
      toolName: data.tool,
      args: data.tool_input,
      candidates: [data.tool_call_id, data.id, data.task_id],
    });
    if (toolCall) {
      toolCalls.push({ ...toolCall, isDelta: false });
    }
    return toolCalls;
  }
  if (event === "tool_call") {
    const toolCall = buildToolCall({
      toolName: data.name,
      args: data.arguments,
      candidates: [data.tool_call_id, data.task_id],
      allowEmptyArgs: true,
    });
    if (toolCall) {
      // Dify sends tool_call as streaming deltas
      toolCalls.push({ ...toolCall, isDelta: true });
    }
    return toolCalls;
  }
  if (event === "node_finished") {
    const dataObj = data.data as { outputs?: { tool_calls?: unknown[] } } | undefined;
    const outputs = dataObj?.outputs;
    if (outputs?.tool_calls && Array.isArray(outputs.tool_calls)) {
      console.log(`[dify-auth] Processing node_finished tool_calls:`, JSON.stringify(outputs.tool_calls));
      for (const call of outputs.tool_calls) {
        if (!call || typeof call !== "object") {
          continue;
        }
        const safeCall = call as any;
        let func = safeCall.function ?? safeCall.function_call;
        if (typeof func === "string") {
            try {
                func = JSON.parse(func);
            } catch (e) {
                console.warn("[dify-auth] Failed to parse function property:", e);
            }
        }
        
        const toolName = func?.name ?? safeCall.name;
        // Enhanced args lookup including func.args and func.parameters
        const args = func?.arguments ?? func?.args ?? func?.parameters ?? 
                     safeCall.arguments ?? safeCall.args ?? safeCall.parameters;

        console.log(`[dify-auth] Extracted args for ${toolName}:`, typeof args === 'object' ? JSON.stringify(args) : args);

        const toolCall = buildToolCall({
          toolName: toolName,
          args: args,
          candidates: [safeCall.id, safeCall.call_id, safeCall.tool_call_id],
        });
        if (toolCall) {
          // node_finished contains full tool call
          toolCalls.push({ ...toolCall, isDelta: false });
        }
      }
    }
  }
  if (event === "message" || event === "agent_message") {
    const calls = (data.tool_calls ?? data.toolCalls) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (!call || typeof call !== "object") {
          continue;
        }
        const safeCall = call as any;
        let func = safeCall.function ?? safeCall.function_call;
        if (typeof func === "string") {
            try {
                func = JSON.parse(func);
            } catch (e) {
                console.warn("[dify-auth] Failed to parse function property in message event:", e);
            }
        }
        const toolName = func?.name ?? safeCall.name;
        // Enhanced args lookup for message events too
        const args = func?.arguments ?? func?.args ?? func?.parameters ?? 
                     safeCall.arguments ?? safeCall.args ?? safeCall.parameters;

        const toolCall = buildToolCall({
          toolName: toolName,
          args: args,
          candidates: [safeCall.id, safeCall.call_id, safeCall.tool_call_id],
        });
        if (toolCall) {
          // message events usually contain full tool calls
          toolCalls.push({ ...toolCall, isDelta: false });
        }
      }
    }
  }
  return toolCalls;
};
