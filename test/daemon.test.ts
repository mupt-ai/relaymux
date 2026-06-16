import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLatencyLogLine,
  jobPriority,
  selectNextJobIndex,
  stampQueuedJob,
  summarizeQueuedJobs,
} from "../src/daemon-jobs.js";

test("selectNextJobIndex prioritizes incoming work without changing FIFO within a priority", () => {
  const queue = [
    { type: "webhook", requestId: "wh1" },
    { type: "request", requestId: "req1" },
    { type: "incoming", requestId: "in1" },
    { type: "incoming", requestId: "in2" },
  ];

  assert.equal(selectNextJobIndex(queue), 2);
  queue.splice(2, 1);
  assert.equal(selectNextJobIndex(queue), 2);
  queue.splice(2, 1);
  assert.equal(selectNextJobIndex(queue), 1);
});

test("jobPriority keeps incoming above terminal requests above completion webhooks", () => {
  assert.equal(jobPriority({ type: "incoming" }), 0);
  assert.equal(jobPriority({ type: "imessage" }), 0);
  assert.equal(jobPriority({ type: "request" }), 1);
  assert.equal(jobPriority({ type: "webhook" }), 2);
  assert.equal(jobPriority({ type: "other" }), 3);
});

test("stampQueuedJob records queue timestamps without clobbering an existing queuedAt", () => {
  const job: Record<string, unknown> = { type: "webhook", queuedAt: "2026-01-01T00:00:00.000Z" };

  stampQueuedJob(job, Date.UTC(2026, 0, 1, 0, 0, 5));

  assert.equal(job.queuedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(job.enqueuedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(job.queuedAtMs, Date.UTC(2026, 0, 1, 0, 0, 0));
});

test("stampQueuedJob preserves legacy enqueuedAt when queuedAt is absent", () => {
  const job: Record<string, unknown> = { type: "incoming", enqueuedAt: "2026-01-01T00:00:02.000Z" };

  stampQueuedJob(job, Date.UTC(2026, 0, 1, 0, 0, 5));

  assert.equal(job.queuedAt, "2026-01-01T00:00:02.000Z");
  assert.equal(job.queuedAtMs, Date.UTC(2026, 0, 1, 0, 0, 2));
});

test("summarizeQueuedJobs returns safe queue counts by type", () => {
  assert.deepEqual(summarizeQueuedJobs([
    { type: "webhook" },
    { type: "request" },
    { type: "imessage" },
    { type: "incoming" },
  ]), {
    webhook: 1,
    request: 1,
    incoming: 2,
  });
});

test("formatLatencyLogLine emits compact key-value fields", () => {
  assert.equal(
    formatLatencyLogLine("job done", {
      type: "incoming",
      ids: ["1", "2"],
      requestId: "imessage-abc",
      queueWaitMs: 12,
      message: "never log this text",
      empty: "",
    }),
    "latency job_done type=incoming ids=1,2 requestId=imessage-abc queueWaitMs=12",
  );
});
