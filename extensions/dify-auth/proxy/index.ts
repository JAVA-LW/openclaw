import type { IncomingMessage, ServerResponse } from "node:http";
import { PROXY_PATH, OPEN_RESPONSES_PATHS } from "../constants.js";
import { parseCompositeKey } from "../utils/auth.js";
import { DifyLogger } from "../utils/logger.js";
import { enqueue, isBusy } from "../utils/request-queue.js";
import { handleChatCompletionProxyRequest } from "./chat-completion.js";
import { handleOpenResponsesProxyRequest } from "./open-responses.js";

const isOpenResponsesPath = (pathname: string) =>
  OPEN_RESPONSES_PATHS.some(
    (path) =>
      pathname === `${PROXY_PATH}${path}` ||
      pathname === `${PROXY_PATH}${path}/` ||
      pathname.endsWith(path) ||
      pathname.endsWith(`${path}/`),
  );

export async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
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

  // DEBUG: Log request structure to identify how OpenClaw sends tool results
  const debugBody = body as Record<string, unknown>;
  const debugMessages = Array.isArray(debugBody.messages) ? debugBody.messages : null;
  const debugInput = debugBody.input;
  const debugLogger = new DifyLogger("request-debug");
  debugLogger.log("REQUEST DEBUG", {
    path: url.pathname,
    isOpenResponses: isOpenResponsesPath(url.pathname),
    hasMessages: !!debugMessages,
    messageCount: debugMessages?.length,
    messageRoles: debugMessages?.map((m: any) => m.role),
    inputType: typeof debugInput,
    inputIsArray: Array.isArray(debugInput),
    inputItemTypes: Array.isArray(debugInput) ? debugInput.map((i: any) => i?.type) : null,
    hasToolResults: Array.isArray(debugBody.tool_results),
  });

  const parsedBody = body as Record<string, unknown>;
  const userId = (typeof parsedBody?.user === "string" && parsedBody.user) || "openclaw-user";
  const sessionKey = `${apiKey}:${userId}`;
  const wasBusy = isBusy(sessionKey);

  await enqueue(sessionKey, async () => {
    if (isOpenResponsesPath(url.pathname)) {
      await handleOpenResponsesProxyRequest(req, res, {
        apiKey,
        baseUrl,
        appType,
        body,
        wasBusy,
      });
    } else {
      await handleChatCompletionProxyRequest(req, res, {
        apiKey,
        baseUrl,
        appType,
        body,
        wasBusy,
      });
    }
  });
}
