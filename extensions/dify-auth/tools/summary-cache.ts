/**
 * Cache for deferred summary/compaction requests.
 *
 * When openclaw sends a compaction request during a tool-call loop,
 * we intercept it and cache the query here.  After the tool-call loop
 * completes (LLM returns text without tool_calls), we flush the cached
 * summary as a regular query to Dify so it gets stored in conversation
 * history and the memory window can benefit from it.
 */

const pendingSummaries = new Map<string, string>();

export function cacheSummary(conversationId: string, query: string) {
  if (conversationId) {
    pendingSummaries.set(conversationId, query);
  }
}

export function popSummary(conversationId: string): string | undefined {
  const query = pendingSummaries.get(conversationId);
  if (query) {
    pendingSummaries.delete(conversationId);
  }
  return query;
}

export function hasPendingSummary(conversationId: string): boolean {
  return pendingSummaries.has(conversationId);
}
