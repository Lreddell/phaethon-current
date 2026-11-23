import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SPEECH_SAMPLE_RATE, SPEECH_WAV_BYTES, isSpeechLanguage, type SpeechLanguage, type SpeechStatus } from "../../shared/speech.ts";
import { fileStamp, prettyJson, readJson, realpath, writeFileAtomic } from "../core/fsx.ts";
import { appDataDir } from "../env.ts";
import { host } from "../host.ts";
import { authorizeIntegration } from "../integrations/policy.ts";
import { nativeEnvironment, runNative } from "../integrations/native-process.ts";
import { Providers } from "../integrations/registry.ts";
import { commands, Refusal, type Channel } from "../rpc/registry.ts";
import { installSpeechModel, speechModel, speechModelPath } from "./model.ts";

type Engine = { path: string; stamp: string };
type Settings = { version: 1; engine?: Engine; language: SpeechLanguage };
type Capture = { id: string; abort: AbortController; stage: "capture" | "transcribing"; timer?: NodeJS.Timeout };

function settingsFile(): string { return path.join(appDataDir(), "speech", "settings.json"); }
function settings(): Settings {
  const stored = readJson<Settings>(settingsFile(), { version: 1, language: "auto" });
  if (stored?.version !== 1) throw new Refusal("The local speech settings couldn’t be read.");
  return { ...stored, language: isSpeechLanguage(stored.language) ? stored.language : "auto" };
}
function save(settings: Settings): void {
  writeFileAtomic(settingsFile(), prettyJson(settings) + "\n", { mode: 0o600 });
}

let selection: { token: string; engine: Engine; deadline: number } | undefined;
let download: AbortController | undefined;
let capture: Capture | undefined;
let verifiedModel: { file: string; stamp: string } | undefined;

function candidate(file: string): Engine {
  const full = realpath(file);
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const st = fs.statSync(full, { bigint: true });
  if (path.basename(full).toLowerCase() !== name || !st.isFile() || (process.platform !== "win32" && !(st.mode & 0o111n)))
    throw new Refusal(`Choose the ${name} executable from a trusted whisper.cpp installation.`);
  if (process.platform === "win32" && !/^[A-Z]:\\/i.test(full)) throw new Refusal("Choose a local whisper.cpp executable.");
  return { path: full, stamp: fileStamp(st) };
}

function engineIsCurrent(engine: Engine | undefined): engine is Engine {
  try { return !!engine && candidate(engine.path).stamp === engine.stamp; }
  catch { return false; }
}

async function verifyModel(file: string, signal: AbortSignal): Promise<void> {
  try {
    const stat = await fsp.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(speechModel.bytes)) throw new Error();
    const stamp = fileStamp(stat);
    if (verifiedModel?.file === file && verifiedModel.stamp === stamp) return;
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== speechModel.sha256 || stamp !== fileStamp(await fsp.lstat(file, { bigint: true }))) throw new Error();
    verifiedModel = { file, stamp };
  } catch {
    signal.throwIfAborted();
    throw new Refusal("Install the verified speech model again in Settings › General.");
  }
}

export function decodeSpeechWav(raw: unknown): Buffer {
  if (typeof raw !== "string" || raw.length > Math.ceil(SPEECH_WAV_BYTES / 3) * 4 || raw.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
    throw new Refusal("The recording is invalid or too long.");
  const buf = Buffer.from(raw, "base64");
  if (buf.length <= 44 || buf.length > SPEECH_WAV_BYTES || buf.length % 2 || buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.readUInt32LE(4) !== buf.length - 8 || buf.toString("ascii", 8, 16) !== "WAVEfmt " || buf.readUInt32LE(16) !== 16 ||
      buf.readUInt16LE(20) !== 1 || buf.readUInt16LE(22) !== 1 || buf.readUInt32LE(24) !== SPEECH_SAMPLE_RATE ||
      buf.readUInt32LE(28) !== SPEECH_SAMPLE_RATE * 2 || buf.readUInt16LE(32) !== 2 || buf.readUInt16LE(34) !== 16 ||
      buf.toString("ascii", 36, 40) !== "data" || buf.readUInt32LE(40) !== buf.length - 44)
    throw new Refusal("The recording isn’t 16 kHz mono PCM audio.");
  return buf;
}

interface SpeechRecognitionProvider {
  probe(engine: Engine, signal: AbortSignal): Promise<void>;
  transcribe(engine: Engine, model: string, audio: Buffer, language: SpeechLanguage, signal: AbortSignal): Promise<string>;
}

const providers = new Providers<"whisper.cpp", SpeechRecognitionProvider>().register("whisper.cpp", () => ({
  async probe(engine, signal) {
    const output = await runNative(engine.path, ["--help"], "", signal, { cwd: path.dirname(engine.path), env: nativeEnvironment(), includeStderr: true });
    if (!["--model", "--file", "--language", "--no-gpu", "--output-txt", "--output-file"].every((flag) => output.includes(flag))) throw new Error("unsupported runtime");
  },
  async transcribe(engine, model, audio, language, signal) {
    const dir = await fsp.mkdtemp(path.join(tmpdir(), "phaethon-speech-"));
    try {
      const input = path.join(dir, "speech.wav");
      const output = path.join(dir, "transcript");
      await fsp.writeFile(input, audio, { mode: 0o600, flag: "wx", signal });
      await runNative(engine.path, ["--model", model, "--file", input, "--language", language, "--no-gpu", "--no-timestamps", "--output-txt", "--output-file", output],
        "", signal, { cwd: path.dirname(engine.path), env: nativeEnvironment() });
      const file = `${output}.txt`;
      if ((await fsp.stat(file)).size > 100_000) throw new Refusal("The transcription was too long to insert.");
      return (await fsp.readFile(file, "utf8")).trim();
    } finally { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {}); }
  },
}));
const provider = () => providers.get("whisper.cpp");

async function status(): Promise<SpeechStatus> {
  const { engine, language } = settings();
  const modelInstalled = await verifyModel(speechModelPath(), AbortSignal.timeout(7000)).then(() => true, () => false);
  const desktop = host().available;
  const reason = !desktop ? "Local microphone capture is available in the Phaethon desktop app."
    : !engine ? "Choose a whisper.cpp executable in Settings › General."
    : !engineIsCurrent(engine) ? "The speech engine changed or moved. Review and choose it again."
    : !modelInstalled ? "Download the speech model in Settings › General." : undefined;
  return { desktop, engine: engine?.path ?? null, model: speechModel.name, modelBytes: speechModel.bytes, modelInstalled, language, ready: !reason, reason };
}

async function finish(current: Capture): Promise<void> {
  if (capture === current) capture = undefined;
  clearTimeout(current.timer);
  current.abort.abort();
  await host().call({ op: "microphoneRelease", id: current.id }).catch(() => {});
}

commands({
  speech_status: status,
  speech_choose_engine: async (_, ctx) => {
    authorizeIntegration("modify", "user", host().available);
    const paths = await host().call<string[] | null>({ op: "pickFiles", title: "Choose the whisper.cpp executable", multiple: false,
      ...(process.platform === "win32" ? { filters: [{ name: "whisper-cli", extensions: ["exe"] }] } : {}) });
    ctx.signal.throwIfAborted();
    if (!paths?.[0]) return null;
    const engine = candidate(paths[0]);
    const token = randomUUID();
    selection = { token, engine, deadline: Date.now() + 300_000 };
    return { token, path: engine.path };
  },
  speech_register_engine: async ({ token }: { token: unknown }, ctx) => {
    authorizeIntegration("modify", "user", host().available && !capture);
    if (!selection || selection.token !== token || selection.deadline < Date.now() || !engineIsCurrent(selection.engine)) throw new Refusal("Choose the speech engine again before connecting it.");
    const { engine } = selection;
    selection = undefined;
    try { await provider().probe(engine, AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)])); }
    catch { throw new Refusal("The executable couldn’t run as a supported whisper.cpp CLI. Keep the program and its libraries together."); }
    ctx.signal.throwIfAborted();
    if (!engineIsCurrent(engine)) throw new Refusal("The speech engine changed while it was being checked.");
    save({ ...settings(), engine });
    return status();
  },
  speech_set_language: ({ language }: { language: unknown }) => {
    authorizeIntegration("modify", "user", host().available);
    if (!isSpeechLanguage(language)) throw new Refusal("Choose a supported speech language.");
    save({ ...settings(), language });
    return status();
  },
  speech_install_model: async ({ onProgress }: { onProgress?: Channel<number> }, ctx) => {
    authorizeIntegration("modify", "user", host().available && !capture);
    if (download) throw new Refusal("A speech model download is already running.");
    const abort = new AbortController();
    download = abort;
    const signal = AbortSignal.any([abort.signal, ctx.signal, AbortSignal.timeout(300_000)]);
    try { await installSpeechModel(signal, (bytes) => onProgress?.send(bytes)); }
    catch (error) {
      if (signal.aborted) throw new Refusal("The speech model download was cancelled or timed out.");
      if (error instanceof Refusal) throw error;
      throw new Refusal("The speech model couldn’t be saved.");
    } finally { download = undefined; }
    return status();
  },
  speech_cancel_download: () => { download?.abort(); },
  speech_clear_setup: async () => {
    authorizeIntegration("delete", "user", host().available && !download && !capture);
    await fsp.rm(speechModelPath(), { force: true });
    verifiedModel = undefined;
    save({ version: 1, language: settings().language });
    return status();
  },
  speech_prepare: async (_, ctx) => {
    authorizeIntegration("execute", "user", host().available && !capture && !download);
    const view = await status();
    if (!view.ready) throw new Refusal(view.reason ?? "Local speech is unavailable.");
    authorizeIntegration("execute", "user", !capture && !download);
    const current: Capture = { id: randomUUID(), abort: new AbortController(), stage: "capture" };
    capture = current;
    current.timer = setTimeout(() => void finish(current), 110_000);
    current.timer.unref?.();
    try {
      ctx.signal.throwIfAborted();
      await host().call({ op: "microphoneGrant", id: current.id });
      ctx.signal.throwIfAborted();
      return { id: current.id };
    } catch (error) {
      await finish(current);
      if (error instanceof Refusal) throw error;
      throw new Refusal("Couldn’t start microphone capture.");
    }
  },
  speech_cancel: async ({ id }: { id: unknown }) => { if (capture && capture.id === id) await finish(capture); },
  speech_microphone_acquired: async ({ id }: { id: unknown }) => {
    if (capture?.id === id && capture?.stage === "capture") await host().call({ op: "microphoneRelease", id: capture.id });
  },
  speech_transcribe: async ({ id, wav }: { id: unknown; wav: unknown }, ctx) => {
    const current = capture;
    if (!current || current.id !== id || current.stage !== "capture") throw new Refusal("Start a new recording to transcribe audio.");
    current.stage = "transcribing";
    clearTimeout(current.timer);
    const signal = AbortSignal.any([current.abort.signal, ctx.signal, AbortSignal.timeout(180_000)]);
    try {
      await host().call({ op: "microphoneRelease", id });
      const bytes = decodeSpeechWav(wav);
      const { engine, language } = settings();
      if (!engineIsCurrent(engine)) throw new Refusal("The speech engine changed or moved. Choose it again in Settings › General.");
      const model = speechModelPath();
      await verifyModel(model, signal);
      return { text: await provider().transcribe(engine, model, bytes, language, signal) };
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal(signal.aborted ? "The transcription was cancelled or timed out." : "Whisper couldn’t transcribe the recording. Check the speech engine and model.");
    } finally { await finish(current); }
  },
});
