import type { IncomingMessage, ServerResponse } from "node:http";
import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";

const PROVIDER_ID = "dify";
const PROVIDER_LABEL = "dify";
const PROXY_PATH = "/plugins/dify-auth/proxy";
const DEFAULT_BASE_URL = "https://api.dify.ai/v1";
const HEADER_AUTHORIZATION = "Authorization";
const HEADER_CONTENT_TYPE = "Content-Type";
const OPEN_RESPONSES_PATH = "/v1/responses";

// Helper to manage the composite key format: apiKey;baseUrl;appType
const createCompositeKey = (apiKey: string, baseUrl: string, appType: string) =>
  `${apiKey};${baseUrl};${appType}`;

const parseCompositeKey = (compositeKey: string) => {
  const parts = compositeKey.split(";");
  return {
    apiKey: parts[0] || "",
    baseUrl: parts[1] || "",
    appType: (parts[2] || "chat") as "chat" | "agent",
  };
};

const resolveToolArguments = (input: unknown) => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : "{}";
  }
  return JSON.stringify(input ?? {});
};

const resolveToolCallId = (candidate: unknown) => {
  if (typeof candidate === "string" || typeof candidate === "number") {
    const value = String(candidate).trim();
    if (!value) {
      return "";
    }
    return value.startsWith("call_") ? value : `call_${value}`;
  }
  return "";
};

const resolveDifyToolCall = (data: Record<string, unknown>, appType: "chat" | "agent") => {
  const event = typeof data.event === "string" ? data.event : "";
  if (event === "agent_thought" && appType === "agent") {
    const toolName = typeof data.tool === "string" ? data.tool.trim() : "";
    if (!toolName) {
      return null;
    }
    const argsString = resolveToolArguments(data.tool_input);
    const callId =
      resolveToolCallId(data.tool_call_id) ||
      resolveToolCallId(data.id) ||
      resolveToolCallId(data.task_id) ||
      `call_${Date.now()}`;
    return { toolName, argsString, callId };
  }
  if (event === "tool_call") {
    const toolName = typeof data.name === "string" ? data.name.trim() : "";
    if (!toolName) {
      return null;
    }
    const argsString = resolveToolArguments(data.arguments);
    const callId =
      resolveToolCallId(data.tool_call_id) ||
      resolveToolCallId(data.task_id) ||
      `call_${Date.now()}`;
    return { toolName, argsString, callId };
  }
  return null;
};

const isOpenResponsesPath = (pathname: string) =>
  pathname === `${PROXY_PATH}${OPEN_RESPONSES_PATH}` ||
  pathname === `${PROXY_PATH}${OPEN_RESPONSES_PATH}/` ||
  pathname.endsWith(OPEN_RESPONSES_PATH) ||
  pathname.endsWith(`${OPEN_RESPONSES_PATH}/`);

const isToolRole = (role?: string) => {
  const normalized = role?.toLowerCase() ?? "";
  return normalized === "tool" || normalized === "tool_result" || normalized === "toolresult";
};

const resolveToolResultOutput = (
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
) => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
};

const resolveToolResultPrefix = (message: {
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

async function verifyDifyKey(apiKey: string, baseUrl: string) {
  const res = await fetch(`${baseUrl}/site`, {
    headers: { [HEADER_AUTHORIZATION]: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Status ${res.status}`);
  }
  return (await res.json()) as { title?: string };
}

const difyAuthPlugin = {
  id: "dify-auth",
  name: "Dify Auth",
  description: "Dify provider authentication and proxy",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 1. Register HTTP Proxy Route
    api.registerHttpRoute({ path: PROXY_PATH, handler: handleProxyRequest });

    // 2. Register Provider
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      auth: [
        {
          id: "dify-api-key",
          label: "Dify API Key",
          hint: "API Key & Base URL",
          kind: "api_key",
          run: async (ctx) => {
            // Ask for API Key
            const apiKey = await ctx.prompter.text({
              message: "Enter Dify App API Key",
              validate: (val) => (val?.trim().length > 5 ? undefined : "Invalid Key"),
            });

            // Ask for Base URL
            const baseUrl = await ctx.prompter.text({
              message: "Enter Dify API Base URL",
              initialValue: DEFAULT_BASE_URL,
              validate: (val) =>
                val?.startsWith("http") ? undefined : "Must start with http/https",
            });

            // Ask for App Type
            const appType = await ctx.prompter.select({
              message: "Select App Type",
              options: [
                { value: "chat", label: "ChatFlow" },
                { value: "agent", label: "Agent" },
              ],
            });

            // Verify Key
            const progress = ctx.prompter.progress("Verifying Dify API Key...");
            let siteInfo: { title?: string } = {};
            try {
              siteInfo = await verifyDifyKey(apiKey, baseUrl);
              progress.stop(`Verified: ${siteInfo.title || "Dify App"}`);
            } catch (err) {
              progress.stop("Verification failed");
              throw new Error(`Failed to verify key: ${String(err)}`, { cause: err });
            }

            // Construct Config Patch
            const compositeKey = createCompositeKey(apiKey, baseUrl, appType);

            // Resolve Gateway Port (default to 18789 if not found)
            const gatewayPort = ctx.config.gateway?.port ?? 18789;
            const proxyUrl = `http://127.0.0.1:${gatewayPort}${PROXY_PATH}`;

            // Determine Model ID
            const modelId = appType === "chat" ? "chat-flow" : "agent";
            const defaultName = appType === "chat" ? "Dify ChatFlow" : "Dify Agent";

            return {
              profiles: [
                {
                  profileId: `${PROVIDER_ID}:default`,
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: compositeKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: proxyUrl,
                      apiKey: compositeKey,
                      api: "openai-completions",
                      models: [
                        {
                          id: modelId,
                          name: siteInfo.title || defaultName,
                          contextWindow: 16000,
                          maxTokens: 4096,
                          // Fix: Add missing required properties
                          reasoning: false,
                          input: ["text", "image"],
                          cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                          },
                        },
                      ],
                    },
                  },
                },
                agents: {
                  defaults: {
                    model: {
                      primary: `${PROVIDER_ID}/${modelId}`,
                    },
                  },
                },
              },
            };
          },
        },
      ],
    });
  },
};

const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const MAX_CONVERSATIONS = 1000;

const conversationMap = new Map<string, { id: string; lastSeen: number }>();

const pruneConversationMap = (now: number) => {
  for (const [key, entry] of conversationMap) {
    if (now - entry.lastSeen > CONVERSATION_TTL_MS) {
      conversationMap.delete(key);
    }
  }
  if (conversationMap.size <= MAX_CONVERSATIONS) {
    return;
  }
  const entries = Array.from(conversationMap.entries()).toSorted(
    (a, b) => a[1].lastSeen - b[1].lastSeen,
  );
  const overflow = entries.length - MAX_CONVERSATIONS;
  for (let i = 0; i < overflow; i += 1) {
    conversationMap.delete(entries[i][0]);
  }
};

const getConversationId = (sessionKey: string, now: number) => {
  const entry = conversationMap.get(sessionKey);
  if (!entry) {
    return "";
  }
  entry.lastSeen = now;
  return entry.id;
};

const setConversationId = (sessionKey: string, id: string, now: number) => {
  conversationMap.set(sessionKey, { id, lastSeen: now });
};

// Proxy Handler
async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  // Parse Headers
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.statusCode = 401;
    res.end("Missing Authorization");
    return;
  }

  const compositeKey = authHeader.replace("Bearer ", "").trim();
  const { apiKey, baseUrl, appType } = parseCompositeKey(compositeKey);

  if (!apiKey || !baseUrl) {
    res.statusCode = 401;
    res.end("Invalid Authorization Format");
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  // Read Body
  const buffers: Buffer[] = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const bodyStr = Buffer.concat(buffers).toString();
  let body: unknown;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }

  if (isOpenResponsesPath(url.pathname)) {
    await handleOpenResponsesProxyRequest(req, res, {
      apiKey,
      baseUrl,
      appType,
      body,
    });
    return;
  }

  if (typeof body !== "object" || body === null) {
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }

  const chatBody = body as {
    user?: string;
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
      const output = typeof result.output === "string" ? result.output : "";
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
      continue;
    }
    const toolCallId =
      (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
      (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
      (typeof message.toolUseId === "string" && message.toolUseId.trim()) ||
      "";
    if (!toolCallId) {
      continue;
    }
    const output = resolveToolResultOutput(message.content);
    toolResults.push({ tool_call_id: toolCallId, output });
  }

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
  const sessionKey = `${apiKey}:${userId}`;
  const now = Date.now();
  pruneConversationMap(now);
  let conversationId = getConversationId(sessionKey, now);

  const isReset =
    typeof lastMessage === "string" && lastMessage.includes("A new session was started");
  if (isReset) {
    conversationId = "";
    conversationMap.delete(sessionKey);
  }

  const difyPayload: {
    inputs: Record<string, unknown>;
    query: string;
    response_mode: string;
    conversation_id: string;
    user: string;
    files: Array<{
      type: string;
      transfer_method: string;
      url?: string;
      upload_file_id?: string;
    }>;
    tools?: Array<{
      type: string;
      function: { name: string; description?: string; parameters: unknown };
    }>;
    tool_choice?: unknown;
    tool_results?: Array<{ tool_call_id: string; output: string; is_error?: boolean }>;
  } = {
    inputs: {},
    query: "",
    response_mode: "streaming",
    conversation_id: conversationId,
    user: userId,
    files: [],
  };

  if (Array.isArray(chatBody.tools)) {
    difyPayload.tools = chatBody.tools
      .map((tool) => {
        if (!tool || typeof tool !== "object" || tool.type !== "function") {
          return null;
        }
        const func = tool.function;
        if (!func || typeof func !== "object") {
          return null;
        }
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
      })
      .filter(
        (
          tool,
        ): tool is {
          type: string;
          function: { name: string; description?: string; parameters: unknown };
        } => tool !== null,
      );
  }
  if (typeof chatBody.tool_choice !== "undefined") {
    difyPayload.tool_choice = chatBody.tool_choice;
  }
  if (toolResults.length > 0) {
    difyPayload.tool_results = toolResults;
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
          const fileId = await uploadToDify(url, apiKey, baseUrl);
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
    difyPayload.query = toolResultPrefix ? `${toolResultPrefix}\n${textValue}` : textValue;
  }

  if (!conversationId && systemMessage && typeof difyPayload.query === "string") {
    difyPayload.query = `${systemMessage}\n\n${difyPayload.query}`;
  }

  try {
    const endpoint = "/chat-messages";
    const difyRes = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        [HEADER_AUTHORIZATION]: `Bearer ${apiKey}`,
        [HEADER_CONTENT_TYPE]: "application/json",
      },
      body: JSON.stringify(difyPayload),
    });

    if (!difyRes.ok) {
      res.statusCode = difyRes.status;
      res.end(await difyRes.text());
      return;
    }

    res.setHeader(HEADER_CONTENT_TYPE, "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = difyRes.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      console.error("[dify-auth] No response body reader available");
      res.end();
      return;
    }

    let buffer = "";
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    let roleSent = false;
    let toolCallEmitted = false;

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
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));

            if (data.conversation_id && !conversationMap.has(sessionKey)) {
              setConversationId(sessionKey, data.conversation_id, Date.now());
            } else if (
              data.conversation_id &&
              conversationMap.get(sessionKey)?.id !== data.conversation_id
            ) {
              setConversationId(sessionKey, data.conversation_id, Date.now());
            } else if (data.conversation_id) {
              setConversationId(sessionKey, data.conversation_id, Date.now());
            }

            const toolCall = resolveDifyToolCall(data as Record<string, unknown>, appType);
            if (toolCall) {
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
                          index: 0,
                          id: toolCall.callId,
                          type: "function",
                          function: {
                            name: toolCall.toolName,
                            arguments: toolCall.argsString,
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
              toolCallEmitted = true;
              break;
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
      if (toolCallEmitted) {
        break;
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[dify-auth] Proxy error:", err);
    res.statusCode = 500;
    res.end(String(err));
  }
}

async function uploadToDify(imageUrl: string, apiKey: string, baseUrl: string): Promise<string> {
  const blob = await (await fetch(imageUrl)).blob();
  const formData = new FormData();
  formData.append("file", blob, "image.png");
  formData.append("user", "openclaw-user");

  const res = await fetch(`${baseUrl}/files/upload`, {
    method: "POST",
    headers: { [HEADER_AUTHORIZATION]: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  return json.id;
}

async function uploadBase64ToDify(params: {
  data: string;
  mediaType: string;
  apiKey: string;
  baseUrl: string;
  filename?: string;
}): Promise<string> {
  const buffer = Buffer.from(params.data, "base64");
  const blob = new Blob([buffer], { type: params.mediaType });
  const formData = new FormData();
  formData.append("file", blob, params.filename || "file");
  formData.append("user", "openclaw-user");

  const res = await fetch(`${params.baseUrl}/files/upload`, {
    method: "POST",
    headers: { [HEADER_AUTHORIZATION]: `Bearer ${params.apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  return json.id;
}

function writeOpenResponsesEvent(
  res: ServerResponse,
  event: { type: string; [key: string]: unknown },
) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createOpenResponsesUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

function createOpenResponsesResource(params: {
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

function createOpenResponsesMessageItem(params: {
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
      if (type === "input_text" && typeof text === "string") {
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
    if (type !== "input_image") {
      continue;
    }
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
  }
  return images;
}

async function handleOpenResponsesProxyRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  params: {
    apiKey: string;
    baseUrl: string;
    appType: "chat" | "agent";
    body: unknown;
  },
) {
  if (!params.body || typeof params.body !== "object") {
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }
  const payload = params.body as {
    model?: string;
    input?: unknown;
    instructions?: string;
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
  if (inputItems) {
    for (const item of inputItems) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const type = (item as { type?: unknown }).type;
      if (type === "function_call_output") {
        const callId = (item as { call_id?: unknown }).call_id;
        const output = (item as { output?: unknown }).output;
        if (typeof callId === "string" && typeof output === "string") {
          toolResults.push({ tool_call_id: callId, output });
        }
        continue;
      }
      if (type === "message") {
        const role = (item as { role?: unknown }).role;
        const content = (item as { content?: unknown }).content;
        messageItems.push({ role: typeof role === "string" ? role : undefined, content });
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
  const query = inputString || textFromContent;

  const userId = payload.user || "openclaw-user";
  const sessionKey = `${params.apiKey}:${userId}`;
  const now = Date.now();
  pruneConversationMap(now);
  let conversationId = getConversationId(sessionKey, now);

  const isReset = typeof query === "string" && query.includes("A new session was started");
  if (isReset) {
    conversationId = "";
    conversationMap.delete(sessionKey);
  }

  const difyPayload: {
    inputs: Record<string, unknown>;
    query: string;
    response_mode: string;
    conversation_id: string;
    user: string;
    files: Array<{
      type: string;
      transfer_method: string;
      url?: string;
      upload_file_id?: string;
    }>;
    tools?: Array<{
      type: string;
      function: { name: string; description?: string; parameters: unknown };
    }>;
    tool_choice?: unknown;
    tool_results?: Array<{ tool_call_id: string; output: string; is_error?: boolean }>;
  } = {
    inputs: {},
    query: query || "",
    response_mode: "streaming",
    conversation_id: conversationId,
    user: userId,
    files: [],
  };

  if (Array.isArray(payload.tools)) {
    difyPayload.tools = payload.tools
      .map((tool) => {
        if (!tool || typeof tool !== "object" || tool.type !== "function") {
          return null;
        }
        const func = tool.function;
        if (!func || typeof func !== "object") {
          return null;
        }
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
      })
      .filter(
        (
          tool,
        ): tool is {
          type: string;
          function: { name: string; description?: string; parameters: unknown };
        } => tool !== null,
      );
  }
  if (typeof payload.tool_choice !== "undefined") {
    difyPayload.tool_choice = payload.tool_choice;
  }
  if (toolResults.length > 0) {
    difyPayload.tool_results = toolResults;
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

  try {
    const endpoint = "/chat-messages";
    const difyRes = await fetch(`${params.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        [HEADER_AUTHORIZATION]: `Bearer ${params.apiKey}`,
        [HEADER_CONTENT_TYPE]: "application/json",
      },
      body: JSON.stringify(difyPayload),
    });

    if (!difyRes.ok) {
      res.statusCode = difyRes.status;
      res.end(await difyRes.text());
      return;
    }

    const streamEnabled = payload.stream !== false;
    if (streamEnabled) {
      res.setHeader(HEADER_CONTENT_TYPE, "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    }

    const reader = difyRes.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      res.statusCode = 500;
      res.end("No response body reader available");
      return;
    }

    let buffer = "";
    const responseId = `response_${Date.now()}`;
    const outputItemId = `msg_${Date.now()}`;
    const model =
      typeof payload.model === "string" && payload.model.trim() ? payload.model : "dify-app";
    let accumulatedText = "";
    let toolCallEmitted = false;
    let toolCallPayload: { callId: string; name: string; args: string } | null = null;

    if (streamEnabled) {
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
        if (!line.startsWith("data: ")) {
          continue;
        }
        try {
          const data = JSON.parse(line.slice(6));

          if (data.conversation_id && !conversationMap.has(sessionKey)) {
            setConversationId(sessionKey, data.conversation_id, Date.now());
          } else if (
            data.conversation_id &&
            conversationMap.get(sessionKey)?.id !== data.conversation_id
          ) {
            setConversationId(sessionKey, data.conversation_id, Date.now());
          } else if (data.conversation_id) {
            setConversationId(sessionKey, data.conversation_id, Date.now());
          }

          const toolCall = resolveDifyToolCall(data as Record<string, unknown>, params.appType);
          if (toolCall) {
            toolCallPayload = {
              callId: toolCall.callId,
              name: toolCall.toolName,
              args: toolCall.argsString,
            };
            toolCallEmitted = true;
            break;
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
        } catch {
          continue;
        }
      }
      if (toolCallEmitted) {
        break;
      }
    }

    if (!streamEnabled) {
      if (toolCallPayload) {
        const messageItem = createOpenResponsesMessageItem({
          id: outputItemId,
          text: accumulatedText || "",
          status: "completed",
        });
        const functionCallItem = {
          type: "function_call" as const,
          id: `call_${Date.now()}`,
          call_id: toolCallPayload.callId,
          name: toolCallPayload.name,
          arguments: toolCallPayload.args,
          status: "completed" as const,
        };
        const response = createOpenResponsesResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [messageItem, functionCallItem],
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
    if (toolCallPayload) {
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
      const functionCallItem = {
        type: "function_call" as const,
        id: `call_${Date.now()}`,
        call_id: toolCallPayload.callId,
        name: toolCallPayload.name,
        arguments: toolCallPayload.args,
        status: "completed" as const,
      };
      writeOpenResponsesEvent(res, {
        type: "response.output_item.added",
        output_index: 1,
        item: functionCallItem,
      });
      writeOpenResponsesEvent(res, {
        type: "response.output_item.done",
        output_index: 1,
        item: functionCallItem,
      });
      const response = createOpenResponsesResource({
        id: responseId,
        model,
        status: "incomplete",
        output: [completedItem, functionCallItem],
      });
      writeOpenResponsesEvent(res, { type: "response.completed", response });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

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
    const response = createOpenResponsesResource({
      id: responseId,
      model,
      status: "completed",
      output: [completedItem],
    });
    writeOpenResponsesEvent(res, { type: "response.completed", response });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
}

function transformEvent(difyData: {
  event: string;
  answer?: string;
  thought?: string;
  message?: string;
  task_id?: string;
}) {
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

export default difyAuthPlugin;
