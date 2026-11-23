export type WindowAction = "invoke" | "set-value" | "scroll-up" | "scroll-down";
export type AccessibleWindow = { id: string; title: string; app: string };
export type AccessibleControl = { id: string; name: string; role: string; depth: number; actions: WindowAction[] };
export type WindowInspection = { title: string; app: string; controls: AccessibleControl[]; truncated: boolean; expires: number };
