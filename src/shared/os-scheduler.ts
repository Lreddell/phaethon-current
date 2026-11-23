export const SCHEDULER_FLAG = "--scheduler-tick";
export const SCHEDULER_CONSENT = "os-scheduler-enabled";
export const SCHEDULER_INTERVAL = 15;

export type SchedulerAction = "status" | "enable" | "disable";
export type SchedulerStatus = {
  provider: "task-scheduler" | null;
  state: "unsupported" | "off" | "active" | "repair" | "unavailable";
  enabled: boolean;
  reason?: string;
};
