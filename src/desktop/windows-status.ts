import { nativeImage, type NativeImage } from "electron";
import type { TrayState } from "../shared/host.ts";

export type DesktopStatus = "sending" | "running" | "unread";
const colors: Record<DesktopStatus, [number, number, number]> = {
  sending: [241, 166, 57],
  running: [80, 191, 247],
  unread: [107, 218, 150],
};

export function desktopStatus(state: TrayState): DesktopStatus | undefined {
  if (state.sending.length) return "sending";
  if (state.running || state.automations.runningTitle) return "running";
  if (state.unseen) return "unread";
}

export function describeStatus(state: TrayState): string {
  const parts: string[] = [];
  if (state.sending.length) parts.push(`${state.sending.length} ${state.sending.length === 1 ? "send" : "sends"} pending`);
  if (state.running) parts.push(`${state.running} ${state.running === 1 ? "reply" : "replies"} in progress`);
  if (state.automations.runningTitle) parts.push("automation in progress");
  if (state.unseen) parts.push(`${state.unseen} unread ${state.unseen === 1 ? "notification" : "notifications"}`);
  return parts.join(", ");
}

function drawDot(bitmap: Buffer, width: number, height: number, radius: number, status: DesktopStatus): void {
  const [r, g, b] = colors[status];
  const centerX = width - radius - 1;
  const centerY = height - radius - 1;
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > radius) continue;
      const pixel = (y * width + x) * 4;
      const border = distance > radius - Math.max(1, radius / 4);
      bitmap.set(border ? [41, 33, 28, 255] : [b, g, r, 255], pixel);
    }
  }
}

export function windowsTrayImage(template: NativeImage, status?: DesktopStatus): NativeImage {
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const bitmap = template.toBitmap({ scaleFactor });
    const { width, height } = template.getSize(scaleFactor);
    for (let i = 0; i < bitmap.length; i += 4) {
      const alpha = bitmap[i + 3]! / 255;
      bitmap[i] = Math.round(253 * alpha);
      bitmap[i + 1] = Math.round(192 * alpha);
      bitmap[i + 2] = Math.round(91 * alpha);
    }
    if (status) drawDot(bitmap, width, height, 4 * scaleFactor, status);
    icon.addRepresentation({ buffer: bitmap, width, height, scaleFactor });
  }
  return icon;
}

const overlays = new Map<DesktopStatus, NativeImage>();
export function windowsOverlay(status?: DesktopStatus): NativeImage | null {
  if (!status) return null;
  const existing = overlays.get(status);
  if (existing) return existing;
  const pixels = Buffer.alloc(16 * 16 * 4);
  drawDot(pixels, 16, 16, 7, status);
  const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 });
  overlays.set(status, icon);
  return icon;
}
