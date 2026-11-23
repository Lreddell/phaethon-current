import { app } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const query = promisify(execFile);
const outlookKey = String.raw`Software\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE`;

async function classicOutlook(): Promise<string | undefined> {
  const reg = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  for (const [hive, view] of [["HKCU", "64"], ["HKLM", "64"], ["HKLM", "32"]]) {
    try {
      const { stdout } = await query(reg, ["query", `${hive}\\${outlookKey}`, "/ve", `/reg:${view}`], { windowsHide: true, timeout: 2_000, maxBuffer: 16_384 });
      const file = stdout.match(/\sREG_SZ\s+([^\r\n]+)/i)?.[1]?.trim().replace(/^"(.*)"$/, "$1");
      // A local executable registered under the fixed Outlook key is the only input to the shell API.
      if (!file || !/^[A-Z]:\\/i.test(file) || path.basename(file).toLowerCase() !== "outlook.exe") continue;
      const real = await fs.realpath(file);
      if (/^[A-Z]:\\/i.test(real) && path.basename(real).toLowerCase() === "outlook.exe" && (await fs.stat(real)).isFile()) return real;
    } catch {
      // No App Paths registration in this view, or the executable has moved.
    }
  }
}

export async function knownAppIcon(id: "outlook-win"): Promise<string | null> {
  if (process.platform !== "win32" || id !== "outlook-win") return null;
  const file = await classicOutlook();
  if (!file) return null;
  const icon = await app.getFileIcon(file, { size: "normal" }).catch(() => null);
  return icon && !icon.isEmpty() ? icon.toDataURL() : null;
}
