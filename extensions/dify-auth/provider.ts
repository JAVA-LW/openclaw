import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PROVIDER_ID, PROVIDER_LABEL, PROXY_PATH, DEFAULT_BASE_URL } from "./constants.js";
import { verifyDifyKey } from "./dify/client.js";
import { handleProxyRequest } from "./proxy/index.js";
import { createCompositeKey } from "./utils/auth.js";

export const difyAuthPlugin = {
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
                      api: "openai-responses",
                      models: [
                        {
                          id: modelId,
                          name: siteInfo.title || defaultName,
                          contextWindow: 32000,
                          maxTokens: 4096,
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
