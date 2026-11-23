import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { fileStamp } from "../src/server/core/fsx.ts";

const engine = process.env.PHAETHON_TEST_WHISPER_EXE;
const model = process.env.PHAETHON_TEST_WHISPER_MODEL;
const audio = process.env.PHAETHON_TEST_WHISPER_AUDIO;

async function withDesktop(
  setup: (root: string) => void,
  check: (app: Awaited<ReturnType<typeof electron.launch>>) => Promise<void>,
  fixture?: string,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-speech-e2e-"));
  const root = path.resolve(import.meta.dirname, "..");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    fs.mkdirSync(path.join(home, "appdata"), { recursive: true });
    fs.writeFileSync(path.join(home, "appdata", "telemetry-consent.json"), JSON.stringify({ v: 1, configured: true, usage: false, diagnostics: false, reports: false, traces: false }));
    setup(home);
    app = await electron.launch({
      args: [...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []), root,
        `--user-data-dir=${path.join(home, "profile")}`, "--use-fake-device-for-media-stream", ...(fixture ? [`--use-file-for-fake-audio-capture=${fixture}`] : [])],
      env: { ...env, PHAETHON_TEST: "1", PHAETHON_HOME: home, PHAETHON_APP_DATA: path.join(home, "appdata"), PHAETHON_KEYRING: "memory",
        PHAETHON_CLAUDE_BIN: path.join(home, "no-claude"), PHAETHON_CODEX_BIN: path.join(home, "no-codex"), PHAETHON_GEMINI_BIN: path.join(home, "no-gemini") },
    });
    await check(app);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

test("the desktop app refuses microphone access before the composer approves capture", async () => {
  await withDesktop(() => {}, async (app) => {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Welcome to Phaethon" })).toBeVisible();
    const permission = await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        return "granted";
      } catch (error) { return (error as DOMException).name; }
    });
    expect(permission).toBe("NotAllowedError");
  });
});

test("a real whisper.cpp engine transcribes fixture audio into the editable composer", async () => {
  test.skip(!engine || !model || !audio, "Needs a local whisper.cpp executable, the verified model and a PCM speech fixture.");
  await withDesktop((home) => {
    const folder = path.join(home, "appdata", "speech");
    fs.mkdirSync(folder, { recursive: true });
    const real = fs.realpathSync.native(engine!);
    fs.copyFileSync(model!, path.join(folder, "ggml-tiny-q5_1.bin"));
    fs.writeFileSync(path.join(folder, "settings.json"), JSON.stringify({ version: 1, engine: { path: real, stamp: fileStamp(fs.statSync(real, { bigint: true })) }, language: "en" }));
  }, async (app) => {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Welcome to Phaethon" })).toBeVisible();
    await page.evaluate(() => localStorage.setItem("phaethon.onboarded", "1"));
    await page.reload();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Test prefix");
    await page.getByRole("button", { name: "Record voice for this message" }).click();
    const stop = page.getByRole("button", { name: "Stop recording" });
    await expect(stop).toBeVisible();
    // The fixture needs a few seconds of audio before stop, just like live capture.
    await page.waitForTimeout(6500);
    await stop.click();
    await expect(composer).toHaveValue(/^Test prefix .+/, { timeout: 40_000 });
    await composer.fill("Edited transcript");
    await expect(composer).toHaveValue("Edited transcript");
  }, audio);
});
