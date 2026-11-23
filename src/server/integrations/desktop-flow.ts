import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopFlowIds } from "../../shared/desktop-flow.ts";
import type { DesktopFlow } from "../../shared/workflows.ts";
import { prettyJson, readJson, writeFileAtomic } from "../core/fsx.ts";
import { appDataDir } from "../env.ts";
import { host } from "../host.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import { authorizeIntegration } from "./policy.ts";

const file = () => path.join(appDataDir(), "desktop-flows.json");
const launching = new Set<string>();
const supported = () => process.platform === "win32" && host().available;

function flows(): DesktopFlow[] {
  const raw = readJson<{ version: number; flows: DesktopFlow[] }>(file(), { version: 1, flows: [] });
  if (raw?.version !== 1 || !Array.isArray(raw.flows)) throw new Refusal("The local Power Automate registrations couldn’t be read.");
  return raw.flows;
}

function save(change: (previous: DesktopFlow[]) => DesktopFlow[]): void {
  writeFileAtomic(file(), prettyJson({ version: 1, flows: change(flows()) }) + "\n", { mode: 0o600 });
}

const available = () => (supported() ? host().call<boolean>({ op: "desktopFlowAvailable" }).catch(() => false) : Promise.resolve(false));

commands({
  desktop_flows_get: async () => ({ available: await available(), flows: supported() ? flows() : [] }),
  desktop_flow_register: ({ name, url }: { name: unknown; url: unknown }) => {
    authorizeIntegration("modify", "user", supported());
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\r\n]/.test(name)) throw new Refusal("Enter a name under 80 characters.");
    const refs = typeof url === "string" ? desktopFlowIds(url) : null;
    if (!refs) throw new Refusal("Paste the run URL with environment and flow IDs from Power Automate’s flow properties.");
    save((previous) => {
      if (previous.length >= 100) throw new Refusal("Remove a flow before registering another.");
      if (previous.some((flow) => flow.environmentId.toLowerCase() === refs.environmentId.toLowerCase() && flow.workflowId.toLowerCase() === refs.workflowId.toLowerCase()))
        throw new Refusal("This flow is already registered.");
      return [...previous, { ...refs, id: randomUUID(), name: name.trim() }];
    });
  },
  desktop_flow_launch: async ({ id }: { id: string }, ctx) => {
    authorizeIntegration("execute", "user", supported());
    if (launching.has(id)) throw new Refusal("Power Automate is already receiving this request.");
    launching.add(id);
    try {
      const flow = flows().find((item) => item.id === id);
      if (!flow) throw new Refusal("Register this flow before opening it.");
      if (!await available()) throw new Refusal("Install and sign in to Power Automate for desktop first.");
      ctx.signal.throwIfAborted();
      const runId = randomUUID();
      try { await host().call({ op: "desktopFlowLaunch", environmentId: flow.environmentId, workflowId: flow.workflowId, runId }); }
      catch { throw new Refusal("Windows couldn’t open this flow. Check Power Automate’s installation and sign-in."); }
      save((previous) => previous.map((item) => item.id === flow.id ? { ...item, lastRequest: { id: runId, at: Date.now() } } : item));
      return { status: "launch-requested" };
    } finally {
      launching.delete(id);
    }
  },
  desktop_flow_remove: ({ id }: { id: string }) => {
    authorizeIntegration("delete", "user", supported() && !launching.has(id));
    save((previous) => previous.filter((item) => item.id !== id));
  },
});
