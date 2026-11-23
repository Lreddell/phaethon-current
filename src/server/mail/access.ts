import path from "node:path";
import { readJson, writeJsonAtomic } from "../core/fsx.ts";
import { vaultStateDir } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { AppleMail } from "./apple-mail.ts";
import { FakeMail, fakeMailPath } from "./fake.ts";
import { Outlook } from "./outlook.ts";
import { WindowsOutlook } from "./outlook-win.ts";
import { GraphMail } from "./graph.ts";
import { graphAccounts } from "./graph-auth.ts";
import { Providers } from "../integrations/registry.ts";
import { isMailApp, type MailAccount, type MailApp, type MailConnector } from "./types.ts";

/**
 * Who may use which mail: `<vault>/.phaethon/mail.json`. Connectors are off
 * until the person turns one on; an account found in a connector is usable
 * only in the spaces it is assigned to. The accounts last found are kept so
 * Settings can show them without asking the app again.
 */

export type MailSettings = {
  connectors: Partial<Record<MailApp, boolean>>;
  /** account key → spaces that may use it. */
  access: Record<string, string[]>;
  /** The accounts last found in the connectors that are on. */
  known: MailAccount[];
  /** The user may approve a send. Off: drafts only. */
  allowSend: boolean;
  /** Seconds between the agent's send and the send happening. */
  sendDelaySeconds: number;
  /** The mail job reads headers (never bodies) to keep people's interaction history. */
  indexForPeople: boolean;
  /** …and adds a card for someone the person writes back and forth with. */
  addPeopleFromMail: boolean;
};

export const SEND_DELAYS = [10, 30, 60, 120, 300] as const;

export const DEFAULT_MAIL: Readonly<MailSettings> = Object.freeze({
  connectors: {},
  access: {},
  known: [],
  allowSend: true,
  sendDelaySeconds: 60,
  indexForPeople: true,
  addPeopleFromMail: true,
});

export function mailFile(): string {
  return path.join(vaultStateDir(), "mail.json");
}

function parse(raw: unknown): MailSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const connectors: MailSettings["connectors"] = {};
  if (o.connectors && typeof o.connectors === "object") {
    for (const [k, v] of Object.entries(o.connectors as Record<string, unknown>)) if (isMailApp(k) && typeof v === "boolean") connectors[k] = v;
  }
  const access: Record<string, string[]> = {};
  if (o.access && typeof o.access === "object") {
    for (const [k, v] of Object.entries(o.access as Record<string, unknown>)) if (Array.isArray(v)) access[k] = v.filter((s): s is string => typeof s === "string");
  }
  const known = Array.isArray(o.known)
    ? (o.known as unknown[])
        .filter((a): a is MailAccount => !!a && typeof a === "object" && typeof (a as MailAccount).key === "string" && typeof (a as MailAccount).name === "string" && Array.isArray((a as MailAccount).emails))
        // Saved before Exchange took precedence over a school address.
        .map((a) => (a.provider === "school" && /exchange|office|microsoft/i.test(a.name) ? { ...a, provider: "exchange" as const } : a))
    : [];
  const delay = typeof o.sendDelaySeconds === "number" && o.sendDelaySeconds >= 5 && o.sendDelaySeconds <= 600 ? Math.round(o.sendDelaySeconds) : DEFAULT_MAIL.sendDelaySeconds;
  const bool = (k: "allowSend" | "indexForPeople" | "addPeopleFromMail") => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_MAIL[k]);
  return { connectors, access, known, allowSend: bool("allowSend"), sendDelaySeconds: delay, indexForPeople: bool("indexForPeople"), addPeopleFromMail: bool("addPeopleFromMail") };
}

export function readMailSettings(): MailSettings {
  try {
    return parse(readJson<unknown>(mailFile(), {}));
  } catch {
    return { ...DEFAULT_MAIL, connectors: {}, access: {}, known: [] };
  }
}

export function writeMailSettings(s: MailSettings): MailSettings {
  writeJsonAtomic(mailFile(), s, { newline: true });
  return s;
}

export function updateMailSettings(f: (s: MailSettings) => void): MailSettings {
  const s = readMailSettings();
  f(s);
  return writeMailSettings(parse(s));
}

// ---- Connectors ----------------------------------------------------------------

let overrides: Partial<Record<MailApp, MailConnector>> | undefined;

/** Tests: replace the connectors. */
export function setConnectors(c: Partial<Record<MailApp, MailConnector>> | undefined): void {
  overrides = c;
}

const built = new Providers<MailApp, MailConnector>()
  .register("apple-mail", () => new AppleMail())
  .register("outlook", () => new Outlook())
  .register("outlook-win", () => new WindowsOutlook())
  .register("graph", () => new GraphMail())
  .register("fake", () => {
    const file = fakeMailPath();
    if (!file) throw new Refusal("No test mail.");
    return new FakeMail(file);
  });

export function connector(app: MailApp): MailConnector {
  if (overrides) {
    const c = overrides[app];
    if (!c) throw new Refusal(`No ${app} connector.`);
    return c;
  }
  return built.get(app);
}

/** The apps Settings offers: the test app replaces the real ones when PHAETHON_FAKE_MAIL is set. */
export function offeredApps(): MailApp[] {
  if (overrides) return Object.keys(overrides) as MailApp[];
  return fakeMailPath() ? ["fake"] : built.ids().filter((app) => app !== "fake");
}

export function appOf(accountKey: string): MailApp {
  const app = accountKey.split(":")[0];
  if (!isMailApp(app)) throw new Refusal("That isn’t a mail account Phaethon knows.");
  return app;
}

/** The accounts this space may use (connector on, account assigned to the space). */
export function accountsFor(space: string, s = readMailSettings()): MailAccount[] {
  const local = s.connectors.graph ? new Set(graphAccounts().map((a) => a.key)) : new Set<string>();
  return s.known.filter((a) => s.connectors[a.app] === true && (s.access[a.key] ?? []).includes(space) && (a.app !== "graph" || local.has(a.key)));
}

export function mailEnabledFor(space: string): boolean {
  try {
    return accountsFor(space).length > 0;
  } catch {
    return false;
  }
}

/** The account a space asks for, by key, name or address; refuses anything not assigned to it. */
export function resolveAccount(space: string, want: string | undefined): MailAccount {
  const mine = accountsFor(space);
  if (!mine.length) throw new Refusal("No mail account is set up for this space. The user can assign one in Settings › Mail.");
  if (!want?.trim()) {
    if (mine.length === 1) return mine[0]!;
    throw new Refusal(`This space has more than one mail account; say which: ${mine.map((a) => `${a.name} (${a.emails.join(", ")})`).join("; ")}.`);
  }
  const w = want.trim().toLowerCase();
  const exact = mine.find((a) => a.key.toLowerCase() === w);
  if (exact) return exact;
  const hits = mine.filter((a) => a.name.toLowerCase() === w || a.emails.includes(w));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new Refusal("More than one connection uses that address. Select the exact account.");
  throw new Refusal(`“${want}” isn’t one of this space’s mail accounts: ${mine.map((a) => `${a.name} (${a.emails.join(", ")})`).join("; ")}.`);
}

/** Asks every connector that is on for its accounts and remembers them. */
export async function refreshAccounts(): Promise<{ accounts: MailAccount[]; errors: { app: MailApp; message: string }[] }> {
  const s = readMailSettings();
  const found: MailAccount[] = [];
  const errors: { app: MailApp; message: string }[] = [];
  for (const app of offeredApps()) {
    if (s.connectors[app] !== true) continue;
    try {
      found.push(...(await connector(app).accounts()));
    } catch (e) {
      errors.push({ app, message: (e as Error).message });
      found.push(...s.known.filter((a) => a.app === app));
    }
  }
  updateMailSettings((m) => {
    m.known = found;
  });
  return { accounts: found, errors };
}

export function senderFor(a: MailAccount, email?: string): string {
  const addr = email && a.emails.includes(email.toLowerCase()) ? email.toLowerCase() : a.emails[0];
  if (!addr) throw new Refusal(`The ${a.name} account has no address in Mail.`);
  return a.fullName ? `${a.fullName} <${addr}>` : addr;
}
