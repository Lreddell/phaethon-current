import { useEffect, useState } from "react";
import type { AccessibleWindow, WindowAction, WindowInspection } from "#shared/window-automation";
import { FieldError, cleanMessage } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { invoke } from "@/lib/core";
import { SmallSelect } from "./life/shared";
import { EmptyRow, Loader, Row, SettingsGroup, useLoad } from "./ui";

const ACTIONS: Record<WindowAction, string> = { invoke: "Activate", "set-value": "Set text", "scroll-up": "Scroll up", "scroll-down": "Scroll down" };
const QUESTIONS: Record<WindowAction, string> = {
  invoke: "Activate this control?", "set-value": "Change this control’s text?",
  "scroll-up": "Scroll up in this control?", "scroll-down": "Scroll down in this control?",
};
type Confirmation = { id: string; title: string; name: string; role: string; action: WindowAction; value?: string };

export function WindowAutomation() {
  const status = useLoad(() => invoke<{ available: boolean }>("window_automation_status"), [], "win-uia:status");
  const [windows, setWindows] = useState<AccessibleWindow[] | null>(null);
  const [wanted, setWanted] = useState("");
  const [inspection, setInspection] = useState<WindowInspection | null>(null);
  const [filter, setFilter] = useState("");
  const [controlId, setControlId] = useState("");
  const [text, setText] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const control = inspection?.controls.find((item) => item.id === controlId);
  const query = filter.trim().toLowerCase();
  const matches = inspection?.controls.filter((item) => `${item.name} ${item.role}`.toLowerCase().includes(query)) ?? [];

  useEffect(() => () => { void invoke("window_automation_close").catch(() => {}); }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await work(); }
    catch (reason) { setError(cleanMessage(reason)); }
    finally { setBusy(false); }
  };
  const inspect = (refresh: boolean) => run(async () => {
    setControlId("");
    setText("");
    setInspection(await invoke<WindowInspection>(refresh ? "window_automation_refresh" : "window_automation_inspect", refresh ? {} : { id: wanted }));
  });
  const dismiss = () => {
    if (confirmation) void invoke("window_automation_cancel", { id: confirmation.id }).catch(() => {});
    setConfirmation(null);
  };

  return (
    <>
      <SettingsGroup label="Windows accessibility">
        <Loader state={status} errorTitle="Couldn’t check Windows UI Automation">
          {(value) => value.available ? <>
            <Row label="Inspect an open window" description="Choose one window you want to inspect. Windows must be unlocked. Controls in elevated apps, sign-in windows, and password fields are excluded.">
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(async () => {
                setWanted("");
                setWindows(await invoke<AccessibleWindow[]>("window_automation_list"));
              })}>List open windows</Button>
            </Row>
            {windows?.length ? <Row label="Window">
              <SmallSelect value={wanted} label="Window to inspect" disabled={busy} className="w-64"
                options={[{ label: "Choose window", value: "" }, ...windows.map((item) => ({ label: `${item.title} · ${item.app}`, value: item.id }))]} onChange={setWanted} />
              <Button size="xs" variant="outline" disabled={busy || !wanted} onClick={() => void inspect(false)}>Inspect this window</Button>
            </Row> : windows ? <EmptyRow>No supported open windows were found.</EmptyRow> : null}
            {error && !inspection ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
          </> : <EmptyRow>Window inspection and control actions require the Phaethon desktop app on Windows.</EmptyRow>}
        </Loader>
      </SettingsGroup>
      {inspection ? <SettingsGroup label={inspection.title} note={inspection.truncated ? "Part of this window’s accessibility tree is shown." : undefined}>
        <Row label="Find accessible controls" description={inspection.app}>
          <Input size="sm" aria-label="Find accessible controls" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void inspect(true)}>Refresh</Button>
          <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => void run(async () => {
            await invoke("window_automation_close");
            setInspection(null);
            setControlId("");
            setText("");
          })}>End access</Button>
        </Row>
        {matches.length ? <ul className="max-h-52 overflow-auto px-2 py-1" aria-label="Accessible controls">
          {matches.map((item) => <li key={item.id} className="flex items-center gap-2 px-2 py-1 text-sm">
            <span className="min-w-0 flex-1 break-words">{item.name || item.role} <span className="text-muted-foreground">· {item.role}</span></span>
            {item.actions.length ? <Button size="xs" aria-pressed={controlId === item.id} variant={controlId === item.id ? "outline" : "ghost-muted"}
              disabled={busy} onClick={() => { setControlId(item.id); setText(""); }}>Select control</Button> : null}
          </li>)}
        </ul> : !notice ? <EmptyRow>No matching accessible controls.</EmptyRow> : null}
        {control ? <Row label={control.name || control.role} description="Review an action before sending it to the selected window.">
          {control.actions.includes("set-value") ? <Input size="sm" aria-label="New control text" value={text} maxLength={500} onChange={(event) => setText(event.target.value)} /> : null}
          {control.actions.map((action) => <Button key={action} size="xs" variant="outline" disabled={busy}
            onClick={() => void run(async () => {
              setConfirmation(await invoke<Confirmation>("window_automation_review", { id: control.id, action, ...(action === "set-value" ? { value: text } : {}) }));
            })}>{ACTIONS[action]}</Button>)}
        </Row> : null}
        {notice ? <EmptyRow>{notice}</EmptyRow> : null}
        {error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
      </SettingsGroup> : null}
      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open) dismiss(); }}>
        <DialogPopup className="max-w-md">
          <DialogHeader><DialogTitle>{confirmation ? QUESTIONS[confirmation.action] : "Review control action"}</DialogTitle></DialogHeader>
          {confirmation ? <DialogPanel className="space-y-2 text-sm">
            <p>{confirmation.title}</p>
            <p>{confirmation.name || confirmation.role}</p>
            {confirmation.action === "set-value" ? <p className="break-words">{confirmation.value || "Clear the text"}</p> : null}
          </DialogPanel> : null}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={dismiss}>Cancel</Button>
            <Button size="sm" disabled={!confirmation || busy} onClick={() => {
              if (!confirmation) return;
              const { id } = confirmation;
              setConfirmation(null);
              setControlId("");
              setText("");
              void run(async () => {
                await invoke("window_automation_apply", { id });
                setInspection((value) => value ? { ...value, controls: [] } : value);
                setNotice("Action applied. Refresh to inspect the current controls.");
              });
            }}>Apply action</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
