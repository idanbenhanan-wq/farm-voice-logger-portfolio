import { getQueue, removeFromQueue, incrementRetry } from "./offlineQueue";
import { customFetch } from "@workspace/api-client-react";
import { trackEvent, trackOperationalEvent } from "./analytics";

const MAX_RETRIES = 3;
let syncing = false;
let engineStarted = false;

function dispatchSyncEvent(type: "sync-success" | "sync-failed", detail?: { message: string }) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

export async function flushQueue(): Promise<void> {
  if (syncing || !navigator.onLine) return;
  const queue = getQueue();
  if (queue.length === 0) return;

  syncing = true;
  const initialQueueSize = queue.length;
  let hasFailures = false;
  try {
    for (const item of queue) {
      if (item.retries >= MAX_RETRIES) {
        removeFromQueue(item.id);
        dispatchSyncEvent("sync-failed", {
          message: `רשומה נכשלה לאחר ${MAX_RETRIES} ניסיונות וירדה מהתור`,
        });
        continue;
      }
      try {
        await customFetch("/api/records", {
          method: "POST",
          body: JSON.stringify({ ...item.data, syncStatus: "synced" }),
          headers: { "Content-Type": "application/json" },
        });
        removeFromQueue(item.id);
      } catch {
        incrementRetry(item.id);
        hasFailures = true;
      }
    }
    if (!hasFailures && getQueue().length === 0) {
      trackEvent("offline_sync_succeeded", { record_count: initialQueueSize });
      dispatchSyncEvent("sync-success");
      trackOperationalEvent({
        eventType: "offline_sync",
        stage: "sync",
        status: "success",
        fallbackUsed: true,
        metadata: { queueSize: initialQueueSize },
      });
    } else if (hasFailures) {
      trackEvent("offline_sync_failed", {
        attempted_count: initialQueueSize,
        remaining_count: getQueue().length,
      });
      dispatchSyncEvent("sync-failed", { message: "חלק מהרשומות לא סונכרנו — יתבצע ניסיון נוסף בעת חיבור" });
      trackOperationalEvent({
        eventType: "offline_sync",
        stage: "sync",
        status: "error",
        fallbackUsed: true,
        errorCode: "SYNC_RETRY_REQUIRED",
        metadata: { queueSize: getQueue().length },
      });
    }
  } finally {
    syncing = false;
  }
}

export function startSyncEngine() {
  if (engineStarted) return;
  engineStarted = true;
  window.addEventListener("online", () => {
    flushQueue();
  });
  if (navigator.onLine) {
    flushQueue();
  }
}
