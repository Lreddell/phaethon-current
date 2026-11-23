import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import type { WorkflowRegistration, WorkflowSelection, WorkflowView } from "../../shared/workflows.ts";
import { host, setHost } from "../host.ts";
import { runNative } from "./native-process.ts";
import "./workflows.ts";

vi.mock("./native-process.ts", async (load) => ({ ...(await load<typeof import("./native-process.ts")>()), runNative: vi.fn() }));
const env = tempHome("phaethon-workflows-");
const oldHost = host();
afterEach(() => { setHost(oldHost); vi.resetAllMocks(); });
afterAll(() => env.cleanup());

const available = process.platform === "win32" || process.platform === "linux";

async function pick(basename: string) {
  const file = path.join(env.home, `${basename}.${process.platform === "win32" ? "ps1" : "sh"}`);
  fs.writeFileSync(file, "# fixture");
  setHost({ available: true, call: async <T,>() => [file] as T, on: () => () => {} });
  const selected = await call<WorkflowSelection>("workflow_choose");
  const registered = await call<WorkflowRegistration>("workflow_register", { token: selected.token });
  return { selected, registered, file };
}

describe("registered workflows", () => {
  it("requires desktop registration and has no arbitrary execution command", async () => {
    expect(await call<WorkflowView>("workflows_get")).toMatchObject({ canRegister: false });
    await expect(call("workflow_register", { token: "fake", path: "anything" })).rejects.toThrow("Choose the script again");
    await expect(call("workflow_run", { id: "fake", digest: "fake", input: "{}" })).rejects.toThrow("Review the current workflow");
  });

  it.skipIf(!available)("requires the selection, checks the file digest, and passes structured inputs separately", async () => {
    const { selected, registered, file } = await pick("readable fixture");
    await expect(call("workflow_register", { token: selected.token })).rejects.toThrow("Choose the script again");
    await expect(call("workflow_run", { id: registered.id, digest: registered.digest, input: "[]" })).rejects.toThrow("JSON object");
    vi.mocked(runNative).mockResolvedValueOnce("fixture output");
    const input = JSON.stringify({ message: "a quote ' and a shell metacharacter &" });
    await expect(call("workflow_run", { id: registered.id, digest: registered.digest, input })).resolves.toMatchObject({ run: { status: "completed" }, output: "fixture output" });
    const [bin, args, stdin, , options] = vi.mocked(runNative).mock.calls[0]!;
    expect(path.isAbsolute(bin)).toBe(true);
    expect(args.at(-1)).toBe(registered.path);
    expect(args).not.toContain("-ExecutionPolicy");
    expect(stdin).toBe(input);
    expect(options?.cwd).toBe(path.dirname(registered.path));
    fs.appendFileSync(file, "\n# edited");
    await expect(call("workflow_run", { id: registered.id, digest: registered.digest, input })).rejects.toThrow("changed or moved");
    expect(runNative).toHaveBeenCalledTimes(1);
    expect((await call<WorkflowView>("workflows_get")).runs[0]).toMatchObject({ status: "completed" });
    await call("workflow_remove", { id: registered.id });
    expect(fs.existsSync(file)).toBe(true);
    expect((await call<WorkflowView>("workflows_get")).workflows.some((w) => w.id === registered.id)).toBe(false);
  });

  it.skipIf(!available)("cancels a running script and records an audit outcome without inputs or output", async () => {
    const { registered } = await pick("cancel fixture");
    vi.mocked(runNative).mockImplementationOnce((_, __, ___, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const pending = call("workflow_run", { id: registered.id, digest: registered.digest, input: '{"test":"private detail"}' });
    expect((await call<WorkflowView>("workflows_get")).runs[0]?.status).toBe("running");
    await call("workflow_cancel", { id: registered.id });
    await expect(pending).resolves.toMatchObject({ run: { status: "cancelled" } });
    expect(fs.readFileSync(path.join(env.appData, "local-workflows.json"), "utf8")).not.toContain("private detail");
  });
});
