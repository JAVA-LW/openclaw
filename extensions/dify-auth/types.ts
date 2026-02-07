import type { IncomingMessage } from "node:http";

export type ToolExecutorDeps = {
  createOpenClawTools: (options?: {
    agentSessionKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    config?: Record<string, unknown>;
    pluginToolAllowlist?: string[];
  }) => Array<{
    name: string;
    parameters?: unknown;
    execute?: (id: string, args: Record<string, unknown>) => Promise<unknown>;
  }>;
  loadConfig: () => Record<string, unknown>;
  resolveAgentIdForRequest: (params: { req: IncomingMessage; model: string | undefined }) => string;
  resolveSessionKey: (params: {
    req: IncomingMessage;
    agentId: string;
    user?: string | undefined;
    prefix: string;
  }) => string;
  getHeader: (req: IncomingMessage, name: string) => string | undefined;
  normalizeMessageChannel: (value?: string | null) => string | undefined;
  resolveEffectiveToolPolicy: (params: {
    config?: Record<string, unknown>;
    sessionKey?: string;
    modelProvider?: string;
    modelId?: string;
  }) => {
    agentId?: string;
    globalPolicy?: { allow?: string[]; deny?: string[] };
    globalProviderPolicy?: { allow?: string[]; deny?: string[] };
    agentPolicy?: { allow?: string[]; deny?: string[] };
    agentProviderPolicy?: { allow?: string[]; deny?: string[] };
    profile?: string;
    providerProfile?: string;
    profileAlsoAllow?: string[];
    providerProfileAlsoAllow?: string[];
  };
  resolveToolProfilePolicy: (profile?: string) => { allow?: string[]; deny?: string[] } | undefined;
  resolveGroupToolPolicy: (params: {
    config?: Record<string, unknown>;
    sessionKey?: string;
    messageProvider?: string;
    accountId?: string | null;
  }) => { allow?: string[]; deny?: string[] } | undefined;
  resolveSubagentToolPolicy: (
    config?: Record<string, unknown>,
  ) => { allow?: string[]; deny?: string[] } | undefined;
  isSubagentSessionKey: (sessionKey: string | undefined | null) => boolean;
  collectExplicitAllowlist: (
    policies: Array<{ allow?: string[]; deny?: string[] } | undefined>,
  ) => string[];
  filterToolsByPolicy: (
    tools: Array<{ name: string }>,
    policy?: { allow?: string[]; deny?: string[] },
  ) => Array<{ name: string }>;
  expandPolicyWithPluginGroups: (
    policy: { allow?: string[]; deny?: string[] } | undefined,
    groups: { all: string[]; byPlugin: Map<string, string[]> },
  ) => { allow?: string[]; deny?: string[] } | undefined;
  stripPluginOnlyAllowlist: (
    policy: { allow?: string[]; deny?: string[] } | undefined,
    groups: { all: string[]; byPlugin: Map<string, string[]> },
    coreTools: Set<string>,
  ) => {
    policy?: { allow?: string[]; deny?: string[] };
    unknownAllowlist: string[];
    strippedAllowlist: boolean;
  };
  buildPluginToolGroups: (params: {
    tools: Array<{ name: string }>;
    toolMeta: (tool: { name: string }) => { pluginId: string } | undefined;
  }) => { all: string[]; byPlugin: Map<string, string[]> };
  normalizeToolName: (value?: string | null) => string;
  getPluginToolMeta: (tool: { name: string }) => { pluginId: string } | undefined;
};

export type DifyCompositeKey = {
  apiKey: string;
  baseUrl: string;
  appType: "chat" | "agent";
};

export type ToolCallResult = {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
};

export type ToolCall = {
  callId: string;
  toolName: string;
  argsString: string;
};
