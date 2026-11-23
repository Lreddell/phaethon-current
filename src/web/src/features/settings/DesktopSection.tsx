import { useState } from "react";
import type { ExplorerSelection, ExplorerStatus } from "#shared/explorer";
import { useNav } from "@/app/store";
import { FieldError, cleanMessage } from "@/components/errors";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/features/chat/lib/attachments";
import { invoke } from "@/lib/core";
import { SmallSelect } from "./life/shared";
import { EmptyRow, Loader, Row, SettingsGroup, useLoad } from "./ui";
import { WindowAutomation } from "./WindowAutomation";

const linkStatus = () => invoke<ExplorerStatus>("explorer_status");
const incomingFiles = () => invoke<ExplorerSelection | null>("explorer_pending");

function ReviewFiles({ selection, clear }: { selection: ExplorerSelection; clear: () => Promise<void> }) {
  const spaces = useNav((state) => state.spaces.data);
  const [space, setSpace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (importFiles: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (importFiles) {
        const result = await invoke<{ files: number }>("explorer_import", { id: selection.id, space });
        toast.success(result.files === 1 ? "File imported" : `${result.files} files imported`);
        await clear();
        useNav.getState().selectSpace(space, "files");
      } else {
        await invoke("explorer_dismiss", { id: selection.id });
        await clear();
      }
    } catch (reason) { setError(cleanMessage(reason)); }
    finally { setBusy(false); }
  };

  return (
    <SettingsGroup label="Review files from File Explorer" note="Phaethon will copy these files into the selected Space’s Files folder.">
      {selection.reason ? <EmptyRow>{selection.reason}</EmptyRow> : null}
      {selection.files.map((file, index) => <Row key={index} label={file.name} description={formatBytes(file.size)} />)}
      {selection.skipped ? <EmptyRow>{selection.skipped} selection{selection.skipped === 1 ? " was" : "s were"} skipped. Choose up to 20 regular local files with a combined size under 256 MB.</EmptyRow> : null}
      {selection.files.length ? <Row label="Destination Space">
        <SmallSelect label="Destination Space" value={space} disabled={busy} options={[
          { label: "Choose Space", value: "" }, ...(spaces ?? []).map((item) => ({ label: item.name, value: item.id })),
        ]} onChange={setSpace} />
      </Row> : null}
      {error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
      <Row label="Import">
        <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => void finish(false)}>Dismiss</Button>
        {selection.files.length ? <Button size="xs" disabled={busy || !space} onClick={() => void finish(true)}>Copy files to Space</Button> : null}
      </Row>
    </SettingsGroup>
  );
}

export function DesktopSection() {
  const status = useLoad(linkStatus, [], "explorer:status");
  const selection = useLoad(incomingFiles, [], "explorer:pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      status.setData(await invoke<ExplorerStatus>("explorer_set", { enabled }));
      await selection.reload();
    } catch (reason) { setError(cleanMessage(reason)); }
    finally { setBusy(false); }
  };

  return <>
    {selection.data ? <ReviewFiles key={selection.data.id} selection={selection.data} clear={selection.reload} /> : null}
    <SettingsGroup label="File Explorer">
      <Loader state={status} errorTitle="Couldn’t check File Explorer integration">
        {(value) => value.state === "unsupported" ? <EmptyRow>The Send to shortcut is available in the packaged Windows desktop app.</EmptyRow>
          : <Row label="Send to Phaethon" description={value.reason ?? "Add a shortcut under Send to in File Explorer. Choose files there, then review the destination in Phaethon."}>
            {value.state === "repair" ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void change(true)}>Repair</Button> : null}
            <Button size="xs" variant="outline" pending={busy} onClick={() => void change(value.state !== "active" && value.state !== "repair")}>
              {value.state === "active" || value.state === "repair" ? "Remove shortcut" : "Add shortcut"}
            </Button>
          </Row>}
      </Loader>
      {error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
    </SettingsGroup>
    <WindowAutomation />
  </>;
}
