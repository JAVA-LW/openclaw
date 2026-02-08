import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { handleChatCompletionProxyRequest } from "../proxy/chat-completion";

// Mock global fetch
const originalFetch = global.fetch;
global.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
  console.log(`[MockFetch] Request to: ${url}`);
  if (options?.body) {
    console.log(`[MockFetch] Body: ${options.body}`);
    const body = JSON.parse(options.body as string);
    if (body.tool_results && body.tool_results.length > 0) {
      console.log(`[MockFetch] SUCCESS: Found ${body.tool_results.length} tool_results.`);
      // Simulate success response from Dify
      return new Response("data: [DONE]\n\n", { status: 200 });
    } else {
      // If query matches the user message and NO tool results, this is the bug condition
      if (body.query && body.query.includes("search for 'openclaw'")) {
        console.log(
          `[MockFetch] FAILURE: Query found but NO tool_results! This reproduces the 400 error condition.`,
        );
        // Simulate Dify 400
        return new Response(
          JSON.stringify({
            error: {
              message:
                "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.",
              code: "invalid_request_error",
            },
          }),
          { status: 400 },
        );
      } else if (body.query && body.query.includes("sessions_history")) {
        // Simulate Dify returning a node_finished event with tool_calls
        const nodeFinishedEvent = {
          event: "node_finished",
          conversation_id: "27ffe1ad-a390-44bc-80e3-a8c36f1168c3",
          data: {
            outputs: {
              tool_calls: [
                {
                  id: "call_00_2mJlZ8ZNtbDgiNfH1qwlhfsm",
                  type: "function",
                  function: {
                    name: "sessions_history",
                    arguments: '{"sessionKey": "main", "limit": 50}',
                  },
                },
              ],
            },
          },
        };
        return new Response(`data: ${JSON.stringify(nodeFinishedEvent)}\n\n`, { status: 200 });
      }
    }
  }
  return new Response("OK", { status: 200 });
};

async function runTest() {
  console.log("Running repro_tool_proxy.ts...");

  // 配置真实后端信息
  const DIFY_API_KEY = "app-HzrQf5Bf3UnXoiFsl2H3l1yt";
  const DIFY_BASE_URL = "http://localhost:5001/v1"; // 假设本地运行的 Dify API 端口

  // Helper to create mock request/response
  const createMockReqRes = () => {
    const req = new IncomingMessage(new Socket());
    const res = new ServerResponse(req);
    let responseBody = "";
    res.write = (chunk: any) => {
      const text = chunk.toString();
      responseBody += text;
      process.stdout.write(text);
      return true;
    };
    res.end = (chunk: any) => {
      if (chunk) {
        const text = chunk.toString();
        responseBody += text;
        process.stdout.write(text);
      }
      return res;
    };
    res.setHeader = (name, value) => {
      return res;
    };
    // Mock status code setter
    Object.defineProperty(res, "statusCode", {
      set: (code) => {
        console.log(`[Status] ${code}`);
      },
      get: () => 200,
    });

    return { req, res, getBody: () => responseBody };
  };

  // --- Case 8: Malformed/Non-Standard JSON Arguments ---
  console.log("\n--- Case 8: Malformed/Non-Standard JSON Arguments ---");
  const { req: req8, res: res8 } = createMockReqRes();
  const requestBody8 = {
    model: "dify-app",
    user: "openclaw-user",
    messages: [{ role: "user", content: "read file" }],
  };

  // Override fetch for this case to return malformed JSON args
  global.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.body) {
      const body = JSON.parse(options.body as string);
      if (body.query && body.query.includes("read file")) {
        const malformedEvent = {
          event: "node_finished",
          data: {
            outputs: {
              tool_calls: [
                {
                  id: "call_malformed_1",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: "{'path': '/tmp/test.txt'}", // Single quotes (invalid JSON)
                  },
                },
              ],
            },
          },
        };
        return new Response(`data: ${JSON.stringify(malformedEvent)}\n\n`, { status: 200 });
      }
    }
    return new Response("OK", { status: 200 });
  };

  try {
    await handleChatCompletionProxyRequest(req8, res8, {
      apiKey: DIFY_API_KEY,
      baseUrl: DIFY_BASE_URL,
      appType: "chat",
      body: requestBody8,
    });
    console.log("\n\nTest Case 8 finished.");
  } catch (error) {
    console.error("Test Case 8 execution failed:", error);
  }

  // --- Case 9: Simulation from Log (exec dir) ---
  console.log("\n--- Case 9: Simulation from Log (exec dir) ---");
  const { req: req9, res: res9 } = createMockReqRes();
  const requestBody9 = {
    model: "dify-app",
    user: "openclaw-user",
    messages: [{ role: "user", content: "check local dir" }],
  };

  // Override fetch for this case
  global.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.body) {
      const body = JSON.parse(options.body as string);
      if (body.query && body.query.includes("check local dir")) {
        const logEvent = {
          event: "node_finished",
          conversation_id: "0cac4a58-ced2-49a8-ac5f-2ecd8e0a4dba",
          task_id: "1309d0b1-6bb4-4a17-8a97-900f52eeb221",
          data: {
            outputs: {
              text: "I need to check the current directory to see what's in it. Let me use the exec command to list the contents.",
              tool_calls: [
                {
                  id: "call_00_wMKLtJdTdk8kwgZpKaaqTzvf",
                  type: "function",
                  function: {
                    name: "exec",
                    arguments: '{"command": "dir \\"C:\\\\Users\\\\Lw\\\\.local\\""}',
                  },
                },
              ],
            },
          },
        };
        return new Response(`data: ${JSON.stringify(logEvent)}\n\n`, { status: 200 });
      }
    }
    return new Response("OK", { status: 200 });
  };

  try {
    await handleChatCompletionProxyRequest(req9, res9, {
      apiKey: DIFY_API_KEY,
      baseUrl: DIFY_BASE_URL,
      appType: "chat",
      body: requestBody9,
    });
    console.log("\n\nTest Case 9 finished.");
  } catch (error) {
    console.error("Test Case 9 execution failed:", error);
  }

  // --- Case 10: Simulation of Tool Result Submission (Client -> Proxy -> Dify) ---
  console.log("\n--- Case 10: Simulation of Tool Result Submission ---");
  const { req: req10, res: res10 } = createMockReqRes();
  const requestBody10 = {
    model: "dify-app",
    user: "openclaw-user",
    messages: [
      { role: "user", content: "check local dir" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_00_wMKLtJdTdk8kwgZpKaaqTzvf",
            type: "function",
            function: {
              name: "exec",
              arguments: '{"command": "dir \\"C:\\\\Users\\\\Lw\\\\.local\\""}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_00_wMKLtJdTdk8kwgZpKaaqTzvf",
        name: "exec",
        content:
          "Volume in drive C has no label.\n Directory of C:\\Users\\Lw\\.local\n\n02/08/2026  09:00 PM    <DIR>          .\n",
      },
    ],
  };

  // Override fetch for this case
  global.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.body) {
      const body = JSON.parse(options.body as string);
      console.log("[MockFetch] Dify Request Body:", JSON.stringify(body, null, 2));

      // Check if tool_results are present and correct
      if (body.tool_results && body.tool_results.length > 0) {
        const result = body.tool_results[0];
        if (result.tool_call_id === "call_00_wMKLtJdTdk8kwgZpKaaqTzvf" && result.output) {
          console.log("[MockFetch] SUCCESS: Received correct tool_result.");
          // Simulate Dify accepting the tool result and continuing (or finishing)
          return new Response("data: [DONE]\n\n", { status: 200 });
        } else {
          console.log("[MockFetch] FAILURE: tool_result ID or output mismatch.");
        }
      } else {
        console.log("[MockFetch] FAILURE: No tool_results found in request body!");
      }
    }
    return new Response("OK", { status: 200 });
  };

  try {
    await handleChatCompletionProxyRequest(req10, res10, {
      apiKey: DIFY_API_KEY,
      baseUrl: DIFY_BASE_URL,
      appType: "chat",
      body: requestBody10,
    });
    console.log("\n\nTest Case 10 finished.");
  } catch (error) {
    console.error("Test Case 10 execution failed:", error);
  }

  // --- Case 11: Full Multi-turn Simulation from Logs ---
  console.log("\n--- Case 11: Full Multi-turn Simulation from Logs ---");

  // Define the tool calls from the log
  const TOOL_CALL_1_ID = "call_00_9maVwWBDpHOEAxWuShUM31fP";
  const TOOL_CALL_2_ID = "call_00_X5fv3skZsa9OZKRss2xFHgEr";
  const USER_QUERY =
    "[Sun 2026-02-08 21:57 GMT+8] C:\\Users\\Lw\\.local 帮我看看这目录下有什么\n[message_id: 89bcdefc-306b-4f80-90ec-f5285d681195]";

  // Helper to run a request
  const runRequest = async (messages: any[], stepName: string) => {
    console.log(`\n[Case 11] Running ${stepName}...`);
    const { req, res } = createMockReqRes();
    const requestBody = {
      model: "dify-app",
      user: "openclaw-user",
      messages: messages,
    };

    try {
      await handleChatCompletionProxyRequest(req, res, {
        apiKey: DIFY_API_KEY,
        baseUrl: DIFY_BASE_URL,
        appType: "chat",
        body: requestBody,
      });
      console.log(`[Case 11] ${stepName} finished.`);
    } catch (error) {
      console.error(`[Case 11] ${stepName} failed:`, error);
    }
  };

  // Override fetch to simulate the Dify state machine based on input
  global.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.body) {
      const body = JSON.parse(options.body as string);
      console.log(
        `[MockFetch] Dify Request Body (Partial): tool_results count=${body.tool_results?.length || 0}`,
      );

      // Step 1: Initial Query -> Returns Tool Call 1
      if (!body.tool_results || body.tool_results.length === 0) {
        console.log("[MockFetch] Returning Tool Call 1");
        const event1 = {
          event: "node_finished",
          conversation_id: "c0e0f16f-9feb-4350-89c3-4d15b6a4cc16",
          data: {
            outputs: {
              tool_calls: [
                {
                  id: TOOL_CALL_1_ID,
                  type: "function",
                  function: {
                    name: "exec",
                    arguments: '{"command": "dir \\"C:\\\\Users\\\\Lw\\\\.local\\""}',
                  },
                },
              ],
            },
          },
        };
        return new Response(`data: ${JSON.stringify(event1)}\n\n`, { status: 200 });
      }

      // Step 2: First Tool Result Submitted -> Returns Tool Call 2 (Simulating duplicate/re-run)
      if (body.tool_results && body.tool_results.length === 1) {
        const res = body.tool_results[0];
        if (res.tool_call_id === TOOL_CALL_1_ID) {
          console.log("[MockFetch] Received Result 1, Returning Tool Call 2");
          const event2 = {
            event: "node_finished",
            conversation_id: "c0e0f16f-9feb-4350-89c3-4d15b6a4cc16",
            data: {
              outputs: {
                tool_calls: [
                  {
                    id: TOOL_CALL_2_ID,
                    type: "function",
                    function: {
                      name: "exec",
                      arguments: '{"command": "dir \\"C:\\\\Users\\\\Lw\\\\.local\\""}',
                    },
                  },
                ],
              },
            },
          };
          return new Response(`data: ${JSON.stringify(event2)}\n\n`, { status: 200 });
        }
      }

      // Step 3: Second Tool Result Submitted -> Returns 400 Error
      if (body.tool_results && body.tool_results.length === 2) {
        console.log("[MockFetch] Received Result 1 & 2, Simulating 400 Error");
        return new Response(
          JSON.stringify({
            error: {
              message:
                "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)",
              code: "invalid_request_error",
            },
          }),
          { status: 400 },
        );
      }
    }
    return new Response("OK", { status: 200 });
  };

  // --- Step 1: Initial Request ---
  const messages1 = [{ role: "user", content: USER_QUERY }];
  await runRequest(messages1, "Step 1 (Initial)");

  // --- Step 2: Submit Result 1 ---
  const messages2 = [
    { role: "user", content: USER_QUERY },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: TOOL_CALL_1_ID,
          type: "function",
          function: {
            name: "exec",
            arguments: '{"command": "dir \\"C:\\\\Users\\\\Lw\\\\.local\\""}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: TOOL_CALL_1_ID,
      name: "exec",
      content: "Directory listing 1...",
    },
  ];
  await runRequest(messages2, "Step 2 (Submit Result 1)");

  // --- Step 3: Submit Result 2 (Trigger Error) ---
  const messages3 = [
    ...messages2,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: TOOL_CALL_2_ID,
          type: "function",
          function: {
            name: "exec",
            arguments: '{"command": "dir \\"C:\\\\Users\\\\Lw\\\\.local\\""}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: TOOL_CALL_2_ID,
      name: "exec",
      content: "Directory listing 2...",
    },
  ];
  await runRequest(messages3, "Step 3 (Submit Result 2)");
}

runTest().catch(console.error);
