import { useState } from "react";
import { SPEECH_LANGUAGES, type SpeechStatus } from "#shared/speech";
import { cleanMessage, FieldError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Channel, invoke } from "@/lib/core";
import { platform } from "@/lib/platform";
import { useQuery } from "@/lib/query";
import { ConfirmDialog, EmptyRow, Row, SettingsGroup } from "@/features/settings/ui";
import { SmallSelect } from "@/features/settings/life/shared";
import { SPEECH_STATUS, speechStatus } from "./api";

export function SpeechSetup() {
  const state = useQuery(SPEECH_STATUS, speechStatus);
  const [review, setReview] = useState<{ token: string; path: string } | null>(null);
  const [pending, setPending] = useState<"engine" | "download" | "language" | "clear" | null>(null);
  const [progress, setProgress] = useState(0);
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: typeof pending, task: () => Promise<void>) => {
    setPending(action);
    setError(null);
    try { await task(); } catch (e) { setError(cleanMessage(e)); }
    finally { setPending(null); }
  };
  const choose = () => run("engine", async () => setReview(await invoke<typeof review>("speech_choose_engine")));
  const approve = () => run("engine", async () => {
    if (!review) return;
    setReview(null);
    state.setData(await invoke<SpeechStatus>("speech_register_engine", { token: review.token }));
  });
  const install = () => run("download", async () => {
    setProgress(0);
    const listener = new Channel<number>(setProgress);
    try { state.setData(await invoke<SpeechStatus>("speech_install_model", { onProgress: listener })); }
    finally { listener.close(); }
  });
  const view = state.data;
  const downloaded = view ? Math.min(100, Math.floor(progress * 100 / view.modelBytes)) : 0;
  const os = platform();
  return (
    <>
      <SettingsGroup label="Voice input" note="Local transcription uses your CPU and keeps audio on this device.">
        {view?.desktop ? (
          <>
            <Row label="whisper.cpp engine" description={view.engine ? <span className="break-all">{view.engine}</span> : (
              <span>Choose an executable from the <a className="text-primary underline underline-offset-2" href="https://github.com/ggml-org/whisper.cpp/releases" target="_blank" rel="noreferrer">official whisper.cpp builds</a> or a local build.</span>
            )}>
              <Button size="xs" variant="outline" disabled={pending !== null} onClick={() => void choose()}>{view.engine ? "Change engine" : "Choose engine"}</Button>
            </Row>
            <Row label={view.model} description={view.modelInstalled ? "Installed on this device" : `${(view.modelBytes / 1_000_000).toFixed(1)} MB download from Hugging Face`}>
              {pending === "download" ? (
                <>
                  <progress max={100} value={downloaded} aria-label="Speech model download" className="w-20" />
                  <Button size="xs" variant="outline" onClick={() => void invoke("speech_cancel_download")}>Cancel</Button>
                </>
              ) : <Button size="xs" variant="outline" disabled={pending !== null} onClick={() => void install()}>{view.modelInstalled ? "Download again" : "Download model"}</Button>}
            </Row>
            <Row label="Spoken language">
              <SmallSelect value={view.language} label="Spoken language" options={SPEECH_LANGUAGES.map(([value, label]) => ({ value, label }))} disabled={pending !== null}
                onChange={(language) => void run("language", async () => state.setData(await invoke<SpeechStatus>("speech_set_language", { language })))} />
            </Row>
            <Row label={view.ready ? "Ready to record" : "Setup required"} description={view.reason}>
              {view.engine || view.modelInstalled ? <Button size="xs" variant="ghost-muted" disabled={pending !== null} onClick={() => setRemove(true)}>Remove setup</Button> : null}
            </Row>
          </>
        ) : <EmptyRow>{view?.reason ?? (state.error ? "Couldn’t load voice settings." : "Checking voice input…")}</EmptyRow>}
        {os === "win32" ? <Row label="Windows voice typing" description="Focus the message box and press Win+H to use Windows’ speech service." /> : null}
        {os === "darwin" ? <Row label="Mac dictation" description="Use the Dictation shortcut configured in macOS while the message box has focus." /> : null}
        {error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
      </SettingsGroup>
      <Dialog open={review !== null} onOpenChange={(open) => { if (!open) setReview(null); }}>
        <DialogPopup>
          <DialogHeader><DialogTitle>Use this speech engine?</DialogTitle></DialogHeader>
          <DialogPanel className="space-y-3 text-sm">
            <p className="break-all">{review?.path}</p>
            <p>Phaethon will run this program to transcribe audio. Choose an executable you trust.</p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setReview(null)}>Cancel</Button>
            <Button size="sm" onClick={() => void approve()}>Use engine</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <ConfirmDialog open={remove} onOpenChange={setRemove} title="Remove local speech setup?" confirm="Remove" destructive
        onConfirm={() => void run("clear", async () => state.setData(await invoke<SpeechStatus>("speech_clear_setup")))}>
        <p>This deletes the downloaded speech model and disconnects the executable.</p>
      </ConfirmDialog>
    </>
  );
}
