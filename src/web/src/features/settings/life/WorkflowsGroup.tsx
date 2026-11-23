import { useState } from "react";
import type { WorkflowRegistration, WorkflowRun, WorkflowSelection, WorkflowView } from "#shared/workflows";
import { cleanMessage, FieldError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { invoke } from "@/lib/core";
import { ConfirmDialog, EmptyRow, Loader, Row, SettingsGroup, useLoad } from "../ui";

const loadWorkflows = () => invoke<WorkflowView>("workflows_get");

export function WorkflowsGroup() {
  const state = useLoad(loadWorkflows, [], "workflows:list");
  const [candidate, setCandidate] = useState<WorkflowSelection | null>(null);
  const [review, setReview] = useState<WorkflowRegistration | null>(null);
  const [remove, setRemove] = useState<WorkflowRegistration | null>(null);
  const [input, setInput] = useState("{}");
  const [pending, setPending] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const action = async (work: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try { await work(); }
    catch (e) { setError(cleanMessage(e)); }
    finally { setPending(false); }
  };

  const pick = () => action(async () => setCandidate(await invoke<WorkflowSelection | null>("workflow_choose")));
  const approve = () => action(async () => {
    if (!candidate) return;
    await invoke("workflow_register", { token: candidate.token });
    setCandidate(null);
    await state.reload();
  });
  const run = () => action(async () => {
    if (!review) return;
    setOutput(null);
    const result = await invoke<{ run: WorkflowRun; output?: string; error?: string }>("workflow_run", { id: review.id, digest: review.digest, input });
    setOutput(result.output || (result.run.status === "completed" ? "Completed without output." : null));
    setError(result.error ?? null);
    await state.reload();
  });
  const cancel = async () => {
    try { await invoke("workflow_cancel", { id: review?.id }); }
    catch (e) { setError(cleanMessage(e)); }
  };

  return (
    <>
      <SettingsGroup label="Registered scripts" action={state.data?.canRegister ? <Button size="xs" variant="outline" disabled={pending} onClick={() => void pick()}>Choose script</Button> : null}>
        <Loader state={state} errorTitle="Couldn’t load registered scripts">
          {(view) => (
            <>
              {view.reason ? <EmptyRow>{view.reason}</EmptyRow> : null}
              {view.canRegister && !view.workflows.length ? <EmptyRow>Choose a {view.platform === "powershell" ? "PowerShell (.ps1)" : "shell (.sh)"} script to register it.</EmptyRow> : null}
              {view.workflows.map((workflow) => (
                <Row key={workflow.id} label={workflow.name} description={<span className="break-all">{workflow.path}</span>}>
                  <Button size="xs" variant="outline" disabled={pending || !view.canRegister} onClick={() => { setReview(workflow); setInput("{}"); setOutput(null); setError(null); }}>Review and run</Button>
                  <Button size="xs" variant="ghost-muted" disabled={pending} onClick={() => setRemove(workflow)}>Remove</Button>
                </Row>
              ))}
              {!review && !candidate && error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
            </>
          )}
        </Loader>
      </SettingsGroup>
      {state.data?.runs.length ? (
        <SettingsGroup label="Recent script runs">
          {state.data.runs.slice(0, 10).map((run) => (
            <Row key={run.id} label={run.name} description={new Date(run.started).toLocaleString()}>
              <span className="text-xs text-muted-foreground">{run.status.replace("-", " ")}</span>
            </Row>
          ))}
        </SettingsGroup>
      ) : null}
      <Dialog open={candidate !== null} onOpenChange={(open) => { if (!open && !pending) setCandidate(null); }}>
        <DialogPopup>
          <DialogHeader><DialogTitle>Register {candidate?.name}</DialogTitle></DialogHeader>
          <DialogPanel className="space-y-3 text-sm">
            <p className="break-all">{candidate?.path}</p>
            <p>Register a script you trust. When you run it, it has the same access to your computer as your user account.</p>
            <FieldError>{error}</FieldError>
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setCandidate(null)}>Cancel</Button>
            <Button size="sm" pending={pending} onClick={() => void approve()}>Register</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={review !== null} onOpenChange={(open) => { if (!open && !pending) setReview(null); }}>
        <DialogPopup>
          <DialogHeader><DialogTitle>Run {review?.name}</DialogTitle></DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="break-all text-sm text-muted-foreground">{review?.path}</p>
            <Label htmlFor="workflow-input">Inputs (JSON object)</Label>
            <Textarea id="workflow-input" value={input} rows={4} maxLength={32_768} disabled={pending} onChange={(e) => { setInput(e.target.value); setOutput(null); }} />
            <FieldError>{error}</FieldError>
            {output !== null ? <pre aria-live="polite" className="max-h-56 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{output}</pre> : null}
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => pending ? void cancel() : setReview(null)}>{pending ? "Cancel run" : "Close"}</Button>
            <Button size="sm" pending={pending} onClick={() => void run()}>Run script</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <ConfirmDialog open={remove !== null} onOpenChange={(open) => { if (!open) setRemove(null); }} title={`Remove ${remove?.name ?? "script"}?`} confirm="Remove" destructive
        onConfirm={() => void action(async () => { if (remove) await invoke("workflow_remove", { id: remove.id }); setRemove(null); await state.reload(); })}>
        <p>The script file stays on your computer.</p>
      </ConfirmDialog>
    </>
  );
}
