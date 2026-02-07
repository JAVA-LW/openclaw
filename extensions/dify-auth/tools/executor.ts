import type { IncomingMessage } from "node:http";
import type { ToolCallResult, ToolCall } from "../types.js";
import { resolveToolListForRequest } from "./resolver.js";
import { parseToolArgs, extractToolOutput } from "./utils.js";

export const executeToolCalls = async (params: {
  req: IncomingMessage;
  model: string | undefined;
  user: string | undefined;
  calls: Array<ToolCall>;
}) => {
  const { tools } = await resolveToolListForRequest({
    req: params.req,
    model: params.model,
    user: params.user,
  });
  const results: Array<ToolCallResult> = [];
  for (const call of params.calls) {
    const tool = tools.find((candidate) => candidate.name === call.toolName);
    if (!tool || !tool.execute) {
      results.push({
        tool_call_id: call.callId,
        output: `Tool not available: ${call.toolName}`,
        is_error: true,
      });
      continue;
    }
    try {
      const args = parseToolArgs(call.argsString);
      const result = await tool.execute(call.callId, args);
      results.push({
        tool_call_id: call.callId,
        output: extractToolOutput(result),
      });
    } catch (err) {
      results.push({
        tool_call_id: call.callId,
        output: err instanceof Error ? err.message : String(err),
        is_error: true,
      });
    }
  }
  return results;
};
