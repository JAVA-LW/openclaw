import type { DifyCompositeKey } from "../types.js";

export const createCompositeKey = (apiKey: string, baseUrl: string, appType: string) =>
  `${apiKey};${baseUrl};${appType}`;

export const parseCompositeKey = (compositeKey: string): DifyCompositeKey => {
  const parts = compositeKey.split(";");
  return {
    apiKey: parts[0] || "",
    baseUrl: parts[1] || "",
    appType: (parts[2] || "chat") as "chat",
  };
};
