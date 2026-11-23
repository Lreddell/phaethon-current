import { SPEECH_SAMPLE_RATE, SPEECH_MAX_SECONDS } from "#shared/speech";

export function pcmWav(samples: Float32Array): Blob {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (start: number, text: string) => [...text].forEach((letter, i) => data.setUint8(start + i, letter.charCodeAt(0)));
  ascii(0, "RIFF");
  data.setUint32(4, data.byteLength - 8, true);
  ascii(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, SPEECH_SAMPLE_RATE, true);
  data.setUint32(28, SPEECH_SAMPLE_RATE * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  ascii(36, "data");
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    data.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

export async function speechWav(recording: Blob): Promise<Blob> {
  if (!recording.size) throw new Error("The recording was empty. Try speaking after the recording indicator appears.");
  const decode = new AudioContext();
  try {
    const input = await decode.decodeAudioData(await recording.arrayBuffer());
    const length = Math.min(SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS, Math.ceil(input.duration * SPEECH_SAMPLE_RATE));
    const sampler = new OfflineAudioContext(1, length, SPEECH_SAMPLE_RATE);
    const source = sampler.createBufferSource();
    source.buffer = input;
    source.connect(sampler.destination);
    source.start();
    const mono = await sampler.startRendering();
    return pcmWav(mono.getChannelData(0));
  } finally { await decode.close().catch(() => {}); }
}
