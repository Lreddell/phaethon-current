import { afterAll, afterEach, describe, expect, it } from "vitest";
import { desktopFlowIds, desktopFlowRunUrl } from "../../shared/desktop-flow.ts";
import type { HostOp } from "../../shared/host.ts";
import type { DesktopFlow } from "../../shared/workflows.ts";
import { call, tempHome } from "../../../tests/harness.ts";
import { host, setHost } from "../host.ts";
import "./desktop-flow.ts";

const env = tempHome("phaethon-power-automate-");
const originalHost = host();
afterEach(() => setHost(originalHost));
afterAll(() => env.cleanup());

const environmentId = "Default-01234567-1234-1234-1234-1234567890ab";
const workflowId = "01234567-1234-1234-1234-1234567890bc";
const runId = "01234567-1234-1234-1234-1234567890cd";
const registration = `ms-powerautomate:/console/flow/run?environmentId=${environmentId}&workflowId=${workflowId}`;

describe("Power Automate URL adapter", () => {
  it("binds the environment and flow and allows only the documented request format", () => {
    expect(desktopFlowIds(registration)).toEqual({ environmentId, workflowId });
    expect(desktopFlowIds(`${registration}&autologin=true`)).toBeNull();
    expect(desktopFlowIds(`${registration}&environmentId=${environmentId}`)).toBeNull();
    expect(desktopFlowIds(registration.replace("ms-powerautomate:", "https:"))).toBeNull();
    expect(desktopFlowRunUrl(environmentId, workflowId, runId)).toBe(`${registration}&runId=${runId}`);
    expect(() => desktopFlowRunUrl(environmentId, "x", runId)).toThrow("identifiers are invalid");
  });

  it.skipIf(process.platform !== "win32")("records only a launch request and delegates the flow to Power Automate", async () => {
    const ops: HostOp[] = [];
    setHost({ available: true, call: async <T,>(op: HostOp) => { ops.push(op); return (op.op === "desktopFlowAvailable" ? true : null) as T; }, on: () => () => {} });
    await call("desktop_flow_register", { name: "Example", url: registration });
    const [flow] = (await call<{ flows: DesktopFlow[] }>("desktop_flows_get")).flows;
    await expect(call("desktop_flow_launch", { id: flow!.id })).resolves.toEqual({ status: "launch-requested" });
    const request = ops.find((op) => op.op === "desktopFlowLaunch");
    expect(request).toMatchObject({ environmentId, workflowId, runId: expect.any(String) });
    const latest = (await call<{ flows: DesktopFlow[] }>("desktop_flows_get")).flows[0];
    expect(latest?.lastRequest?.id).toBe(request?.runId);
  });
});
