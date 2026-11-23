import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempHome, call } from "../../../tests/harness.ts";
import { SPEECH_SAMPLE_RATE } from "../../shared/speech.ts";
import { decodeSpeechWav } from "./local.ts";
import { installVerifiedFile } from "./model.ts";

const env = tempHome("phaethon-speech-tests-");
afterAll(() => env.cleanup());

function wavFixture(): Buffer {
  const header = Buffer.alloc(52);
  header.write("RIFF");
  header.writeUInt32LE(header.length - 8, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SPEECH_SAMPLE_RATE, 24);
  header.writeUInt32LE(SPEECH_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(8, 40);
  return header;
}

describe("local speech input", () => {
  it("shows setup and refuses microphone use without a desktop, consent and a verified provider", async () => {
    expect(await call("speech_status")).toMatchObject({ desktop: false, ready: false, modelInstalled: false });
    await expect(call("speech_prepare")).rejects.toThrow("isn’t permitted");
    await expect(call("speech_transcribe", { id: "unsolicited", wav: wavFixture().toString("base64") })).rejects.toThrow("Start a new recording");
  });

  it("accepts only a bounded mono PCM recording of the expected format", () => {
    const audio = wavFixture();
    expect(decodeSpeechWav(audio.toString("base64"))).toEqual(audio);
    expect(() => decodeSpeechWav("untrusted path.wav")).toThrow("invalid or too long");
    audio.writeUInt16LE(2, 22);
    expect(() => decodeSpeechWav(audio.toString("base64"))).toThrow("16 kHz mono PCM");
    expect(() => decodeSpeechWav(wavFixture().subarray(0, 44).toString("base64"))).toThrow("16 kHz mono PCM");
  });

  it("installs verified model weights atomically and keeps the previous file on verification failure", async () => {
    const target = path.join(env.home, "weights", "fixture.bin");
    const bytes = Buffer.from("verified sample");
    const expected = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const progress: number[] = [];
    await installVerifiedFile(target, new Blob([bytes]).stream(), expected, new AbortController().signal, (n) => progress.push(n));
    expect(fs.readFileSync(target)).toEqual(bytes);
    expect(progress.at(-1)).toBe(bytes.length);
    const corrupt = Buffer.from(bytes);
    corrupt[0] = 0;
    await expect(installVerifiedFile(target, new Blob([corrupt]).stream(), expected, new AbortController().signal, () => {})).rejects.toThrow("integrity check");
    await expect(installVerifiedFile(target, new Blob([bytes, bytes]).stream(), expected, new AbortController().signal, () => {})).rejects.toThrow("exceeded its verified size");
    expect(fs.readFileSync(target)).toEqual(bytes);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["fixture.bin"]);
  });

  it("cleans up a cancelled download", async () => {
    const target = path.join(env.home, "cancelled", "fixture.bin");
    const controller = new AbortController();
    const bytes = Buffer.alloc(256 * 1024);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await expect(installVerifiedFile(target, new Blob([bytes]).stream(), { bytes: bytes.length, sha256: hash }, controller.signal, () => controller.abort())).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });
});
