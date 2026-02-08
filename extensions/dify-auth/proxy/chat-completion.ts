import type { IncomingMessage, ServerResponse } from "node:http";
import type { DifyPayload } from "../dify/types";
import { HEADER_AUTHORIZATION, HEADER_CONTENT_TYPE, MAX_TOOL_LOOPS } from "../constants";
import { uploadToDify } from "../dify/client";
import { toolCache } from "../tools/cache";
import { executeToolCalls } from "../tools/executor";
import {
  resolveDifyToolCalls,
  stringifyToolOutput,
  resolveToolResultOutput,
  isToolRole,
  resolveToolResultPrefix,
  normalizeToolDefinitions,
  normalizeToolChoice,
  extractToolOutput,
} from "../tools/utils";
import {
  setConversationId,
  getConversationId,
  pruneConversationMap,
  deleteConversation,
} from "../utils/conversation";
import { DifyLogger } from "../utils/logger";
import { transformEvent } from "./stream";

export async function handleChatCompletionProxyRequest(
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
  logger.log("Incoming Request Body", params.body);

  if (typeof params.body !== "object" || params.body === null) {
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }

  const chatBody = params.body as {
    model?: string;
    user?: string;
    tool_call_mode?: string;
    tools?: Array<{
      type?: string;
      function?: { name?: string; description?: string; parameters?: unknown };
    }>;
    tool_choice?: unknown;
    tool_results?: Array<{ tool_call_id?: string; output?: string; is_error?: boolean }>;
    messages?: Array<{
      role?: string;
      name?: string;
      toolName?: string;
      toolCallId?: string;
      toolUseId?: string;
      tool_call_id?: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }>;
  };

  const messages = chatBody.messages || [];
  const toolResults: Array<{ tool_call_id: string; output: string; is_error?: boolean }> = [];
  if (Array.isArray(chatBody.tool_results)) {
    for (const result of chatBody.tool_results) {
      if (!result || typeof result !== "object") {
        continue;
      }
      const toolCallId = typeof result.tool_call_id === "string" ? result.tool_call_id.trim() : "";
      const output = stringifyToolOutput(result.output);
      if (!toolCallId) {
        continue;
      }
      toolResults.push({ tool_call_id: toolCallId, output, is_error: result.is_error });
    }
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    if (!isToolRole(message.role)) {
      console.log(`[DEBUG] Skipping message with role: ${message.role} (not a tool role)`);
      continue;
    }
    console.log(`[DEBUG] Processing tool role message:`, message);
    const toolCallId =
      (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
      (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
      (typeof message.toolUseId === "string" && message.toolUseId.trim()) ||
      "";
    if (!toolCallId) {
      console.warn(`[DEBUG] Tool message missing tool_call_id:`, message);
      continue;
    }
    const output = resolveToolResultOutput(message.content);
    toolResults.push({ tool_call_id: toolCallId, output });
  }
  
  console.log(`[DEBUG] Extracted toolResults:`, JSON.stringify(toolResults));

  const lastMessageEntry = toolResults.length
    ? messages.toReversed().find((message) => !isToolRole(message.role))
    : messages[messages.length - 1];
  const lastMessage = lastMessageEntry?.content ?? "";
  const toolResultPrefix =
    toolResults.length > 0 || !lastMessageEntry ? "" : resolveToolResultPrefix(lastMessageEntry);
  let systemMessage = "";
  for (const message of messages) {
    if (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "system"
    ) {
      if (typeof message.content === "string") {
        systemMessage = message.content;
      }
      break;
    }
  }

  const userId = chatBody.user || "openclaw-user";
  const sessionKey = `${params.apiKey}:${userId}`;
  const now = Date.now();
  pruneConversationMap(now);
  let conversationId = getConversationId(sessionKey, now);

  const isReset =
    typeof lastMessage === "string" && lastMessage.includes("A new session was started");
  if (isReset) {
    conversationId = "";
    deleteConversation(sessionKey);
    toolCache.delete(sessionKey);
  }

  const difyPayload: DifyPayload = {
    inputs: {},
    query: "",
    response_mode: "streaming",
    conversation_id: conversationId,
    user: userId,
    files: [],
  };

  // Ensure tool call mode is always handled by Dify's native capabilities
  // We do not set 'openclaw_text' or other legacy modes here.
  // difyPayload.tool_call_mode = "structured"; // Optional: explicit native mode if needed

  const normalizedTools = normalizeToolDefinitions(chatBody.tools);
  if (normalizedTools) {
    difyPayload.tools = normalizedTools;
  }
  const normalizedToolChoice = normalizeToolChoice(chatBody.tool_choice);
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
  if (Array.isArray(lastMessage)) {
    const textPart = lastMessage.find((p) => p.type === "text");
    if (textPart?.text) {
      difyPayload.query = toolResultPrefix
        ? `${toolResultPrefix}\n${textPart.text}`
        : textPart.text;
    }

    const imageParts = lastMessage.filter((p) => p.type === "image_url");
    for (const img of imageParts) {
      const url = img.image_url?.url;
      if (!url) {
        continue;
      }

      if (url.startsWith("http")) {
        difyPayload.files.push({
          type: "image",
          transfer_method: "remote_url",
          url: url,
        });
      } else {
        try {
          const fileId = await uploadToDify(url, params.apiKey, params.baseUrl, logger);
          difyPayload.files.push({
            type: "image",
            transfer_method: "local_file",
            upload_file_id: fileId,
          });
        } catch {
          // Ignore upload failures for now
        }
      }
    }
  } else {
    const textValue = String(lastMessage);
    // Only set query from lastMessage if it's not empty, or if query is currently empty
    // This prevents overwriting a query that might have been set by other logic (though currently none before this)
    if (textValue || !difyPayload.query) {
      difyPayload.query = toolResultPrefix ? `${toolResultPrefix}\n${textValue}` : textValue;
    }
  }

  // Final check: If we have tool results but query is empty (because lastMessage was empty/null),
  // use the tool outputs as the query.
  if (toolResults.length > 0) {
    difyPayload.tool_results = toolResults;
    if (!difyPayload.query || difyPayload.query.trim() === "") {
      console.log(`[DEBUG] Query is empty, auto-filling with tool results...`);
      const combinedOutput = toolResults
        .map((r) => `[Tool Result: ${r.tool_call_id}] ${r.output}`)
        .join("\n\n");
      difyPayload.query = combinedOutput || ".";
      console.log(`[DEBUG] Auto-filled query:`, difyPayload.query);
    }
  } else if (!difyPayload.query) {
    difyPayload.query = ".";
    console.log(`[DEBUG] Query empty (no tool results), filled with dot.`);
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

  if (!conversationId && systemMessage && typeof difyPayload.query === "string") {
    difyPayload.query = `${systemMessage}\n\n${difyPayload.query}`;
  }

  logger.log("Constructed Dify Payload", difyPayload);

  try {
    const endpoint = "/chat-messages";
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const autoToolLoop = false;
    let loopCount = 0;
    let roleSent = false;
    let currentPayload = difyPayload;

    res.setHeader(HEADER_CONTENT_TYPE, "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

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
        body: currentPayload, // Log as object for readability
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
        console.error("[dify-auth] No response body reader available");
        res.end();
        return;
      }

      let buffer = "";
      const toolCallMap = new Map<
        string,
        { callId: string; toolName: string; argsString: string }
      >();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "") {
            continue;
          }

          logger.log("Dify SSE Line", line);

          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.conversation_id) {
                setConversationId(sessionKey, data.conversation_id, Date.now());
                conversationId = data.conversation_id;
              }

              const event = typeof data.event === "string" ? data.event : "";

              if (event === "message" || event === "agent_message") {
                // Keep track of answer content if needed, but we don't parse text tools anymore
                // const content = typeof data.answer === "string" ? data.answer : "";
                // if (content) {
                //   accumulatedText += content;
                // }
              }

              const resolvedToolCalls = resolveDifyToolCalls(
                data as Record<string, unknown>,
                params.appType,
              );

              if (resolvedToolCalls.length > 0) {
                for (const toolCall of resolvedToolCalls) {
                  const existing = toolCallMap.get(toolCall.callId);
                  let shouldEmit = false;
                  let argsToEmit = "";

                  if (toolCall.isDelta) {
                    // Delta: Append to existing args
                    const currentArgs = existing ? existing.argsString : "";
                    argsToEmit = toolCall.argsString;
                    toolCallMap.set(toolCall.callId, {
                      ...toolCall,
                      argsString: currentArgs + toolCall.argsString,
                    });
                    shouldEmit = true;
                  } else {
                    // Full state: Replace existing args
                    
                    // Safety check: Don't overwrite existing valid args with empty/invalid ones
                    const isNewEmpty = toolCall.argsString === "{}" || toolCall.argsString.trim() === "";
                    const isExistingValid = existing && existing.argsString.length > 2 && existing.argsString !== "{}";
                    
                    if (isNewEmpty && isExistingValid) {
                        continue;
                    }

                    toolCallMap.set(toolCall.callId, toolCall);
                    
                    // Only emit if we haven't seen this tool call or it has no args yet
                    // This avoids duplicating args if we receive full state after deltas
                    if (!existing || !existing.argsString) {
                        shouldEmit = true;
                        argsToEmit = toolCall.argsString;
                    }
                  }

                  if (shouldEmit && !autoToolLoop) {
                    // Calculate index based on all unique calls so far
                    const allCalls = Array.from(toolCallMap.values());
                    const toolCallIndex = allCalls.findIndex((c) => c.callId === toolCall.callId);

                    const chunk = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model: "dify-app",
                      choices: [
                        {
                          index: 0,
                          delta: {
                            ...(roleSent ? {} : { role: "assistant" }),
                            tool_calls: [
                              {
                                index: toolCallIndex,
                                id: toolCall.callId,
                                type: "function",
                                function: {
                                  name: toolCall.toolName,
                                  arguments: argsToEmit,
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    };
                    roleSent = true;
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                }
              }

              const openaiChunk = transformEvent(data);
              if (openaiChunk) {
                if (!roleSent) {
                  roleSent = true;
                  res.write(
                    `data: ${JSON.stringify({
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model: "dify-app",
                      choices: [{ index: 0, delta: { role: "assistant" } }],
                    })}\n\n`,
                  );
                }
                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
              }
            } catch (e) {
              console.warn("[dify-auth] Parse error:", e, "Line:", line);
            }
          }
        }
      }

      const pendingToolCalls = Array.from(toolCallMap.values());
      if (autoToolLoop && pendingToolCalls.length > 0) {
        if (loopCount >= MAX_TOOL_LOOPS) {
          res.write(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model: "dify-app",
              choices: [
                {
                  index: 0,
                  delta: { content: "Tool loop limit reached" },
                  finish_reason: "stop",
                },
              ],
            })}\n\n`,
          );
          break;
        }
        const toolResults = await executeToolCalls({
          req,
          model: chatBody.model,
          user: userId,
          calls: pendingToolCalls,
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

      if (!autoToolLoop && pendingToolCalls.length > 0) {
        const doneChunk = {
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model: "dify-app",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      }

      break;
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    logger.log("Proxy Error", err);
    console.error("[dify-auth] Proxy error:", err);
    res.statusCode = 500;
    res.end(String(err));
  }
}
