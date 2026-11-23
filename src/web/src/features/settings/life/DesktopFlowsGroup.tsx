import { useState } from "react";
import type { DesktopFlow } from "#shared/workflows";
import { cleanMessage, FieldError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { invoke } from "@/lib/core";
import { ConfirmDialog, EmptyRow, Loader, Row, SettingsGroup, useLoad } from "../ui";

const loadFlows = () => invoke<{ available: boolean; flows: DesktopFlow[] }>("desktop_flows_get");

export function DesktopFlowsGroup() {
  const state = useLoad(loadFlows, [], "workflows:desktop-flows");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [confirm, setConfirm] = useState<{ flow: DesktopFlow; action: "open" | "remove" } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (work: () => Promise<unknown>) => {
    setError(null);
    setPending(true);
    try {
      await work();
      setAdding(false);
      await state.reload();
    } catch (reason) { setError(cleanMessage(reason)); }
    finally { setPending(false); }
  };

  return (
    <>
      <SettingsGroup label="Power Automate for desktop" action={
        <>
          <Button size="xs" variant="ghost-muted" disabled={pending} onClick={() => void state.reload()}>Refresh</Button>
          {state.data?.available ? <Button size="xs" variant="outline" disabled={pending} onClick={() => { setName(""); setUrl(""); setError(null); setAdding(true); }}>Register flow</Button> : null}
        </>
      }>
        <Loader state={state} errorTitle="Couldn’t load desktop flows">
          {(view) => (
            <>
              {view.available && !view.flows.length ? <EmptyRow>Register a flow using the run URL in Power Automate’s flow properties.</EmptyRow> : null}
              {!view.available ? <EmptyRow>Install and sign in to Power Automate for desktop to use desktop flows.</EmptyRow> : null}
              {view.flows.map((flow) => (
                <Row key={flow.id} label={flow.name} description={flow.lastRequest ? `Launch requested ${new Date(flow.lastRequest.at).toLocaleString()}. Check status in Power Automate.` : undefined}>
                  <Button size="xs" variant="outline" disabled={pending || !view.available} onClick={() => setConfirm({ flow, action: "open" })}>Open flow</Button>
                  <Button size="xs" variant="ghost-muted" disabled={pending} onClick={() => setConfirm({ flow, action: "remove" })}>Remove</Button>
                </Row>
              ))}
              {!adding && error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
            </>
          )}
        </Loader>
      </SettingsGroup>
      <Dialog open={adding} onOpenChange={(open) => { if (!pending) setAdding(open); }}>
        <DialogPopup>
          <DialogHeader><DialogTitle>Register a desktop flow</DialogTitle></DialogHeader>
          <DialogPanel className="space-y-3">
            <Label htmlFor="desktop-flow-name">Name</Label>
            <Input id="desktop-flow-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            <Label htmlFor="desktop-flow-url">Run URL from Power Automate</Label>
            <Input id="desktop-flow-url" value={url} maxLength={512} onChange={(event) => setUrl(event.target.value)} />
            <FieldError>{error}</FieldError>
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" pending={pending} disabled={!name.trim() || !url.trim()} onClick={() => void change(() => invoke("desktop_flow_register", { name, url }))}>Register</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <ConfirmDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }} title={`${confirm?.action === "remove" ? "Remove" : "Open"} ${confirm?.flow.name ?? "flow"}?`}
        confirm={confirm?.action === "remove" ? "Remove" : "Open in Power Automate"} destructive={confirm?.action === "remove"}
        onConfirm={() => {
          if (!confirm) return;
          const { action, flow } = confirm;
          setConfirm(null);
          void change(() => invoke(action === "remove" ? "desktop_flow_remove" : "desktop_flow_launch", { id: flow.id }));
        }}>
        <p>{confirm?.action === "remove" ? "This removes the registration from Phaethon. The flow stays in Power Automate." : "Power Automate handles any sign-in, input prompts, and confirmation. Check its console for the run result."}</p>
      </ConfirmDialog>
    </>
  );
}
