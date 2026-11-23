import { afterAll, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { writeJsonAtomic } from "../core/fsx.ts";
import { nextRun, parseCron, previousRun } from "./cron.ts";
import { jobBaseline, jobsFile, recoverInterruptedJobs, registerJob, tick, viewJobs } from "./scheduler.ts";

const env = tempHome("phaethon-scheduler-");
ensureVault();
afterAll(env.cleanup);

it("does not repeat a run claimed before a crash", async () => {
  const now = new Date(2026, 10, 23, 8).getTime();
  const due = new Date(2026, 10, 23, 7).getTime();
  const id = "interrupted";
  writeJsonAtomic(jobsFile(), { version: 1, jobs: { [id]: { since: due - 1000, claimedSlot: due } } });
  registerJob({ id, title: "Example", description: "", defaultOn: true, optional: true, model: false, cron: () => "0 7 * * *",
    ready: () => ({ ok: true }), run: () => { throw new Error("An interrupted slot must not be repeated"); } });
  recoverInterruptedJobs();
  expect(await tick(now)).toEqual([]);
  expect(jobBaseline(id)).toBe(due);
  expect(viewJobs().find((job) => job.id === id)).toMatchObject({ lastRun: due, lastOk: false, lastError: "Phaethon stopped while this run was in progress." });
});

it("skips nonexistent and repeated local times across daylight saving changes", () => {
  const originalZone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const daily = parseCron("30 1 * * *");
    const beforeFallBack = Date.parse("2026-11-01T01:40:00-04:00");
    const afterFallBack = Date.parse("2026-11-01T01:10:00-05:00");
    const nextDay = Date.parse("2026-11-02T01:30:00-05:00");
    expect(nextRun(daily, beforeFallBack)).toBe(nextDay);
    expect(nextRun(daily, afterFallBack)).toBe(nextDay);
    expect(previousRun(daily, afterFallBack, 3_600_000)).toBe(Date.parse("2026-11-01T01:30:00-04:00"));
    expect(nextRun(parseCron("30 2 * * *"), Date.parse("2026-03-08T00:00:00-05:00"))).toBe(Date.parse("2026-03-09T02:30:00-04:00"));
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});
