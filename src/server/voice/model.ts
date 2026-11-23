import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appDataDir } from "../env.ts";
import { Refusal } from "../rpc/registry.ts";

export const speechModel = {
  filename: "ggml-tiny-q5_1.bin",
  name: "Whisper Tiny multilingual",
  bytes: 32_152_673,
  sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
};

const source = "https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-tiny-q5_1.bin";
const hosts = new Set(["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co", "eu.aws.cdn.hf.co"]);
export const speechModelPath = () => path.join(appDataDir(), "speech", speechModel.filename);

async function modelStream(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  let url = new URL(source);
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== "https:" || url.port || !hosts.has(url.hostname) || url.username || url.password) break;
    let response: Response;
    try { response = await fetch(url, { signal, redirect: "manual" }); }
    catch { throw new Refusal("Couldn’t download the speech model. Check your internet connection."); }
    if (response.status === 200 && response.body) return response.body;
    await response.body?.cancel().catch(() => {});
    const next = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !next) break;
    url = new URL(next, url);
  }
  throw new Refusal("The model host returned an unexpected download response.");
}

export async function installSpeechModel(signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  const file = speechModelPath();
  await installVerifiedFile(file, await modelStream(signal), speechModel, signal, progress);
}

/** Stream under a strict size cap and rename only after verification. */
export async function installVerifiedFile(file: string, stream: ReadableStream<Uint8Array>, expected: { bytes: number; sha256: string }, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  const partial = `${file}.${randomUUID()}.download`;
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const hash = createHash("sha256");
  let bytes = 0;
  let lastProgress = 0;
  try {
    signal.throwIfAborted();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await fs.open(partial, "wx", 0o600);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        bytes += value.length;
        if (bytes > expected.bytes) throw new Refusal("The model download exceeded its verified size.");
        hash.update(value);
        if ((await handle.write(value)).bytesWritten !== value.length) throw new Refusal("Couldn’t save the model on this device.");
        if (bytes - lastProgress >= 256 * 1024) {
          progress(bytes);
          lastProgress = bytes;
        }
      }
      if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new Refusal("The speech model failed its integrity check.");
      await handle.sync();
    } finally { await handle.close(); }
    signal.throwIfAborted();
    await fs.rename(partial, file);
    progress(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    await fs.rm(partial, { force: true }).catch(() => {});
  }
}
