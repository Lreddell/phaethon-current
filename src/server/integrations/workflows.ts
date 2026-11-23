import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowPlatform, WorkflowRegistration, WorkflowRun, WorkflowSelection, WorkflowView } from "../../shared/workflows.ts";
import { prettyJson, readJson, realpath, writeFileAtomic } from "../core/fsx.ts";
import { appDataDir } from "../env.ts";
import { host } from "../host.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import { authorizeIntegration } from "./policy.ts";
import { runNative, windowsPowerShell } from "./native-process.ts";
import { Providers } from "./registry.ts";

type ScriptProvider = { executable: string; extension: string; args: (file: string) => string[] };
const providers = new Providers<WorkflowPlatform, ScriptProvider>()
  .register("powershell", () => ({ executable: windowsPowerShell(), extension: "ps1", args: (file) => ["-NoProfile", "-NonInteractive", "-File", file] }))
  .register("posix-shell", () => ({ executable: "/bin/sh", extension: "sh", args: (file) => [file] }));
const platform = (): WorkflowPlatform | null => process.platform === "win32" ? "powershell" : process.platform === "linux" ? "posix-shell" : null;
const configFile = () => path.join(appDataDir(), "local-workflows.json");
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 32 * 1024;
const TIMEOUT_MS = 120_000;

type State = { version: 1; workflows: WorkflowRegistration[]; runs: WorkflowRun[] };
let selection: { candidate: WorkflowSelection; expires: number } | undefined;
const active = new Map<string, AbortController>();

function state(): State {
  const entry = readJson<State>(configFile(), { version: 1, workflows: [], runs: [] });
  if (entry.version !== 1 || !Array.isArray(entry.workflows) || !Array.isArray(entry.runs)) {
    throw new Refusal("The local workflows file couldn’t be read.");
  }
  return entry;
}

function update(change: (entry: State) => void): void {
  const entry = state();
  change(entry);
  writeFileAtomic(configFile(), prettyJson(entry) + "\n", { mode: 0o600 });
}

function view(): WorkflowView {
  const id = platform();
  const { workflows, runs } = state();
  const reason = !id ? "Registered scripts are available on Windows and Linux. On Mac, use Apple Shortcuts in Mail & connectors."
    : !host().available ? "Register scripts in the Phaethon desktop app."
    : !fs.existsSync(providers.get(id).executable) ? "The required shell isn’t installed." : undefined;
  return { platform: id, canRegister: !reason, reason, workflows,
    runs: runs.map((r) => r.status === "running" && !active.has(r.workflow) ? { ...r, status: "interrupted" } : r) };
}

function scriptDigest(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) throw new Refusal("Choose a regular script under 1 MB.");
    const bytes = Buffer.alloc(st.size);
    if (fs.readSync(fd, bytes) !== st.size || fs.fstatSync(fd).size !== st.size) throw new Refusal("The script changed during review. Choose it again.");
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

async function choose(signal: AbortSignal): Promise<WorkflowSelection | null> {
  const current = view();
  if (!current.canRegister || !current.platform) throw new Refusal(current.reason ?? "The shell isn’t available.");
  const provider = providers.get(current.platform);
  const paths = await host().call<string[] | null>({ op: "pickFiles", title: "Choose a script you trust", multiple: false, filters: [{ name: "Workflow script", extensions: [provider.extension] }] });
  signal.throwIfAborted();
  const picked = paths?.[0];
  if (!picked) return null;
  const file = realpath(picked);
  if (path.extname(file).toLowerCase() !== `.${provider.extension}`) throw new Refusal(`Choose a .${provider.extension} script.`);
  const candidate = { token: randomUUID(), provider: current.platform, path: file, name: path.basename(file), digest: scriptDigest(file) };
  selection = { candidate, expires: Date.now() + 5 * 60_000 };
  return candidate;
}

function verifyFile(file: string, digest: string): void {
  try {
    if (file === realpath(file) && scriptDigest(file) === digest) return;
  } catch {
    // Missing, unreadable and modified scripts all require a new approval.
  }
  throw new Refusal("The registered script changed or moved. Review and register the file again.");
}

function register(token: unknown): WorkflowRegistration {
  if (!selection || selection.candidate.token !== token || selection.expires <= Date.now()) throw new Refusal("Choose the script again before registering it.");
  const { candidate } = selection;
  authorizeIntegration("modify", "user", candidate.provider === platform() && host().available);
  verifyFile(candidate.path, candidate.digest);
  const { token: _, ...registration } = candidate;
  const previous = state().workflows.find((w) => w.path === candidate.path);
  if (previous && active.has(previous.id)) throw new Refusal("Stop the previous run before registering the script again.");
  const record = { ...registration, id: previous?.id ?? randomUUID() };
  update((entry) => {
    if (!previous && entry.workflows.length >= 100) throw new Refusal("Remove a workflow before registering another.");
    entry.workflows = [...entry.workflows.filter((w) => w.id !== record.id), record];
  });
  selection = undefined;
  return record;
}

const scriptEnvironment = () => {
  const base = new Set(["APPDATA", "COMMONPROGRAMFILES", "COMPUTERNAME", "HOME", "LANG", "LOCALAPPDATA", "LOGNAME", "OS", "PATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "USERPROFILE", "WINDIR"]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => base.has(name.toUpperCase())));
};

async function run(id: string, digest: string, raw: unknown, requester: AbortSignal): Promise<{ run: WorkflowRun; output?: string; error?: string }> {
  const workflow = state().workflows.find((w) => w.id === id);
  if (!workflow || workflow.digest !== digest) throw new Refusal("Review the current workflow before running it.");
  authorizeIntegration("execute", "user", workflow.provider === platform() && host().available);
  if (active.has(id)) throw new Refusal("This workflow is already running.");
  requester.throwIfAborted();
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Refusal("Enter a JSON object under 32 KB.");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Refusal("Enter valid JSON for the workflow inputs."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Refusal("Enter the workflow inputs as a JSON object.");
  const provider = providers.get(workflow.provider);
  if (!fs.existsSync(provider.executable)) throw new Refusal("The shell for this workflow isn’t installed.");
  verifyFile(workflow.path, workflow.digest);
  const record: WorkflowRun = { id: randomUUID(), workflow: id, name: workflow.name, started: Date.now(), status: "running" };
  update((entry) => { entry.runs = [record, ...entry.runs].slice(0, 100); });
  const controller = new AbortController();
  active.set(id, controller);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const output = await runNative(provider.executable, provider.args(workflow.path), JSON.stringify(input), AbortSignal.any([requester, controller.signal, timeout]),
      { cwd: path.dirname(workflow.path), env: scriptEnvironment() });
    record.status = "completed";
    return { run: record, output: output.slice(0, 20_000) };
  } catch {
    record.status = controller.signal.aborted || requester.aborted ? "cancelled" : timeout.aborted ? "timed-out" : "failed";
    const error = record.status === "cancelled" ? "Workflow cancelled." : record.status === "timed-out" ? "The workflow exceeded two minutes."
      : "The script could not finish. Check that it runs under your shell’s current policy.";
    return { run: record, error };
  } finally {
    active.delete(id);
    record.finished = Date.now();
    update((entry) => { entry.runs = entry.runs.map((r) => r.id === record.id ? record : r); });
  }
}

commands({
  workflows_get: view,
  workflow_choose: (_, ctx) => choose(ctx.signal),
  workflow_register: ({ token }: { token: unknown }) => register(token),
  workflow_run: ({ id, digest, input }: { id: string; digest: string; input: unknown }, ctx) => run(id, digest, input, ctx.signal),
  workflow_cancel: ({ id }: { id: string }) => { active.get(id)?.abort(); },
  workflow_remove: ({ id }: { id: string }) => {
    authorizeIntegration("delete", "user", !active.has(id));
    update((entry) => { entry.workflows = entry.workflows.filter((w) => w.id !== id); });
  },
});
