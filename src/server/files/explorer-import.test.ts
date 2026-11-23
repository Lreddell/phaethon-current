import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { explorerArguments, forwardedExplorerArguments, localExplorerPath } from "../../desktop/explorer-arguments.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { host, setHost } from "../host.ts";
import { receiveExplorerSelection } from "./explorer-import.ts";

const env = tempHome("phaethon-explorer-import-");
const originalHost = host();
const fixture = fs.realpathSync(env.home);
ensureVault();
afterEach(() => setHost(originalHost));
afterAll(env.cleanup);

it("accepts quoted Windows paths as separate arguments and rejects device paths and traversal", () => {
  expect(explorerArguments(["Phaethon.exe", "--explorer-import", "C:\\My folder\\a & b.txt", "D:\\photos\\two.jpg", "\\\\server\\share\\file.txt"]))
    .toEqual({ paths: ["C:\\My folder\\a & b.txt", "D:\\photos\\two.jpg"], skipped: 1 });
  for (const bad of ["relative.txt", "C:\\work\\..\\other.txt", "C:\\work\\NUL.txt", "C:\\work\\file.txt:stream", "-flag"]) {
    expect(localExplorerPath(bad)).toBeUndefined();
  }
  expect(forwardedExplorerArguments({ paths: ["C:\\My folder\\a & b.txt"], skipped: 0 })).toEqual({ paths: ["C:\\My folder\\a & b.txt"], skipped: 0 });
  expect(forwardedExplorerArguments({ paths: ["C:\\work\\file.txt:stream"], skipped: 0 })).toEqual({ paths: [], skipped: 1 });
});

it("previews filenames only and copies multiple files once after a Space is confirmed", async () => {
  setHost({ available: true, call: async <T,>() => undefined as T, on: () => () => {} });
  const docs = ["explorer sample one.txt", "explorer sample two.txt"];
  const paths = docs.map((name) => {
    const p = path.join(fixture, name);
    fs.writeFileSync(p, name);
    return p;
  });
  const selection = receiveExplorerSelection(paths, 0);
  expect(selection.files).toEqual(docs.map((name) => ({ name, size: Buffer.byteLength(name) })));
  expect(JSON.stringify(await call("explorer_pending"))).not.toContain(fixture);
  const destination = path.join(spaceDir("school"), "files", docs[0]!);
  expect(fs.existsSync(destination)).toBe(false);
  await expect(call("explorer_import", { id: "unknown", space: "school" })).rejects.toThrow("Send the files");
  await expect(call("explorer_import", { id: selection.id, space: "school" })).resolves.toMatchObject({
    files: 2, paths: docs.map((name) => `files/${name}`),
  });
  expect(fs.readFileSync(destination, "utf8")).toBe(docs[0]);
  expect(fs.readFileSync(paths[0]!, "utf8")).toBe(docs[0]);
  await expect(call("explorer_import", { id: selection.id, space: "school" })).rejects.toThrow("Send the files");
});

it("refuses a file that changed after it was reviewed", async () => {
  setHost({ available: true, call: async <T,>() => undefined as T, on: () => () => {} });
  const file = path.join(fixture, "explorer changed.txt");
  fs.writeFileSync(file, "before");
  const selection = receiveExplorerSelection([file], 0);
  fs.writeFileSync(file, "after approval");
  await expect(call("explorer_import", { id: selection.id, space: "school" })).rejects.toThrow("selected file changed");
  expect(fs.existsSync(path.join(spaceDir("school"), "files", path.basename(file)))).toBe(false);
  await call("explorer_dismiss", { id: selection.id });
  await expect(call("explorer_pending")).resolves.toBeNull();
});
