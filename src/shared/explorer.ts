export const EXPLORER_FLAG = "--explorer-import";
export const EXPLORER_MAX_FILES = 20;
export const EXPLORER_SHORTCUT_SUFFIX = " - Import files.lnk";
export const EXPLORER_SHORTCUT_DESCRIPTION = "Review selected files in Phaethon before copying them to a Space.";

export type ExplorerStatus = { state: "unsupported" | "off" | "active" | "repair" | "unavailable"; reason?: string };
export type ExplorerSelection = { id: string; files: { name: string; size: number }[]; skipped: number; reason?: string };
