import { commands, Refusal } from "../rpc/registry.ts";
import type { SchedulerStatus } from "../../shared/os-scheduler.ts";
import { host } from "../host.ts";
import { authorizeIntegration } from "../integrations/policy.ts";
import { onStart, onStop } from "../lifecycle.ts";
import { describeCron, toCron } from "./cron.ts";
import { digestSettings, registerBuiltinJobs, runSchedule, setDigestSettings, type DigestSettings } from "./builtin.ts";
import { addSchedule, describeSchedule, readSchedules, removeSchedule, updateSchedule, type ScheduleInput } from "./schedules.ts";
import { resetBaseline, runJob, setJobEnabled, startScheduler, stopScheduler, viewJobs, wakeScheduler } from "./scheduler.ts";

/** Settings › Automations. */

registerBuiltinJobs();

const view = (s: ReturnType<typeof readSchedules>[number]) => ({ ...s, when: describeSchedule(s) });

commands({
  background_launcher_status: (): SchedulerStatus | Promise<SchedulerStatus> => host().available
    ? host().call<SchedulerStatus>({ op: "backgroundLauncher", action: "status" })
    : { provider: null, state: "unsupported", enabled: false },
  background_launcher_set: ({ enabled }: { enabled?: unknown }) => {
    authorizeIntegration("modify", "user", host().available);
    if (typeof enabled !== "boolean") throw new Refusal("Choose whether to allow background launch.");
    return host().call<SchedulerStatus>({ op: "backgroundLauncher", action: enabled ? "enable" : "disable" });
  },
  jobs_list: () => viewJobs(),
  job_set_enabled: ({ id, enabled }: { id: string; enabled: boolean }) => {
    setJobEnabled(id, enabled === true);
    return viewJobs();
  },
  job_run: async ({ id }: { id: string }) => ({ result: await runJob(id) }),

  schedules_list: () => readSchedules().map(view),

  schedule_save: ({ id, ...input }: ScheduleInput & { id?: string }) => {
    if (id) {
      const before = readSchedules().find((s) => s.id === id);
      const s = updateSchedule(id, input);
      if (s.enabled && (!before?.enabled || before.cron !== s.cron)) resetBaseline(`schedule:${s.id}`);
      return view(s);
    }
    const s = addSchedule(input, "user");
    resetBaseline(`schedule:${s.id}`);
    return view(s);
  },

  schedule_set_enabled: ({ id, enabled }: { id: string; enabled: boolean }) => {
    const s = updateSchedule(id, { enabled: enabled === true });
    if (s.enabled) resetBaseline(`schedule:${s.id}`);
    return view(s);
  },

  schedule_delete: ({ id }: { id: string }) => removeSchedule(id),

  schedule_run_now: async ({ id }: { id: string }) => {
    const s = readSchedules().find((x) => x.id === id);
    if (!s) throw new Refusal("That schedule no longer exists.");
    return runSchedule(s);
  },

  /** "daily 7:30 am" → its cron and how it reads, for the editor's live hint. */
  schedule_describe: ({ when }: { when: string }) => {
    try {
      const cron = toCron(String(when ?? ""));
      return { ok: true, cron, text: describeCron(cron) };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  },

  digest_get: () => digestSettings(),
  digest_set: (d: DigestSettings) => setDigestSettings({ spaces: Array.isArray(d?.spaces) ? d.spaces : [], time: String(d?.time ?? "07:00") }),
});

onStart("start background jobs", () => {
  startScheduler();
  host().on((event) => { if (event.kind === "schedulerTick") wakeScheduler(); });
});
onStop("stop background jobs", () => stopScheduler());
