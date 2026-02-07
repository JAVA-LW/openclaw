import { CONVERSATION_TTL_MS, MAX_CONVERSATIONS } from "../constants.js";

const conversationMap = new Map<string, { id: string; lastSeen: number }>();

export const pruneConversationMap = (now: number) => {
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

export const getConversationId = (sessionKey: string, now: number) => {
  const entry = conversationMap.get(sessionKey);
  if (!entry) {
    return "";
  }
  entry.lastSeen = now;
  return entry.id;
};

export const setConversationId = (sessionKey: string, id: string, now: number) => {
  conversationMap.set(sessionKey, { id, lastSeen: now });
};

export const deleteConversation = (sessionKey: string) => {
  conversationMap.delete(sessionKey);
};
