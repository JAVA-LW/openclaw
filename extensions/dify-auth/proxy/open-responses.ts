import type { IncomingMessage, ServerResponse } from "node:http";
import type { DifyPayload, DifyResponseEvent } from "../dify/types.js";
import { HEADER_AUTHORIZATION, HEADER_CONTENT_TYPE, MAX_TOOL_LOOPS } from "../constants.js";
import { uploadBase64ToDify } from "../dify/client.js";
import { toolCache } from "../tools/cache.js";
import { executeToolCalls } from "../tools/executor.js";
import { resolveDifyToolCalls, stringifyToolOutput } from "../tools/utils.js";
import {
  normalizeToolDefinitions,
  normalizeToolChoice,
  extractToolOutput,
} from "../tools/utils.js";
import {
  setConversationId,
  getConversationId,
  pruneConversationMap,
  deleteConversation,
} from "../utils/conversation.js";
import { DifyLogger } from "../utils/logger.js";
import {
  createOpenResponsesMessageItem,
  createOpenResponsesResource,
  writeOpenResponsesEvent,
} from "./stream.js";

function extractOpenResponsesText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      if ((type === "input_text" || type === "text") && typeof text === "string") {
        return text;
      }
      if (type === "output_text" && typeof text === "string") {
        return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractOpenResponsesImages(content: unknown) {
  if (!Array.isArray(content)) {
    return [] as Array<
      | { kind: "url"; url: string }
      | { kind: "base64"; data: string; mediaType: string; filename?: string }
    >;
  }
  const images: Array<
    | { kind: "url"; url: string }
    | { kind: "base64"; data: string; mediaType: string; filename?: string }
  > = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const type = (part as { type?: unknown }).type;
    if (type === "input_image") {
      const source = (part as { source?: unknown }).source as
        | { type?: string; url?: string }
        | { type?: string; data?: string; media_type?: string; filename?: string }
        | undefined;
      if (!source || typeof source !== "object") {
        continue;
      }
      if (source.type === "url" && typeof source.url === "string") {
        images.push({ kind: "url", url: source.url });
      } else if (
        source.type === "base64" &&
        typeof source.data === "string" &&
        typeof source.media_type === "string"
      ) {
        images.push({
          kind: "base64",
          data: source.data,
          mediaType: source.media_type,
          filename: typeof source.filename === "string" ? source.filename : undefined,
        });
      }
      continue;
    }
    if (type === "image_url") {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
      if (typeof url === "string" && url.trim()) {
        images.push({ kind: "url", url });
      }
    }
  }
  return images;
}

export async function handleOpenResponsesProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    apiKey: string;
    baseUrl: string;
    appType: "chat" | "agent";
    body: unknown;
  },
) {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const logger = new DifyLogger(requestId);
  //   logger.log("Incoming OpenResponses Request Body", params.body);

  if (!params.body || typeof params.body !== "object") {
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }
  const payload = params.body as {
    model?: string;
    input?: unknown;
    instructions?: string;
    tool_call_mode?: string;
    tools?: Array<{
      type?: string;
      function?: { name?: string; description?: string; parameters?: unknown };
    }>;
    tool_choice?: unknown;
    stream?: boolean;
    user?: string;
  };

  if (typeof payload.input === "undefined") {
    res.statusCode = 400;
    res.end("Invalid request body");
    return;
  }

  const inputItems = Array.isArray(payload.input) ? payload.input : null;
  const inputString = typeof payload.input === "string" ? payload.input : "";

  const toolResults: Array<{ tool_call_id: string; output: string; is_error?: boolean }> = [];
  const messageItems: Array<{ role?: string; content?: unknown }> = [];
  const inputTextParts: string[] = [];
  const inputImages: Array<
    | { kind: "url"; url: string }
    | { kind: "base64"; data: string; mediaType: string; filename?: string }
  > = [];
  if (inputItems) {
    for (const item of inputItems) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const type = (item as { type?: unknown }).type;
      if (type === "input_text") {
        toolResults.length = 0;
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) {
          inputTextParts.push(text);
        }
        continue;
      }
      if (type === "input_image") {
        toolResults.length = 0;
        inputImages.push(...extractOpenResponsesImages([item]));
        continue;
      }
      if (type === "function_call_output") {
        const callId = (item as { call_id?: unknown }).call_id;
        const output = (item as { output?: unknown }).output;
        if (typeof callId === "string" && typeof output === "string") {
          toolResults.push({ tool_call_id: callId, output });
        } else if (typeof callId === "string" && typeof output !== "undefined") {
          toolResults.push({ tool_call_id: callId, output: stringifyToolOutput(output) });
        }
        continue;
      }
      if (type === "message" || type === "input_message") {
        const role = (item as { role?: unknown }).role;
        const content = (item as { content?: unknown }).content;
        const normalizedRole = typeof role === "string" ? role : undefined;
        const normalizedRoleLower = normalizedRole?.toLowerCase() ?? "";
        if (normalizedRoleLower === "tool" || normalizedRoleLower === "tool_result") {
          const toolCallId =
            (item as { tool_call_id?: unknown }).tool_call_id ??
            (item as { call_id?: unknown }).call_id ??
            (item as { toolCallId?: unknown }).toolCallId;
          if (typeof toolCallId === "string" && toolCallId.trim()) {
            const textOutput = extractOpenResponsesText(content);
            toolResults.push({
              tool_call_id: toolCallId,
              output: textOutput || stringifyToolOutput(content),
            });
            continue;
          }
        }
        toolResults.length = 0;
        messageItems.push({ role: normalizedRole, content });
        continue;
      }
      if (typeof (item as { role?: unknown }).role === "string") {
        const role = (item as { role?: unknown }).role as string;
        const normalizedRole = role.toLowerCase();
        const content = (item as { content?: unknown }).content;
        if (
          normalizedRole === "tool" ||
          normalizedRole === "tool_result" ||
          normalizedRole === "toolresult"
        ) {
          const toolCallId =
            (item as { tool_call_id?: unknown }).tool_call_id ??
            (item as { call_id?: unknown }).call_id ??
            (item as { toolCallId?: unknown }).toolCallId;
          if (typeof toolCallId === "string" && toolCallId.trim()) {
            const textOutput = extractOpenResponsesText(content);
            toolResults.push({
              tool_call_id: toolCallId,
              output: textOutput || stringifyToolOutput(content),
            });
            continue;
          }
        }
        toolResults.length = 0;
        messageItems.push({ role, content });
      }
    }
  }

  const systemParts: string[] = [];
  if (typeof payload.instructions === "string" && payload.instructions.trim()) {
    systemParts.push(payload.instructions.trim());
  }
  for (const message of messageItems) {
    if (message.role !== "system" && message.role !== "developer") {
      continue;
    }
    const text = extractOpenResponsesText(message.content);
    if (text.trim()) {
      systemParts.push(text.trim());
    }
  }

  const lastUserMessage =
    messageItems.toReversed().find((message) => message.role === "user") ??
    messageItems[messageItems.length - 1];
  const lastUserContent = lastUserMessage?.content;
  const textFromContent = extractOpenResponsesText(lastUserContent);
  const inputText = inputTextParts.join("\n");
  const query = inputString || textFromContent || inputText;

  const userId = payload.user || "openclaw-user";
  const sessionKey = `${params.apiKey}:${userId}`;
  const now = Date.now();
  pruneConversationMap(now);
  let conversationId = getConversationId(sessionKey, now);

  const isReset = typeof query === "string" && query.includes("A new session was started");
  if (isReset) {
    conversationId = "";
    deleteConversation(sessionKey);
    toolCache.delete(sessionKey);
  }

  const difyPayload: DifyPayload = {
    inputs: {},
    query: query || "",
    response_mode: "streaming",
    conversation_id: conversationId,
    user: userId,
    files: [],
  };

  // Ensure tool call mode is always handled by Dify's native capabilities
  // We do not set 'openclaw_text' or other legacy modes here.
  // difyPayload.tool_call_mode = "structured"; // Optional: explicit native mode if needed

  if (!difyPayload.query && toolResults.length > 0) {
    const fallbackQuery = toolResults
      .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
    difyPayload.query = fallbackQuery || "tool_result";
  }

  const normalizedTools = normalizeToolDefinitions(payload.tools);
  if (normalizedTools) {
    difyPayload.tools = normalizedTools;
  }
  const normalizedToolChoice = normalizeToolChoice(payload.tool_choice);
  if (typeof normalizedToolChoice !== "undefined") {
    difyPayload.tool_choice = normalizedToolChoice;
  }
  if (!difyPayload.tools && toolResults.length > 0) {
    const cached = toolCache.get(sessionKey);
    if (cached?.tools) {
      difyPayload.tools = cached.tools;
    }
  }
  if (typeof difyPayload.tool_choice === "undefined" && toolResults.length > 0) {
    const cached = toolCache.get(sessionKey);
    if (typeof cached?.tool_choice !== "undefined") {
      difyPayload.tool_choice = cached.tool_choice;
    }
  }
  if (toolResults.length > 0) {
    difyPayload.tool_results = toolResults;
    console.log("[dify-auth] Sending tool_results to Dify:", JSON.stringify(toolResults, null, 2));
  }
  if (difyPayload.tools || typeof difyPayload.tool_choice !== "undefined") {
    const cached = toolCache.get(sessionKey);
    toolCache.set(sessionKey, {
      tools: difyPayload.tools ?? cached?.tools,
      tool_choice:
        typeof difyPayload.tool_choice !== "undefined"
          ? difyPayload.tool_choice
          : cached?.tool_choice,
    });
  }

  if (lastUserContent) {
    const images = extractOpenResponsesImages(lastUserContent);
    for (const img of images) {
      if (img.kind === "url") {
        difyPayload.files.push({
          type: "image",
          transfer_method: "remote_url",
          url: img.url,
        });
      } else {
        try {
          const fileId = await uploadBase64ToDify({
            data: img.data,
            mediaType: img.mediaType,
            filename: img.filename,
            apiKey: params.apiKey,
            baseUrl: params.baseUrl,
            logger,
          });
          difyPayload.files.push({
            type: "image",
            transfer_method: "local_file",
            upload_file_id: fileId,
          });
        } catch {
          continue;
        }
      }
    }
  } else if (inputImages.length > 0) {
    for (const img of inputImages) {
      if (img.kind === "url") {
        difyPayload.files.push({
          type: "image",
          transfer_method: "remote_url",
          url: img.url,
        });
      } else {
        try {
          const fileId = await uploadBase64ToDify({
            data: img.data,
            mediaType: img.mediaType,
            filename: img.filename,
            apiKey: params.apiKey,
            baseUrl: params.baseUrl,
            logger,
          });
          difyPayload.files.push({
            type: "image",
            transfer_method: "local_file",
            upload_file_id: fileId,
          });
        } catch {
          continue;
        }
      }
    }
  }

  if (!conversationId && systemParts.length > 0) {
    const systemMessage = systemParts.join("\n\n");
    difyPayload.query = difyPayload.query
      ? `${systemMessage}\n\n${difyPayload.query}`
      : systemMessage;
  }

  console.log("[dify-auth] Request payload:", JSON.stringify(difyPayload, null, 2));
  logger.log("Constructed Dify Payload", difyPayload);

  try {
    const endpoint = "/chat-messages";
    const streamEnabled = payload.stream !== false;
    const responseId = `response_${Date.now()}`;
    const outputItemId = `msg_${Date.now()}`;
    const model =
      typeof payload.model === "string" && payload.model.trim() ? payload.model : "dify-app";
    const autoToolLoop = false;
    let loopCount = 0;
    let accumulatedText = "";
    let currentPayload = difyPayload;
    let lastToolCalls: Array<{ callId: string; name: string; args: string }> = [];

    if (streamEnabled) {
      res.setHeader(HEADER_CONTENT_TYPE, "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const initial = createOpenResponsesResource({
        id: responseId,
        model,
        status: "in_progress",
        output: [],
      });
      writeOpenResponsesEvent(res, { type: "response.created", response: initial });
      writeOpenResponsesEvent(res, { type: "response.in_progress", response: initial });
      const outputItem = createOpenResponsesMessageItem({
        id: outputItemId,
        text: "",
        status: "in_progress",
      });
      writeOpenResponsesEvent(res, {
        type: "response.output_item.added",
        output_index: 0,
        item: outputItem,
      });
      writeOpenResponsesEvent(res, {
        type: "response.content_part.added",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
    }

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount += 1;

      const requestOptions = {
        method: "POST",
        headers: {
          [HEADER_AUTHORIZATION]: `Bearer ${params.apiKey}`,
          [HEADER_CONTENT_TYPE]: "application/json",
        },
        body: JSON.stringify(currentPayload),
      };

      logger.log(`Dify Request (Loop ${loopCount})`, {
        url: `${params.baseUrl}${endpoint}`,
        ...requestOptions,
        body: currentPayload,
      });

      const difyRes = await fetch(`${params.baseUrl}${endpoint}`, requestOptions);

      logger.log(`Dify Response Status (Loop ${loopCount})`, {
        status: difyRes.status,
        statusText: difyRes.statusText,
        headers: Object.fromEntries(difyRes.headers.entries()),
      });

      if (!difyRes.ok) {
        const errorText = await difyRes.text();
        logger.log("Dify Error Response", errorText);
        res.statusCode = difyRes.status;
        res.end(errorText);
        return;
      }

      const reader = difyRes.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        res.statusCode = 500;
        res.end("No response body reader available");
        return;
      }

      let buffer = "";
      const toolCallMap = new Map<string, { callId: string; name: string; args: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        // Debug: Monitor buffer fragmentation
        if (lines.length === 1 && buffer.length > 1000) {
          console.warn(
            `[dify-auth] Large SSE buffer detected without newline (${buffer.length} chars). Potential fragmentation issue.`,
          );
        }

        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "") {
            continue;
          }

          logger.log("Dify SSE Line", line);

          if (!line.startsWith("data: ")) {
            continue;
          }
          try {
            const data = JSON.parse(line.slice(6));

            if (data.conversation_id) {
              setConversationId(sessionKey, data.conversation_id, Date.now());
              conversationId = data.conversation_id;
            }

            const event = typeof data.event === "string" ? data.event : "";

            if (event === "message" || event === "agent_message") {
              const content = typeof data.answer === "string" ? data.answer : "";
              if (content) {
                accumulatedText += content;
                if (streamEnabled) {
                  writeOpenResponsesEvent(res, {
                    type: "response.output_text.delta",
                    item_id: outputItemId,
                    output_index: 0,
                    content_index: 0,
                    delta: content,
                  });
                }
              }
            } else if (event === "error") {
              const message = typeof data.message === "string" ? data.message : "Unknown error";
              if (streamEnabled) {
                const failed = createOpenResponsesResource({
                  id: responseId,
                  model,
                  status: "failed",
                  output: [],
                  error: { code: "api_error", message },
                });
                writeOpenResponsesEvent(res, { type: "response.failed", response: failed });
                res.write("data: [DONE]\n\n");
                res.end();
                return;
              }
              res.statusCode = 500;
              res.end(message);
              return;
            }

            const resolvedToolCalls = resolveDifyToolCalls(
              data as Record<string, unknown>,
              params.appType,
            );

            if (resolvedToolCalls.length > 0) {
              for (const toolCall of resolvedToolCalls) {
                const existing = toolCallMap.get(toolCall.callId);

                if (toolCall.isDelta) {
                  // Delta: Append to existing args
                  const currentArgs = existing ? existing.args : "";
                  toolCallMap.set(toolCall.callId, {
                    callId: toolCall.callId,
                    name: toolCall.toolName,
                    args: currentArgs + toolCall.argsString,
                  });
                } else {
                  // Full state: Replace existing args

                  // Safety check: Don't overwrite existing valid args with empty/invalid ones
                  // This prevents node_finished (if parsing fails) from clearing partial args collected from messages
                  const isNewEmpty =
                    toolCall.argsString === "{}" || toolCall.argsString.trim() === "";
                  const isExistingValid =
                    existing && existing.args.length > 2 && existing.args !== "{}";

                  if (isNewEmpty && isExistingValid) {
                    continue;
                  }

                  if (!existing || existing.args.length < toolCall.argsString.length) {
                    toolCallMap.set(toolCall.callId, {
                      callId: toolCall.callId,
                      name: toolCall.toolName,
                      args: toolCall.argsString,
                    });
                  }
                }
              }
            }
          } catch {
            continue;
          }
        }
      }

      lastToolCalls = Array.from(toolCallMap.values());
      if (autoToolLoop && lastToolCalls.length > 0) {
        if (loopCount >= MAX_TOOL_LOOPS) {
          const message = "Tool loop limit reached";
          if (streamEnabled) {
            const failed = createOpenResponsesResource({
              id: responseId,
              model,
              status: "failed",
              output: [],
              error: { code: "tool_loop_limit", message },
            });
            writeOpenResponsesEvent(res, { type: "response.failed", response: failed });
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.statusCode = 500;
          res.end(message);
          return;
        }
        const toolResults = await executeToolCalls({
          req,
          model: payload.model,
          user: userId,
          calls: lastToolCalls.map((call) => ({
            callId: call.callId,
            toolName: call.name,
            argsString: call.args,
          })),
        });
        const cached = toolCache.get(sessionKey);
        currentPayload = {
          inputs: {},
          query: "",
          response_mode: "streaming",
          conversation_id: conversationId,
          user: userId,
          files: [],
          tool_results: toolResults,
          tools: cached?.tools,
          tool_choice: cached?.tool_choice,
        };
        continue;
      }

      break;
    }

    if (!streamEnabled) {
      if (!autoToolLoop && lastToolCalls.length > 0) {
        const messageItem = createOpenResponsesMessageItem({
          id: outputItemId,
          text: accumulatedText || "",
          status: "completed",
        });
        const functionCallItems = lastToolCalls.map((toolCall, index) => ({
          type: "function_call" as const,
          id: `call_${Date.now()}_${index}`,
          call_id: toolCall.callId,
          name: toolCall.name,
          arguments: toolCall.args,
          status: "completed" as const,
        }));
        const response = createOpenResponsesResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [messageItem, ...functionCallItems],
        });
        res.setHeader(HEADER_CONTENT_TYPE, "application/json");
        res.end(JSON.stringify(response));
        return;
      }

      const response = createOpenResponsesResource({
        id: responseId,
        model,
        status: "completed",
        output: [
          createOpenResponsesMessageItem({
            id: outputItemId,
            text: accumulatedText || "",
            status: "completed",
          }),
        ],
      });
      res.setHeader(HEADER_CONTENT_TYPE, "application/json");
      res.end(JSON.stringify(response));
      return;
    }

    const finalText = accumulatedText || "";
    writeOpenResponsesEvent(res, {
      type: "response.output_text.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      text: finalText,
    });
    writeOpenResponsesEvent(res, {
      type: "response.content_part.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: finalText },
    });
    const completedItem = createOpenResponsesMessageItem({
      id: outputItemId,
      text: finalText,
      status: "completed",
    });
    writeOpenResponsesEvent(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedItem,
    });

    const finalOutputItems = [completedItem];

    // Emit function calls if present and not auto-executed
    // Pi SDK requires the full event sequence: output_item.added → function_call_arguments.delta
    // → function_call_arguments.done → output_item.done for arguments to be parsed correctly.
    if (!autoToolLoop && lastToolCalls.length > 0) {
      lastToolCalls.forEach((toolCall, index) => {
        const itemIndex = index + 1;
        const fcItem = {
          type: "function_call" as const,
          id: `call_${Date.now()}_${index}`,
          call_id: toolCall.callId,
          name: toolCall.name,
          arguments: toolCall.args,
          status: "completed" as const,
        };
        writeOpenResponsesEvent(res, {
          type: "response.output_item.added",
          output_index: itemIndex,
          item: fcItem,
        });
        writeOpenResponsesEvent(res, {
          type: "response.function_call_arguments.delta",
          item_id: fcItem.id,
          output_index: itemIndex,
          delta: toolCall.args,
        });
        writeOpenResponsesEvent(res, {
          type: "response.function_call_arguments.done",
          item_id: fcItem.id,
          output_index: itemIndex,
          arguments: toolCall.args,
        });
        writeOpenResponsesEvent(res, {
          type: "response.output_item.done",
          output_index: itemIndex,
          item: fcItem,
        });
        finalOutputItems.push(fcItem);
      });
    }

    const hasToolCalls = !autoToolLoop && lastToolCalls.length > 0;
    const response = createOpenResponsesResource({
      id: responseId,
      model,
      status: hasToolCalls ? "incomplete" : "completed",
      output: finalOutputItems,
    });
    writeOpenResponsesEvent(res, { type: "response.completed", response });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    logger.log("Proxy Error", err);
    res.statusCode = 500;
    res.end(String(err));
  }
}
