import fs from "node:fs";
import path from "node:path";
import { IDENTITY } from "../shared/channel.ts";
import { SCHEDULER_CONSENT, type SchedulerAction, type SchedulerStatus } from "../shared/os-scheduler.ts";
import { windowsRegistration } from "./windows-scheduler.ts";

const consent = "enabled\n";

export class BackgroundLauncher {
  private pending?: Promise<SchedulerStatus>;

  constructor(private readonly profile: () => string, private readonly packaged: boolean) {}

  private consentFile() { return path.join(this.profile(), SCHEDULER_CONSENT); }

  optedIn(): boolean {
    if (process.platform !== "win32" || !this.packaged) return false;
    try {
      const file = this.consentFile();
      const stat = fs.lstatSync(file);
      return stat.isFile() && stat.size === consent.length && fs.readFileSync(file, "utf8") === consent;
    } catch { return false; }
  }

  async configure(action: SchedulerAction): Promise<SchedulerStatus> {
    if (process.platform !== "win32" || !this.packaged) return { provider: null, state: "unsupported", enabled: false };
    if (this.pending) {
      if (action === "status") return this.pending;
      throw new Error("Wait for the current change to finish.");
    }
    const operation = this.change(action);
    this.pending = operation;
    try { return await operation; }
    finally { this.pending = undefined; }
  }

  private async change(action: SchedulerAction): Promise<SchedulerStatus> {
    const provider = "task-scheduler" as const;
    const registration = (operation: SchedulerAction) => windowsRegistration(IDENTITY.appIdentifier, process.execPath, operation);
    try {
      if (action === "disable") {
        fs.rmSync(this.consentFile(), { force: true });
        await registration("disable");
        return { provider, state: "off", enabled: false };
      }
      const installed = await registration(action);
      if (action === "enable") {
        if (installed !== "active") throw new Error("Windows Task Scheduler did not register the Phaethon launch.");
        if (!this.optedIn()) {
          try {
            fs.mkdirSync(this.profile(), { recursive: true });
            fs.writeFileSync(this.consentFile(), consent, { encoding: "utf8", flag: "wx", mode: 0o600 });
          } catch {
            await registration("disable").catch(() => {});
            throw new Error("Phaethon could not save your background launch preference.");
          }
        }
      }
      const enabled = this.optedIn();
      if (enabled && installed === "active") return { provider, state: "active", enabled };
      if (!enabled && installed === "missing") return { provider, state: "off", enabled };
      return { provider, state: "repair", enabled, reason: "The Windows task and Phaethon preference no longer match." };
    } catch (error) {
      return { provider, state: "unavailable", enabled: this.optedIn(), reason: error instanceof Error ? error.message : "Windows Task Scheduler is unavailable." };
    }
  }
}
