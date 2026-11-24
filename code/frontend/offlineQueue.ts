const QUEUE_KEY = "farm_offline_queue";

export interface QueuedRecord {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  retries: number;
}

export function getQueue(): QueuedRecord[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedRecord[]) : [];
  } catch {
    return [];
  }
}

export function enqueue(data: Record<string, unknown>): QueuedRecord {
  const item: QueuedRecord = {
    id: `offline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    data,
    createdAt: new Date().toISOString(),
    retries: 0,
  };
  const queue = getQueue();
  queue.push(item);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  window.dispatchEvent(new CustomEvent("offline-queue-changed"));
  return item;
}

export function removeFromQueue(id: string) {
  const queue = getQueue().filter((item) => item.id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  window.dispatchEvent(new CustomEvent("offline-queue-changed"));
}

export function incrementRetry(id: string) {
  const queue = getQueue().map((item) =>
    item.id === id ? { ...item, retries: item.retries + 1 } : item
  );
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function getQueueCount(): number {
  return getQueue().length;
}
