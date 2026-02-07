import type { IncomingMessage } from "node:http";
import type { ToolExecutorDeps } from "../types.js";

let toolExecutorDepsPromise: Promise<ToolExecutorDeps> | null = null;

export const loadToolExecutorDeps = async (): Promise<ToolExecutorDeps> => {
  if (toolExecutorDepsPromise) {
    return toolExecutorDepsPromise;
  }
  toolExecutorDepsPromise = (async () => {
    try {
      const [
        toolsMod,
        configMod,
        httpUtils,
        policyMod,
        toolPolicyMod,
        pluginToolsMod,
        sessionsMod,
        msgChannelMod,
      ] = await Promise.all([
        import("../../../../src/agents/openclaw-tools.js"),
        import("../../../../src/config/config.js"),
        import("../../../../src/gateway/http-utils.js"),
        import("../../../../src/agents/pi-tools.policy.js"),
        import("../../../../src/agents/tool-policy.js"),
        import("../../../../src/plugins/tools.js"),
        import("../../../../src/sessions/session-key-utils.js"),
        import("../../../../src/utils/message-channel.js"),
      ]);
      return {
        createOpenClawTools: toolsMod.createOpenClawTools,
        loadConfig: configMod.loadConfig,
        resolveAgentIdForRequest: httpUtils.resolveAgentIdForRequest,
        resolveSessionKey: httpUtils.resolveSessionKey,
        getHeader: httpUtils.getHeader,
        normalizeMessageChannel: msgChannelMod.normalizeMessageChannel,
        resolveEffectiveToolPolicy: policyMod.resolveEffectiveToolPolicy,
        resolveToolProfilePolicy: toolPolicyMod.resolveToolProfilePolicy,
        resolveGroupToolPolicy: policyMod.resolveGroupToolPolicy,
        resolveSubagentToolPolicy: policyMod.resolveSubagentToolPolicy,
        isSubagentSessionKey: sessionsMod.isSubagentSessionKey,
        collectExplicitAllowlist: toolPolicyMod.collectExplicitAllowlist,
        filterToolsByPolicy: policyMod.filterToolsByPolicy,
        expandPolicyWithPluginGroups: toolPolicyMod.expandPolicyWithPluginGroups,
        stripPluginOnlyAllowlist: toolPolicyMod.stripPluginOnlyAllowlist,
        buildPluginToolGroups: toolPolicyMod.buildPluginToolGroups,
        normalizeToolName: toolPolicyMod.normalizeToolName,
        getPluginToolMeta: pluginToolsMod.getPluginToolMeta,
      };
    } catch {
      const [
        toolsMod,
        configMod,
        httpUtils,
        policyMod,
        toolPolicyMod,
        pluginToolsMod,
        sessionsMod,
        msgChannelMod,
      ] = await Promise.all([
        import("../../../../agents/openclaw-tools.js"),
        import("../../../../config/config.js"),
        import("../../../../gateway/http-utils.js"),
        import("../../../../agents/pi-tools.policy.js"),
        import("../../../../agents/tool-policy.js"),
        import("../../../../plugins/tools.js"),
        import("../../../../sessions/session-key-utils.js"),
        import("../../../../utils/message-channel.js"),
      ]);
      return {
        createOpenClawTools: toolsMod.createOpenClawTools,
        loadConfig: configMod.loadConfig,
        resolveAgentIdForRequest: httpUtils.resolveAgentIdForRequest,
        resolveSessionKey: httpUtils.resolveSessionKey,
        getHeader: httpUtils.getHeader,
        normalizeMessageChannel: msgChannelMod.normalizeMessageChannel,
        resolveEffectiveToolPolicy: policyMod.resolveEffectiveToolPolicy,
        resolveToolProfilePolicy: toolPolicyMod.resolveToolProfilePolicy,
        resolveGroupToolPolicy: policyMod.resolveGroupToolPolicy,
        resolveSubagentToolPolicy: policyMod.resolveSubagentToolPolicy,
        isSubagentSessionKey: sessionsMod.isSubagentSessionKey,
        collectExplicitAllowlist: toolPolicyMod.collectExplicitAllowlist,
        filterToolsByPolicy: policyMod.filterToolsByPolicy,
        expandPolicyWithPluginGroups: toolPolicyMod.expandPolicyWithPluginGroups,
        stripPluginOnlyAllowlist: toolPolicyMod.stripPluginOnlyAllowlist,
        buildPluginToolGroups: toolPolicyMod.buildPluginToolGroups,
        normalizeToolName: toolPolicyMod.normalizeToolName,
        getPluginToolMeta: pluginToolsMod.getPluginToolMeta,
      };
    }
  })();
  return toolExecutorDepsPromise;
};

const mergeAlsoAllow = (
  policy: { allow?: string[]; deny?: string[] } | undefined,
  alsoAllow?: string[],
) => {
  if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
    return policy;
  }
  return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
};

export const resolveToolListForRequest = async (params: {
  req: IncomingMessage;
  model: string | undefined;
  user: string | undefined;
}) => {
  const deps = await loadToolExecutorDeps();
  const cfg = deps.loadConfig();
  const agentId = deps.resolveAgentIdForRequest({ req: params.req, model: params.model });
  const sessionKey = deps.resolveSessionKey({
    req: params.req,
    agentId,
    user: params.user,
    prefix: "dify",
  });
  const messageChannel = deps.normalizeMessageChannel(
    deps.getHeader(params.req, "x-openclaw-message-channel") ?? "",
  );
  const accountId = deps.getHeader(params.req, "x-openclaw-account-id")?.trim() || undefined;

  const {
    agentId: resolvedAgentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = deps.resolveEffectiveToolPolicy({ config: cfg, sessionKey });
  const profilePolicy = deps.resolveToolProfilePolicy(profile);
  const providerProfilePolicy = deps.resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllow(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllow(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupPolicy = deps.resolveGroupToolPolicy({
    config: cfg,
    sessionKey,
    messageProvider: messageChannel ?? undefined,
    accountId: accountId ?? null,
  });
  const subagentPolicy = deps.isSubagentSessionKey(sessionKey)
    ? deps.resolveSubagentToolPolicy(cfg)
    : undefined;

  const allTools = deps.createOpenClawTools({
    agentSessionKey: sessionKey,
    agentChannel: messageChannel ?? undefined,
    agentAccountId: accountId,
    config: cfg,
    pluginToolAllowlist: deps.collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
    ]),
  });

  const coreToolNames = new Set(
    allTools
      .filter((tool) => !deps.getPluginToolMeta(tool))
      .map((tool) => deps.normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = deps.buildPluginToolGroups({
    tools: allTools,
    toolMeta: (tool) => deps.getPluginToolMeta(tool),
  });
  const resolvePolicy = (policy: { allow?: string[]; deny?: string[] } | undefined) =>
    deps.expandPolicyWithPluginGroups(
      deps.stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames).policy,
      pluginGroups,
    );
  const profilePolicyExpanded = resolvePolicy(profilePolicyWithAlsoAllow);
  const providerProfileExpanded = resolvePolicy(providerProfilePolicyWithAlsoAllow);
  const globalPolicyExpanded = resolvePolicy(globalPolicy);
  const globalProviderExpanded = resolvePolicy(globalProviderPolicy);
  const agentPolicyExpanded = resolvePolicy(agentPolicy);
  const agentProviderExpanded = resolvePolicy(agentProviderPolicy);
  const groupPolicyExpanded = resolvePolicy(groupPolicy);
  const subagentPolicyExpanded = deps.expandPolicyWithPluginGroups(subagentPolicy, pluginGroups);

  const toolsFiltered = profilePolicyExpanded
    ? deps.filterToolsByPolicy(allTools, profilePolicyExpanded)
    : allTools;
  const providerProfileFiltered = providerProfileExpanded
    ? deps.filterToolsByPolicy(toolsFiltered, providerProfileExpanded)
    : toolsFiltered;
  const globalFiltered = globalPolicyExpanded
    ? deps.filterToolsByPolicy(providerProfileFiltered, globalPolicyExpanded)
    : providerProfileFiltered;
  const globalProviderFiltered = globalProviderExpanded
    ? deps.filterToolsByPolicy(globalFiltered, globalProviderExpanded)
    : globalFiltered;
  const agentFiltered = agentPolicyExpanded
    ? deps.filterToolsByPolicy(globalProviderFiltered, agentPolicyExpanded)
    : globalProviderFiltered;
  const agentProviderFiltered = agentProviderExpanded
    ? deps.filterToolsByPolicy(agentFiltered, agentProviderExpanded)
    : agentFiltered;
  const groupFiltered = groupPolicyExpanded
    ? deps.filterToolsByPolicy(agentProviderFiltered, groupPolicyExpanded)
    : agentProviderFiltered;
  const subagentFiltered = subagentPolicyExpanded
    ? deps.filterToolsByPolicy(groupFiltered, subagentPolicyExpanded)
    : groupFiltered;

  return {
    tools: subagentFiltered as Array<{
      name: string;
      parameters?: unknown;
      execute?: (id: string, args: Record<string, unknown>) => Promise<unknown>;
    }>,
    sessionKey,
    agentId: resolvedAgentId,
  };
};
