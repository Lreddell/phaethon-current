import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { EXPLORER_MAX_FILES, type ExplorerSelection, type ExplorerStatus } from "../../shared/explorer.ts";
import { openTarget } from "../background/background.ts";
import { fileStamp, isWithin, realpath } from "../core/fsx.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { host } from "../host.ts";
import { authorizeIntegration } from "../integrations/policy.ts";
import { onStart } from "../lifecycle.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import { addToSpace } from "./add.ts";

type Source = { file: string; name: string; size: number; stamp: string };
type Pending = { view: ExplorerSelection; sources: Source[]; vault: string; expires: number };
const maximumBytes = 256 * 1024 * 1024;
let pending: Pending | undefined;

function snapshot(file: string, vault: string): Source | undefined {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.length > 2048 ||
    (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(file))) return undefined;
  try {
    const name = path.basename(file);
    const st = fs.lstatSync(file, { bigint: true });
    if (!name || name.startsWith(".") || /[\x00-\x1f]/.test(name) || !st.isFile() || st.size > maximumBytes ||
      path.relative(file, realpath(file)) || isWithin(file, vault)) return undefined;
    return { file, name, size: Number(st.size), stamp: fileStamp(st) };
  } catch { return undefined; }
}

export function receiveExplorerSelection(paths: string[], skipped: number): ExplorerSelection {
  const previous = current();
  const vault = realpath(vaultRoot());
  const sources = previous?.vault === vault ? [...previous.sources] : [];
  let size = sources.reduce((total, item) => total + item.size, 0);
  const seen = new Set(sources.map((source) => source.file.toLowerCase()));
  skipped += (previous?.view.skipped ?? 0) + Math.max(0, paths.length - EXPLORER_MAX_FILES);
  for (const file of paths.slice(0, EXPLORER_MAX_FILES)) {
    const source = snapshot(file, vault);
    if (!source || sources.length >= EXPLORER_MAX_FILES || size + source.size > maximumBytes) { skipped++; continue; }
    if (seen.has(file.toLowerCase())) continue;
    seen.add(file.toLowerCase());
    size += source.size;
    sources.push(source);
  }
  const view: ExplorerSelection = {
    id: randomUUID(), files: sources.map(({ name, size }) => ({ name, size })), skipped,
    ...(!sources.length ? { reason: "No regular local files were available to import." } : {}),
  };
  pending = { view, sources, vault, expires: Date.now() + 5 * 60_000 };
  return view;
}

function current(): Pending | undefined {
  if (pending && pending.expires <= Date.now()) pending = undefined;
  return pending;
}

async function stage(source: Source, destination: string, signal: AbortSignal): Promise<void> {
  const file = await fsp.open(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || fileStamp(before) !== source.stamp) throw new Error("Source changed");
    if (source.size > 0) {
      await pipeline(file.createReadStream({ autoClose: false, start: 0, end: source.size - 1 }),
        fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
    } else await fsp.writeFile(destination, "", { flag: "wx", mode: 0o600, signal });
    const after = await file.stat({ bigint: true });
    if (fileStamp(after) !== source.stamp || fs.statSync(destination).size !== source.size) throw new Error("Source changed");
  } finally { await file.close().catch(() => {}); }
}

async function apply(id: unknown, space: unknown, signal: AbortSignal) {
  const request = current();
  if (!request || request.view.id !== id || !request.sources.length) throw new Refusal("Send the files from File Explorer again to review them.");
  if (typeof space !== "string") throw new Refusal("Choose the Space that should receive the files.");
  const destination = spaceDir(space);
  const vault = realpath(vaultRoot());
  if (path.relative(vault, request.vault)) throw new Refusal("Return to the original vault before importing these files.");
  for (const source of request.sources) {
    if (snapshot(source.file, vault)?.stamp !== source.stamp) throw new Refusal("A selected file changed. Send the files again to review the new selection.");
  }
  pending = undefined;
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "phaethon-explorer-"));
  try {
    const staged: string[] = [];
    for (const [index, source] of request.sources.entries()) {
      const folder = path.join(temp, String(index));
      await fsp.mkdir(folder, { mode: 0o700 });
      const file = path.join(folder, source.name);
      await stage(source, file, signal).catch(() => {
        signal.throwIfAborted();
        throw new Refusal("A selected file couldn’t be read. Send the files again after checking that they are still available.");
      });
      staged.push(file);
    }
    signal.throwIfAborted();
    if (path.relative(vault, realpath(vaultRoot())) || path.relative(destination, spaceDir(space)))
      throw new Refusal("The destination Space changed. Send the files again and choose its destination.");
    return await addToSpace(destination, vault, staged);
  } finally { await fsp.rm(temp, { recursive: true, force: true }).catch(() => {}); }
}

commands({
  explorer_status: (): ExplorerStatus | Promise<ExplorerStatus> => host().available
    ? host().call<ExplorerStatus>({ op: "explorerLink", action: "status" }) : { state: "unsupported" },
  explorer_set: ({ enabled }: { enabled?: unknown }) => {
    authorizeIntegration("modify", "user", host().available);
    if (typeof enabled !== "boolean") throw new Refusal("Choose whether to enable File Explorer import.");
    if (!enabled) pending = undefined;
    return host().call<ExplorerStatus>({ op: "explorerLink", action: enabled ? "enable" : "disable" });
  },
  explorer_pending: () => current()?.view ?? null,
  explorer_dismiss: ({ id }: { id: unknown }) => { if (current()?.view.id === id) pending = undefined; },
  explorer_import: ({ id, space }: { id: unknown; space: unknown }, ctx) => {
    authorizeIntegration("modify", "user", host().available);
    return apply(id, space, ctx.signal);
  },
});

onStart("review files selected in Explorer", () => {
  host().on((event) => {
    if (event.kind !== "explorerSelection") return;
    receiveExplorerSelection(event.paths, event.skipped);
    openTarget({ kind: "settings", section: "desktop" });
  });
});
