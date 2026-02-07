import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../logs");

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (error) {
  console.error("[DifyLogger] Failed to create log directory:", error);
}

export class DifyLogger {
  private logFile: string;

  constructor(sessionId: string) {
    // Sanitize session ID for filename
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = path.join(LOG_DIR, `dify_debug_${timestamp}_${safeSessionId}.log`);
  }

  log(section: string, data: any) {
    try {
      const entry = `\n[${new Date().toISOString()}] === ${section} ===\n${
        typeof data === "string" ? data : JSON.stringify(data, null, 2)
      }\n`;
      fs.appendFileSync(this.logFile, entry, "utf8");
    } catch (error) {
      console.error("[DifyLogger] Failed to write log:", error);
    }
  }
}
