export const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_MAX_SECONDS = 60;
export const SPEECH_WAV_BYTES = 44 + SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS * 2;

export const SPEECH_LANGUAGES = [
  ["auto", "Detect automatically"], ["en", "English"], ["es", "Spanish"], ["fr", "French"],
  ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ja", "Japanese"],
  ["zh", "Chinese"], ["ko", "Korean"], ["ar", "Arabic"], ["hi", "Hindi"],
] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number][0];
export const isSpeechLanguage = (value: unknown): value is SpeechLanguage => SPEECH_LANGUAGES.some(([id]) => id === value);

export type SpeechStatus = {
  desktop: boolean;
  engine: string | null;
  model: string;
  modelBytes: number;
  modelInstalled: boolean;
  language: SpeechLanguage;
  ready: boolean;
  reason?: string;
};
