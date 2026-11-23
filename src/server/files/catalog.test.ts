import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { catalogItem, searchFileCatalog, windowsSearchQuery } from "./catalog.ts";

const env = tempHome("phaethon-file-catalog-");
const root = path.join(fs.realpathSync(env.home), "space");
const outside = path.join(fs.realpathSync(env.home), "outside");
const file = path.join(root, "notes", "Résumé.txt");
const settings = { dir: root, prefix: "shared/", skipRootCourses: true, skip: (relative: string) => relative === "private" };

beforeAll(() => {
  for (const directory of [path.dirname(file), path.join(root, "private"), path.join(root, ".phaethon"), path.join(root, "courses"), outside]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "resume-private.txt"), "content");
  }
  fs.writeFileSync(file, "example");
  fs.rmSync(path.join(path.dirname(file), "resume-private.txt"));
});
afterAll(env.cleanup);

describe("file catalog", () => {
  it("uses the bounded local name search with path and current file metadata", async () => {
    const snapshot = fs.statSync(file);
    await expect(searchFileCatalog(() => [settings], "resume")).resolves.toEqual({
      items: [{ path: "shared/notes/Résumé.txt", size: snapshot.size, modified: Math.trunc(snapshot.mtimeMs), source: "local" }],
      providers: ["local"], truncated: false,
    });
  });

  it("refuses stale, excluded, state and out-of-scope index results", () => {
    for (const target of [path.join(root, "deleted"), path.join(outside, "resume-private.txt"), path.join(root, "private/resume-private.txt"),
      path.join(root, ".phaethon/resume-private.txt"), path.join(root, "courses/resume-private.txt"), "notes/Résumé.txt"]) {
      expect(catalogItem(settings, target, "windows-search")).toBeUndefined();
    }
    const link = path.join(root, "link");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(catalogItem(settings, path.join(link, "resume-private.txt"), "spotlight")).toBeUndefined();
  });

  it("keeps Windows Search input bounded and escapes the local scope", () => {
    expect(windowsSearchQuery("C:\\Users\\O'Brien\\space", "Week 2")).toContain("SCOPE='file:C:/Users/O''Brien/space' AND System.FileName LIKE '%Week 2%'");
    expect(windowsSearchQuery("C:\\folder", "Week's plan_%?")).toBeUndefined();
    expect(windowsSearchQuery("\\\\host\\share", "Week 2")).toBeUndefined();
  });
});
