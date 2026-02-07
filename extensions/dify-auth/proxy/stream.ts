import type { ServerResponse } from "node:http";
import type { DifyResponseEvent } from "../dify/types.js";

export function writeOpenResponsesEvent(
  res: ServerResponse,
  event: { type: string; [key: string]: unknown },
) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createOpenResponsesUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

export function createOpenResponsesResource(params: {
  id: string;
  model: string;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  output: Array<{
    type: "message" | "function_call" | "reasoning";
    id: string;
    role?: "assistant";
    content?: Array<{ type: "output_text"; text: string }>;
    status?: "in_progress" | "completed";
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  error?: { code: string; message: string };
}) {
  return {
    id: params.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: params.status,
    model: params.model,
    output: params.output,
    usage: createOpenResponsesUsage(),
    error: params.error,
  };
}

export function createOpenResponsesMessageItem(params: {
  id: string;
  text: string;
  status?: "in_progress" | "completed";
}) {
  return {
    type: "message" as const,
    id: params.id,
    role: "assistant" as const,
    content: [{ type: "output_text" as const, text: params.text }],
    status: params.status,
  };
}

export function transformEvent(difyData: DifyResponseEvent) {
  const event = difyData.event;
  let content = "";

  if (event === "message" || event === "agent_message") {
    content = difyData.answer || "";
  } else if (event === "agent_thought") {
    return null;
  } else if (event === "message_end") {
    return null;
  } else if (event === "error") {
    content = `Error: ${difyData.message}`;
  }

  if (!content) {
    return null;
  }

  return {
    id: "chatcmpl-" + (difyData.task_id || "id"),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "dify-app",
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
}
