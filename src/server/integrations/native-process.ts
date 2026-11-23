import { tmpdir } from "node:os";
import { spawnInGroup, stopGroup } from "../cli/process.ts";

export function windowsPowerShell(): string {
  return String.raw`${process.env.SystemRoot ?? "C:\\Windows"}\System32\WindowsPowerShell\v1.0\powershell.exe`;
}

/** Run a fixed adapter command with bounded input and output. Stderr stays private. */
export async function runNative(executable: string, args: string[], input: string, signal: AbortSignal, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
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
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    return await Promise.race([output(), interrupted]);
  } finally {
    signal.removeEventListener("abort", stop);
    await stopGroup(child);
  }
}
