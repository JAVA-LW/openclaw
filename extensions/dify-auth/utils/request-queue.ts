/**
 * Per-session serial request queue.
 * Ensures that for any given sessionKey, only one request to Dify
 * is in-flight at a time. Subsequent requests wait in line.
 */

type QueueEntry = {
  execute: () => Promise<void>;
};

const queues = new Map<string, { running: boolean; pending: QueueEntry[] }>();

function getOrCreate(sessionKey: string) {
  let q = queues.get(sessionKey);
  if (!q) {
    q = { running: false, pending: [] };
    queues.set(sessionKey, q);
  }
  return q;
}

async function drain(sessionKey: string) {
  const q = getOrCreate(sessionKey);
  if (q.running) return;
  q.running = true;
  try {
    while (q.pending.length > 0) {
      const entry = q.pending.shift()!;
      try {
        await entry.execute();
      } catch {
        // Individual task errors are handled by the task itself
      }
    }
  } finally {
    q.running = false;
    if (q.pending.length === 0) {
      queues.delete(sessionKey);
    }
  }
}

export function enqueue(sessionKey: string, execute: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const q = getOrCreate(sessionKey);
    q.pending.push({
      execute: async () => {
        try {
          await execute();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
    });
    drain(sessionKey);
  });
}

export function isBusy(sessionKey: string): boolean {
  const q = queues.get(sessionKey);
  return !!q?.running;
}
