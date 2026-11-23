import type { SpeechStatus } from "#shared/speech";
import { invoke } from "@/lib/core";

export const SPEECH_STATUS = "speech:status";
export const speechStatus = () => invoke<SpeechStatus>("speech_status");
