import fs from "node:fs";
import path from "node:path";
import type { FileCatalog, FileCatalogItem, FileCatalogProvider } from "../../shared/file-catalog.ts";
import { walkFileNames, type Root } from "../agent/tools/search.ts";
import { isWithin, realpath } from "../core/fsx.ts";
import { nativeEnvironment, runNative, windowsPowerShell } from "../integrations/native-process.ts";
import { Providers } from "../integrations/registry.ts";
import { Refusal } from "../rpc/registry.ts";

const maxResults = 100;
const searchable = /^[\p{L}\p{N}. -]{2,160}$/u;
type NativeId = Exclude<FileCatalogProvider, "local">;
type NativeIndex = { id: NativeId; installed(): boolean; find(root: string, query: string, signal: AbortSignal): Promise<string[]> };

const searchScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$query = [Console]::In.ReadToEnd()
$connection = New-Object -ComObject ADODB.Connection
try {
  $connection.ConnectionTimeout = 2
  $connection.CommandTimeout = 2
  $connection.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  $rows = $connection.Execute($query)
  $paths = New-Object 'System.Collections.Generic.List[string]'
  try {
    while (!$rows.EOF -and $paths.Count -lt 100) {
      $item = $rows.Fields.Item('System.ItemPathDisplay').Value
      if ($item -is [string] -and $item.Length -le 32767) { $paths.Add($item) }
      $rows.MoveNext()
    }
  } finally { $rows.Close() }
  ConvertTo-Json -Compress -InputObject @($paths.ToArray())
} finally { if ($connection.State) { $connection.Close() } }
`.trim();
// EncodedCommand accepts only this fixed helper. Folder and filename are data on stdin.
const windowsCommand = Buffer.from(searchScript, "utf16le").toString("base64");

export function windowsSearchQuery(root: string, query: string): string | undefined {
  if (!/^[a-z]:[\\/]/i.test(root) || /[\x00-\x1f]/.test(root) || !searchable.test(query)) return undefined;
  const scope = root.replaceAll("\\", "/").replaceAll("'", "''");
  return `SELECT TOP ${maxResults} System.ItemPathDisplay FROM SYSTEMINDEX WHERE SCOPE='file:${scope}' AND System.FileName LIKE '%${query}%'`;
}

const providers = new Providers<NativeId, NativeIndex>()
  .register("windows-search", () => ({
    id: "windows-search",
    installed: () => fs.existsSync(windowsPowerShell()),
    async find(root, query, signal) {
      const sql = windowsSearchQuery(root, query);
      if (!sql) return [];
      const result: unknown = JSON.parse(await runNative(windowsPowerShell(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", windowsCommand], sql, signal, { env: nativeEnvironment() }));
      if (!Array.isArray(result)) throw new Error("Windows Search returned an invalid result.");
      return result.filter((item): item is string => typeof item === "string").slice(0, maxResults);
    },
  }))
  .register("spotlight", () => ({
    id: "spotlight",
    installed: () => fs.existsSync("/usr/bin/mdfind"),
    async find(root, query, signal) {
      const predicate = `kMDItemFSName ==[cd] "*${query}*"`;
      const result = await runNative("/usr/bin/mdfind", ["-0", "-onlyin", root, predicate], "", signal, { env: nativeEnvironment() });
      return result.split("\0").filter(Boolean).slice(0, maxResults);
    },
  }));

function nativeIndex(): NativeIndex | undefined {
  const id = process.platform === "win32" ? "windows-search" : process.platform === "darwin" ? "spotlight" : undefined;
  if (!id || process.env.PHAETHON_TEST === "1") return undefined;
  const provider = providers.get(id);
  return provider.installed() ? provider : undefined;
}

/** Index entries are untrusted hints. Recheck the selected root and every path component. */
export function catalogItem(root: Root, absolute: string, source: FileCatalogProvider): FileCatalogItem | undefined {
  if (!path.isAbsolute(absolute) || !isWithin(absolute, root.dir)) return undefined;
  const parts = path.relative(root.dir, absolute).split(path.sep);
  if (!parts[0] || parts.some((part) => part.toLowerCase() === ".phaethon") ||
      (root.skipRootCourses && parts[0].toLowerCase() === "courses") || (root.allow && parts.some((part) => part.startsWith(".")))) return undefined;
  const displayPath = root.prefix + parts.join("/");
  if (Buffer.byteLength(displayPath) > 1024) return undefined;
  try {
    if (path.relative(root.dir, realpath(root.dir)) !== "") return undefined;
    let current = root.dir;
    for (let i = 0; i < parts.length; i++) {
      const relative = parts.slice(0, i + 1).join("/");
      if (root.skip?.(relative)) return undefined;
      current = path.join(current, parts[i]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return undefined;
      if (i < parts.length - 1) {
        if (!stat.isDirectory()) return undefined;
        continue;
      }
      if (!stat.isFile() || !isWithin(realpath(current), root.dir) || (root.allow && !root.allow(relative))) return undefined;
      return { path: displayPath, size: stat.size, modified: Math.trunc(stat.mtimeMs), source };
    }
  } catch { /* A stale index result or a file removed during discovery. */ }
  return undefined;
}

function foldName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export async function searchNativeFiles(roots: () => Root[], query: string, signal?: AbortSignal): Promise<FileCatalog> {
  const available = searchable.test(query) ? nativeIndex() : undefined;
  const nativeRoot = available ? roots().find((root) => !root.allow) : undefined;
  if (!nativeRoot || !available) return { items: [], providers: [], truncated: false };
  if (available.id === "windows-search" && !windowsSearchQuery(nativeRoot.dir, query)) return { items: [], providers: [], truncated: false };
  let nativePaths: string[];
  try {
    nativePaths = await available.find(nativeRoot.dir, query, AbortSignal.any([AbortSignal.timeout(1800), ...(signal ? [signal] : [])]));
  } catch {
    signal?.throwIfAborted();
    return { items: [], providers: [], truncated: false };
  }
  const indexedRoot = roots().find((root) => root.dir === nativeRoot.dir && root.prefix === nativeRoot.prefix);
  const needle = foldName(query);
  const items = indexedRoot ? nativePaths.flatMap((file) => {
    const item = foldName(path.basename(file)).includes(needle) ? catalogItem(indexedRoot, file, available.id) : undefined;
    return item ? [item] : [];
  }) : [];
  return { items, providers: [available.id], truncated: nativePaths.length >= maxResults };
}

export async function searchFileCatalog(roots: () => Root[], rawQuery: unknown, signal?: AbortSignal): Promise<FileCatalog> {
  if (typeof rawQuery !== "string" || rawQuery.trim().length < 2 || rawQuery.length > 160 || /[\x00-\x1f]/.test(rawQuery))
    throw new Refusal("Enter 2 to 160 characters to find a file by name.");
  signal?.throwIfAborted();
  const query = rawQuery.trim();
  const needle = foldName(query);
  if (!needle) throw new Refusal("Enter a file name to search.");
  const matches = (file: string) => foldName(path.basename(file)).includes(needle);
  const indexed = await searchNativeFiles(roots, query, signal);
  // Re-resolve the grant and exclusions after waiting for the native index.
  const current = roots();
  const items = new Map(indexed.items.map((item) => [item.path, item]));
  const truncated = walkFileNames(current, (root, file) => {
    signal?.throwIfAborted();
    if (!matches(file)) return true;
    const item = catalogItem(root, file, "local");
    if (item && !items.has(item.path)) {
      if (items.size >= maxResults) return false;
      items.set(item.path, item);
    }
    return true;
  });
  return {
    items: [...items.values()].sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path)),
    providers: [...indexed.providers, "local"], truncated: truncated || indexed.truncated,
  };
}
