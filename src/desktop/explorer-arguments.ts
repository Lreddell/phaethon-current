import path from "node:path";
import { EXPLORER_FLAG, EXPLORER_MAX_FILES } from "../shared/explorer.ts";

export function localExplorerPath(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 2048 || !/^[A-Za-z]:[\\/]/.test(input) ||
      /[<>:"|?*\x00-\x1f]/.test(input.slice(2))) return undefined;
  const parts = input.slice(3).split(/[\\/]/);
  if (parts.some((part) => !part || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) return undefined;
  return path.win32.normalize(input);
}

export function explorerArguments(argv: readonly string[]): { paths: string[]; skipped: number } | undefined {
  const start = argv.indexOf(EXPLORER_FLAG);
  if (start < 0) return undefined;
  const paths: string[] = [];
  const seen = new Set<string>();
  let skipped = Math.max(0, argv.length - start - 1 - EXPLORER_MAX_FILES);
  for (const entry of argv.slice(start + 1, start + 1 + EXPLORER_MAX_FILES)) {
    const file = localExplorerPath(entry);
    if (!file) { skipped++; continue; }
    if (!seen.has(file.toLowerCase())) paths.push(file);
    seen.add(file.toLowerCase());
  }
  return { paths, skipped };
}

export function forwardedExplorerArguments(input: unknown): ReturnType<typeof explorerArguments> {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as { paths?: unknown; skipped?: unknown };
  if (!Array.isArray(raw.paths) || raw.paths.length > EXPLORER_MAX_FILES || !raw.paths.every((item) => typeof item === "string")) return undefined;
  const result = explorerArguments([EXPLORER_FLAG, ...raw.paths])!;
  if (typeof raw.skipped === "number" && Number.isSafeInteger(raw.skipped) && raw.skipped > 0) result.skipped += Math.min(raw.skipped, 500);
  return result;
}
