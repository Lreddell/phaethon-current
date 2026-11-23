export type WorkflowPlatform = "powershell" | "posix-shell";
export type WorkflowRegistration = { id: string; provider: WorkflowPlatform; path: string; name: string; digest: string };
export type WorkflowSelection = { token: string; provider: WorkflowPlatform; path: string; name: string; digest: string };
export type WorkflowRunStatus = "running" | "completed" | "cancelled" | "timed-out" | "failed" | "interrupted";
export type WorkflowRun = { id: string; workflow: string; name: string; started: number; status: WorkflowRunStatus; finished?: number };
export type DesktopFlow = { id: string; name: string; environmentId: string; workflowId: string; lastRequest?: { id: string; at: number } };
export type WorkflowView = {
  platform: WorkflowPlatform | null;
  canRegister: boolean;
  reason?: string;
  workflows: WorkflowRegistration[];
  runs: WorkflowRun[];
};
