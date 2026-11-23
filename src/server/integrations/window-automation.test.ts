import { afterEach, expect, it, vi } from "vitest";
import type { AccessibleWindow, WindowInspection } from "../../shared/window-automation.ts";
import { host, setHost } from "../host.ts";
import { handlerFor } from "../rpc/registry.ts";
import { setWindowAutomationForTest } from "./window-automation.ts";
import type { NativeControl, NativeWindow } from "./windows-uia-native.ts";

const originalHost = host();
afterEach(() => {
  setWindowAutomationForTest(undefined);
  setHost(originalHost);
  vi.useRealTimers();
});

const window: NativeWindow = { handle: "131332", pid: 5002, started: "638000000000000000", app: "example", title: "Example window" };
const button: NativeControl = { runtime: "45.77", name: "Apply", automationId: "apply-button", role: "Button", depth: 2, actions: ["invoke"] };

function fixture() {
  const run = vi.fn(async () => {});
  const inspect = vi.fn(async () => ({ truncated: false, controls: [button] }));
  setHost({ available: true, call: async <T,>() => undefined as T, on: () => () => {} });
  setWindowAutomationForTest({ available: () => true, list: async () => [window], inspect, apply: run });
  const connection = new AbortController();
  const call = async <T,>(name: string, args: Record<string, unknown> = {}, signal = connection.signal) =>
    await handlerFor(`window_automation_${name}`)!(args, { signal }) as T;
  return { call, connection, run, inspect };
}

it("requires a listed window grant and an explicit one-time review before Windows is changed", async () => {
  const { call, inspect, run, connection } = fixture();
  await expect(call("inspect", { id: window.handle })).rejects.toThrow("Refresh the window list");
  expect(inspect).not.toHaveBeenCalled();
  const [listed] = await call<AccessibleWindow[]>("list");
  expect(listed).toMatchObject({ app: window.app, title: window.title });
  expect(listed?.id).not.toBe(window.handle);
  await expect(call("inspect", { id: listed?.id }, new AbortController().signal)).rejects.toThrow("Refresh the window list");
  const view = await call<WindowInspection>("inspect", { id: listed?.id });
  const control = view.controls[0]!;
  expect(control.id).not.toBe(button.runtime);
  await expect(call("review", { id: control.id, action: "set-value", value: "test" })).rejects.toThrow("eligible control");
  await expect(call("apply", { id: control.id })).rejects.toThrow("Review the control action");
  expect(run).not.toHaveBeenCalled();
  const review = await call<{ id: string }>("review", { id: control.id, action: "invoke" });
  expect(run).not.toHaveBeenCalled();
  await call("apply", { id: review.id });
  expect(run).toHaveBeenCalledWith({ kind: "apply", action: "invoke", window, control: button }, connection.signal);
  await expect(call("apply", { id: review.id })).rejects.toThrow("Review the control action");
  await expect(call("review", { id: control.id, action: "invoke" })).rejects.toThrow("eligible control");
});

it("revokes access if the renderer closes or the action review expires", async () => {
  vi.useFakeTimers();
  const { call, run, connection } = fixture();
  const [listed] = await call<AccessibleWindow[]>("list");
  const view = await call<WindowInspection>("inspect", { id: listed?.id });
  const control = view.controls[0]!;
  const first = await call<{ id: string }>("review", { id: control.id, action: "invoke" });
  vi.advanceTimersByTime(61_000);
  await expect(call("apply", first)).rejects.toThrow("Review the control action");
  const second = await call<{ id: string }>("review", { id: control.id, action: "invoke" });
  connection.abort();
  await expect(call("apply", second)).rejects.toThrow("Review the control action");
  expect(run).not.toHaveBeenCalled();
});
