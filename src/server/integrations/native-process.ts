import { tmpdir } from "node:os";
import { spawnInGroup, stopGroup } from "../cli/process.ts";

export function windowsPowerShell(): string {
  return String.raw`${process.env.SystemRoot ?? "C:\\Windows"}\System32\WindowsPowerShell\v1.0\powershell.exe`;
}

const nativeEnvironmentNames = new Set(["APPDATA", "COMMONPROGRAMFILES", "COMPUTERNAME", "HOME", "LANG", "LOCALAPPDATA", "LOGNAME", "OS", "PATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "USERPROFILE", "WINDIR"]);

export function nativeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => nativeEnvironmentNames.has(name.toUpperCase())));
}

/** Run a fixed adapter command with bounded input and output. Probes can opt in to stderr. */
export async function runNative(executable: string, args: string[], input: string, signal: AbortSignal, options: { cwd?: string; env?: NodeJS.ProcessEnv; includeStderr?: boolean } = {}): Promise<string> {
  signal.throwIfAborted();
  if (Buffer.byteLength(input) > 512 * 1024) throw new Error("The native adapter request is too large.");
  const child = await spawnInGroup(executable, args, { cwd: options.cwd ?? tmpdir(), env: options.env ?? process.env, input });
  let stop!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("The native adapter timed out or was cancelled."));
  });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const output = async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const data of child.stdout) {
      const chunk = Buffer.from(data);
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("The native adapter returned too much data.");
      chunks.push(chunk);
    }
    if ((await child.exited).code !== 0) throw new Error("The native adapter stopped unexpectedly.");
    const stdout = Buffer.concat(chunks).toString("utf8");
    return options.includeStderr ? stdout + await child.stderrText() : stdout;
  };
  try {
    return await Promise.race([output(), interrupted]);
  } finally {
    signal.removeEventListener("abort", stop);
    await stopGroup(child);
  }
}
