import { performance } from "node:perf_hooks";

export function stampQueuedJob(job, nowMs = Date.now()) {
  const queuedAt = new Date(nowMs).toISOString();
  job.queuedAt = job.queuedAt || job.enqueuedAt || queuedAt;
  job.enqueuedAt = job.enqueuedAt || job.queuedAt;
  const existingMs = Number(job.queuedAtMs || Date.parse(job.queuedAt || job.enqueuedAt || ""));
  job.queuedAtMs = Number.isFinite(existingMs) ? existingMs : nowMs;
  return job;
}

export function selectNextJobIndex(queue) {
  let selectedIndex = -1;
  let selectedPriority = Infinity;
  for (let index = 0; index < queue.length; index += 1) {
    const priority = jobPriority(queue[index]);
    if (priority < selectedPriority) {
      selectedIndex = index;
      selectedPriority = priority;
    }
  }
  return selectedIndex;
}

export function jobPriority(job) {
  const type = jobType(job);
  if (type === "incoming") return 0;
  if (type === "request") return 1;
  if (type === "webhook") return 2;
  return 3;
}

export function jobType(job) {
  if (job?.type === "incoming" || job?.type === "imessage") return "incoming";
  if (job?.type === "request") return "request";
  if (job?.type === "webhook") return "webhook";
  return String(job?.type || "unknown");
}

export function summarizeQueuedJobs(queue) {
  const summary = {};
  for (const job of queue) {
    const type = jobType(job);
    summary[type] = (summary[type] || 0) + 1;
  }
  return summary;
}

export function formatLatencyLogLine(event, fields = {}) {
  const parts = [`latency ${formatLogValue(event)}`];
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveLogField(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${formatLogKey(key)}=${formatLogValue(value)}`);
  }
  return parts.join(" ");
}

export function startJobMetrics(job, queueLength) {
  const startedAtMs = Date.now();
  const queuedAtMs = Number(job.queuedAtMs || Date.parse(job.queuedAt || job.enqueuedAt || job.receivedAt || ""));
  const safeQueuedAtMs = Number.isFinite(queuedAtMs) ? queuedAtMs : startedAtMs;
  return {
    type: jobType(job),
    requestId: job.requestId,
    ids: job.ids,
    replyMode: job.replyMode,
    queuedAt: job.queuedAt || job.enqueuedAt || job.receivedAt || new Date(safeQueuedAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    queueLength,
    queueWaitMs: Math.max(0, startedAtMs - safeQueuedAtMs),
    totalStartedAt: performance.now(),
    orchestratorMs: 0,
    adapterSendMs: 0,
  };
}

export function startLatencyFields(metrics) {
  return {
    type: metrics.type,
    requestId: metrics.requestId,
    ids: metrics.ids,
    replyMode: metrics.replyMode,
    queuedAt: metrics.queuedAt,
    startedAt: metrics.startedAt,
    queueWaitMs: metrics.queueWaitMs,
    queueLength: metrics.queueLength,
  };
}

export function finishLatencyFields(metrics, status) {
  return {
    ...startLatencyFields(metrics),
    status,
    orchestratorMs: metrics.orchestratorMs,
    adapterSendMs: metrics.adapterSendMs,
    totalMs: elapsedMs(metrics.totalStartedAt),
  };
}

export async function timedStage(metrics, field, fn) {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    metrics[field] += elapsedMs(startedAt);
  }
}

export function elapsedMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function formatLogKey(key) {
  return String(key || "field").replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function isSensitiveLogField(key) {
  return ["body", "message", "prompt", "text"].includes(String(key || "").toLowerCase());
}

function formatLogValue(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  return raw.replace(/[\s=]+/g, "_").slice(0, 240);
}
