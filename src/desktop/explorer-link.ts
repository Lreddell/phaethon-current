import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import { IDENTITY } from "../shared/channel.ts";
import { EXPLORER_FLAG, EXPLORER_SHORTCUT_DESCRIPTION, EXPLORER_SHORTCUT_SUFFIX, type ExplorerStatus } from "../shared/explorer.ts";

const query = promisify(execFile);
const script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::SendTo)";

async function shortcutPath(): Promise<string> {
  const bin = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await query(bin, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5000, maxBuffer: 64_000, windowsHide: true });
  const folder = stdout.trim();
  if (!path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) throw new Error("Windows did not return your Send to folder.");
  return path.join(folder, IDENTITY.productName + EXPLORER_SHORTCUT_SUFFIX);
}

export class ExplorerLink {
  private pending?: Promise<ExplorerStatus>;

  constructor(private readonly supported: boolean) {}

  async change(action: "status" | "enable" | "disable"): Promise<ExplorerStatus> {
    if (!this.supported || process.platform !== "win32") return { state: "unsupported" };
    if (this.pending) {
      if (action === "status") return this.pending;
      throw new Error("Wait for the current File Explorer change to finish.");
    }
    this.pending = this.update(action);
    try { return await this.pending; }
    finally { this.pending = undefined; }
  }

  private async update(action: "status" | "enable" | "disable"): Promise<ExplorerStatus> {
    try {
      const file = await shortcutPath();
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      const link = stat?.isFile() ? shell.readShortcutLink(file) : undefined;
      const owned = link?.args === EXPLORER_FLAG && link.description === EXPLORER_SHORTCUT_DESCRIPTION &&
        path.basename(link.target).toLowerCase() === path.basename(process.execPath).toLowerCase();
      if (stat && !owned) return { state: "unavailable", reason: "A different shortcut already uses Phaethon’s name in the Send to folder." };
      if (action === "disable") {
        if (owned) fs.unlinkSync(file);
        return { state: "off" };
      }
      if (action === "enable") {
        const written = shell.writeShortcutLink(file, owned ? "replace" : "create", {
          target: process.execPath, args: EXPLORER_FLAG, description: EXPLORER_SHORTCUT_DESCRIPTION,
          appUserModelId: IDENTITY.appIdentifier,
        });
        if (!written) return { state: "unavailable", reason: "Phaethon could not save the shortcut in your Send to folder." };
        return { state: "active" };
      }
      if (!owned) return { state: "off" };
      if (path.relative(process.execPath, link.target) === "") return { state: "active" };
      return { state: "repair", reason: "The shortcut points to a different Phaethon installation." };
    } catch {
      return { state: "unavailable", reason: "Phaethon could not access your Windows Send to folder." };
    }
  }
}
