import { randomUUID } from "node:crypto";
import type { AccessibleControl, AccessibleWindow, WindowAction, WindowInspection } from "../../shared/window-automation.ts";
import { host } from "../host.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import { authorizeIntegration } from "./policy.ts";
import { windowsAutomation, type NativeControl, type NativeWindow, type NativeWindowAutomation } from "./windows-uia-native.ts";

const actions: readonly WindowAction[] = ["invoke", "set-value", "scroll-up", "scroll-down"];
const lifetime = 5 * 60_000;
type Selection = { window: NativeWindow; expires: number; controls: Map<string, NativeControl>; signal: AbortSignal };
type ActionReview = { id: string; selection: Selection; control: NativeControl; action: WindowAction; value?: string; expires: number };
let adapter: NativeWindowAutomation = windowsAutomation;
let listed: { candidates: Map<string, NativeWindow>; expires: number; signal: AbortSignal } | undefined;
let selected: Selection | undefined;
let review: ActionReview | undefined;
let busy = false;
let proof = 0;

function available(): boolean { return host().available && adapter.available(); }
function requireAccess() { authorizeIntegration("modify", "user", available()); }

function clear(): void {
  selected?.signal.removeEventListener("abort", clear);
  selected = undefined;
  review = undefined;
  proof++;
}

export function setWindowAutomationForTest(test: NativeWindowAutomation | undefined): void {
  adapter = test ?? windowsAutomation;
  listed = undefined;
  clear();
}

function selection(signal: AbortSignal): Selection {
  if (!selected || selected.expires <= Date.now() || selected.signal.aborted || selected.signal !== signal) {
    clear();
    throw new Refusal("Select a window and grant inspection again.");
  }
  return selected;
}

async function exclusively<T>(task: () => Promise<T>) {
  if (busy) throw new Refusal("Wait for the current Windows accessibility operation to finish.");
  busy = true;
  try { return await task(); }
  finally { busy = false; }
}

async function inspect(current: Selection, signal: AbortSignal): Promise<WindowInspection> {
  review = undefined;
  const generation = proof;
  const view = await adapter.inspect(current.window, signal);
  if (proof !== generation || selection(signal) !== current) throw new Refusal("The window selection is no longer active.");
  const controls: AccessibleControl[] = [];
  current.controls.clear();
  for (const control of view.controls.slice(0, 240)) {
    const id = randomUUID();
    current.controls.set(id, control);
    controls.push({ id, name: control.name, role: control.role, depth: control.depth, actions: control.actions });
  }
  return { title: current.window.title, app: current.window.app, controls, truncated: view.truncated, expires: current.expires };
}

commands({
  window_automation_status: () => ({ available: available() }),
  window_automation_list: (_, ctx) => exclusively(async () => {
    requireAccess();
    const generation = proof;
    const found = await adapter.list(ctx.signal);
    if (proof !== generation) throw new Refusal("The operation was cancelled.");
    const candidates = new Map<string, NativeWindow>();
    const windows: AccessibleWindow[] = [];
    for (const window of found.slice(0, 40)) {
      const id = randomUUID();
      candidates.set(id, window);
      windows.push({ id, title: window.title, app: window.app });
    }
    listed = { candidates, expires: Date.now() + lifetime, signal: ctx.signal };
    return windows;
  }),
  window_automation_inspect: ({ id }: { id: unknown }, ctx) => exclusively(async () => {
    requireAccess();
    const window = listed?.signal === ctx.signal && listed.expires > Date.now() && typeof id === "string" ? listed.candidates.get(id) : undefined;
    if (!window) throw new Refusal("Refresh the window list and select a window.");
    clear();
    selected = { window, expires: Date.now() + lifetime, controls: new Map(), signal: ctx.signal };
    ctx.signal.addEventListener("abort", clear, { once: true });
    try { return await inspect(selected, ctx.signal); }
    catch (error) { clear(); throw error; }
  }),
  window_automation_refresh: (_, ctx) => exclusively(async () => {
    requireAccess();
    return inspect(selection(ctx.signal), ctx.signal);
  }),
  window_automation_close: () => clear(),
  window_automation_review: ({ id, action, value }: { id: unknown; action: unknown; value?: unknown }, ctx) => {
    requireAccess();
    const current = selection(ctx.signal);
    const control = typeof id === "string" ? current.controls.get(id) : undefined;
    if (busy || !control || !actions.includes(action as WindowAction) || !control.actions.includes(action as WindowAction))
      throw new Refusal("Inspect an eligible control in the selected window first.");
    if (action === "set-value" && (typeof value !== "string" || value.length > 500 || /[\x00-\x1f]/.test(value)))
      throw new Refusal("Enter up to 500 characters of plain text.");
    const input = action === "set-value" ? value as string : undefined;
    review = { id: randomUUID(), selection: current, control, action: action as WindowAction, value: input, expires: Date.now() + 60_000 };
    return { id: review.id, title: current.window.title, name: control.name, role: control.role, action: review.action, value: input };
  },
  window_automation_cancel: ({ id }: { id: unknown }) => { if (review?.id === id) review = undefined; },
  window_automation_apply: ({ id }: { id: unknown }, ctx) => exclusively(async () => {
    authorizeIntegration("execute", "user", available());
    const confirmed = review;
    review = undefined;
    if (!confirmed || confirmed.id !== id || confirmed.expires <= Date.now() || selection(ctx.signal) !== confirmed.selection)
      throw new Refusal("Review the control action again before applying it.");
    try {
      await adapter.apply({ kind: "apply", window: confirmed.selection.window, control: confirmed.control, action: confirmed.action, value: confirmed.value }, ctx.signal);
    } finally {
      // The action may have changed this window or opened another one.
      confirmed.selection.controls.clear();
    }
  }),
});
