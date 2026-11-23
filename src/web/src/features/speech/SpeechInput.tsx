import { useEffect, useRef, useState } from "react";
import { SPEECH_MAX_SECONDS } from "#shared/speech";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { toBase64 } from "@/features/chat/lib/attachments";
import { errorText, invoke } from "@/lib/core";
import { platform } from "@/lib/platform";
import { useQuery } from "@/lib/query";
import { SPEECH_STATUS, speechStatus } from "./api";
import { speechWav } from "./audio";

type Phase = "starting" | "recording" | "transcribing";
type Recording = { id?: string; stream?: MediaStream; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout>; cancelled: boolean };

function cancelRecording(run: Recording): void {
  run.cancelled = true;
  clearTimeout(run.timer);
  if (run.recorder?.state === "recording") run.recorder.stop();
  run.stream?.getTracks().forEach((track) => track.stop());
  if (run.id) void invoke("speech_cancel", { id: run.id }).catch(() => {});
}

function captureError(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return "Microphone access was denied. Check permissions for Phaethon and try again.";
    if (e.name === "NotFoundError") return "No microphone is available. Connect one and try again.";
    if (e.name === "NotReadableError") return "The microphone couldn’t be opened. Check whether another app is using it.";
  }
  return errorText(e);
}

export function SpeechInput({ disabled, onTranscript, focusComposer, openSetup }: {
  disabled: boolean;
  onTranscript: (text: string) => void;
  focusComposer: () => void;
  openSetup: () => void;
}) {
  const state = useQuery(window.phaethonDesktop ? SPEECH_STATUS : null, speechStatus);
  const [phase, setPhase] = useState<Phase | null>(null);
  const active = useRef<Recording | null>(null);
  const insert = useRef(onTranscript);
  insert.current = onTranscript;

  useEffect(() => () => { if (active.current) cancelRecording(active.current); }, []);
  useEffect(() => {
    if (disabled && active.current) {
      cancelRecording(active.current);
      active.current = null;
      setPhase(null);
    }
  }, [disabled]);

  const cancel = () => {
    if (active.current) cancelRecording(active.current);
    active.current = null;
    setPhase(null);
  };

  const stop = () => {
    const run = active.current;
    if (!run || run.recorder?.state !== "recording") return;
    clearTimeout(run.timer);
    setPhase("transcribing");
    run.recorder.stop();
    run.stream?.getTracks().forEach((track) => track.stop());
  };

  const start = async () => {
    if (active.current) return;
    const run: Recording = { cancelled: false };
    active.current = run;
    setPhase("starting");
    const fail = (e: unknown) => {
      if (run.cancelled) return;
      toast.error("Couldn’t use voice input", captureError(e));
      cancel();
    };
    try {
      if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") throw new Error("Microphone recording isn’t available in this window.");
      run.id = (await invoke<{ id: string }>("speech_prepare")).id;
      if (run.cancelled) { cancelRecording(run); return; }
      run.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (run.cancelled) { cancelRecording(run); return; }
      void invoke("speech_microphone_acquired", { id: run.id }).catch(() => {});
      const recorder = new MediaRecorder(run.stream);
      run.recorder = recorder;
      const blocks: Blob[] = [];
      recorder.addEventListener("dataavailable", (event) => { if (!run.cancelled && event.data.size) blocks.push(event.data); });
      recorder.addEventListener("error", () => fail(new Error("The microphone recording stopped unexpectedly.")), { once: true });
      recorder.addEventListener("stop", () => {
        if (run.cancelled || active.current !== run) return;
        void (async () => {
          clearTimeout(run.timer);
          setPhase("transcribing");
          run.stream?.getTracks().forEach((track) => track.stop());
          const file = await speechWav(new Blob(blocks, { type: recorder.mimeType }));
          if (run.cancelled) return;
          const wav = await toBase64(file);
          if (run.cancelled) return;
          const reply = await invoke<{ text: string }>("speech_transcribe", { id: run.id, wav });
          if (run.cancelled) return;
          if (reply.text) insert.current(reply.text);
          else toast.error("No speech was recognized", "Try again closer to the microphone.");
          active.current = null;
          setPhase(null);
        })().catch(fail);
      }, { once: true });
      recorder.start();
      setPhase("recording");
      run.timer = setTimeout(stop, SPEECH_MAX_SECONDS * 1000);
    } catch (e) { fail(e); }
  };

  if (!state.data?.desktop) return null;
  if (phase) return (
    <>
      {phase === "recording" ? <Button size="xs" variant="outline" onClick={stop}><Icon icon={icons.stop} />Stop recording</Button> : null}
      <span role="status" className="text-xs text-muted-foreground">{phase === "starting" ? "Opening microphone…" : phase === "recording" ? "Recording" : "Transcribing locally…"}</span>
      <Button size="xs" variant="ghost-muted" onClick={cancel}>Cancel</Button>
    </>
  );
  const mac = platform() === "darwin";
  const label = state.data.ready ? "Record voice for this message" : mac ? "Start Mac dictation" : "Set up voice input";
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={label} disabled={disabled} onClick={() => {
        if (state.data?.ready) void start();
        else if (mac) {
          focusComposer();
          void invoke("voice_dictation_start").catch((e) => toast.error("Couldn’t start dictation", errorText(e)));
        } else openSetup();
      }} />}><Icon icon={icons.mic} /></TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
