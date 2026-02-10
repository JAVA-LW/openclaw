import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../logs");

// // Ensure log directory exists
// try {
//   if (!fs.existsSync(LOG_DIR)) {
//     fs.mkdirSync(LOG_DIR, { recursive: true });
//   }
// } catch (error) {
//   console.error("[DifyLogger] Failed to create log directory:", error);
// }

export class DifyLogger {
  private logFile: string;

  constructor(sessionId: string) {
    // Sanitize session ID for filename
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = path.join(LOG_DIR, `dify_debug_${timestamp}_${safeSessionId}.log`);
  }

  log(section: string, data: any) {
    return; // Logging disabled
    /*
    try {
      // Use a regular function to access 'this' (the parent object)
      const replacer = function (this: any, key: string, value: any) {
        // Truncate long descriptions
        if (key === "description" && typeof value === "string" && value.length > 50) {
          return value.substring(0, 50) + "... (truncated)";
        }

        // Truncate long content/message/query fields (e.g. system prompts, user messages)
        // BUT preserve assistant messages and tool outputs for debugging
        if (
          (key === "content" || key === "message" || key === "query") &&
          typeof value === "string" &&
          value.length > 200
        ) {
          // Check role in the parent object (this)
          const role = this?.role;
          // If it's an assistant response or tool result, keep it fully visible
          if (role === "assistant" || role === "tool") {
            return value;
          }
          // Otherwise (system, user, or unknown), truncate it
          return value.substring(0, 200) + "... (truncated)";
        }

        // Compress tools array (definitions) if it's too long
        if (key === "tools" && Array.isArray(value) && value.length > 3) {
          return `[Array(${value.length}) - Truncated for brevity. Tool names: ${value
            .map((t: any) => t.function?.name || t.name)
            .slice(0, 5)
            .join(", ")}...]`;
        }
        return value;
      };

      const entry = `\n[${new Date().toISOString()}] === ${section} ===\n${
        typeof data === "string" ? data : JSON.stringify(data, replacer, 2)
      }\n`;
      fs.appendFileSync(this.logFile, entry, "utf8");
    } catch (error) {
      console.error("[DifyLogger] Failed to write log:", error);
    }
    */
  }
}
