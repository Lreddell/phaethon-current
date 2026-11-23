import fs from "node:fs";
import { runNative, windowsPowerShell } from "../integrations/native-process.ts";
import { IntegrationFailure, type Health } from "../integrations/registry.ts";
import { outlookWindowsScript } from "./outlook-win-script.ts";
import { decodeRef, encodeRef, guessProvider, isAddress, SendOutcomeUnknown, type MailAccount, type MailConnector, type MailMessage, type MailQuery, type MailSummary, type Outgoing } from "./types.ts";

type Account = { name: string; smtp: string; store: string };
type Identity = Pick<Account, "smtp" | "store">;
type Summary = Omit<MailSummary, "ref" | "account" | "mailbox"> & { id: string };
type Message = Summary & Pick<MailMessage, "cc" | "body" | "truncated">;
type Request =
  | { op: "accounts" }
  | (Identity & Omit<MailQuery, "account"> & { op: "list" })
  | (Identity & { op: "read"; mailbox: string; id: string })
  | (Identity & { op: "send" | "open"; subject: string; body: string; recipients: { type: number; address: string }[]; replyId?: string; attachments?: string[] });
type Runner = (input: Request, signal?: AbortSignal) => Promise<{ value?: unknown; error?: string }>;

const errors: Record<string, Health> = {
  "not-installed": { state: "not-installed", reason: "Classic Outlook isn’t installed. New Outlook uses the Microsoft Graph connection." },
  "start-classic": { state: "setup", reason: "Open classic Outlook and sign in to an Outlook profile, then refresh." },
  "account": { state: "not-connected", reason: "That account or its Outlook delivery store is unavailable." },
  "folder": { state: "setup", reason: "That Outlook folder couldn’t be found." },
  "message": { state: "setup", reason: "That Outlook message couldn’t be found." },
  "outlook-failed": { state: "permission", reason: "Classic Outlook couldn’t complete the request. Check whether Outlook requires your approval." },
};

const run: Runner = async (input, signal) => {
  if (process.platform !== "win32") throw new IntegrationFailure("unsupported", "Classic Outlook for Windows needs Windows.");
  const bin = windowsPowerShell();
  if (!fs.existsSync(bin)) throw new IntegrationFailure("not-installed", "Windows PowerShell is unavailable.");
  const operation = AbortSignal.any([AbortSignal.timeout(input.op === "send" ? 60_000 : 20_000), ...(signal ? [signal] : [])]);
  const program = Buffer.from(outlookWindowsScript, "utf16le").toString("base64");
  const result = await runNative(bin, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", program], JSON.stringify({ version: 1, ...input }), operation);
  return JSON.parse(result) as { value?: unknown; error?: string };
};

const provider = "outlook-win";
function encode(a: Identity): string {
  return Buffer.from(JSON.stringify([a.store, a.smtp.toLowerCase()])).toString("base64url");
}
function identity(key: string): Identity {
  try {
    if (!key.startsWith(`${provider}:`) || key.length > 3000) throw new Error();
    const [store, smtp] = JSON.parse(Buffer.from(key.slice(provider.length + 1), "base64url").toString("utf8")) as [string, string];
    if (!/^[a-f0-9]{1,1536}$/i.test(store) || !isAddress(smtp) || smtp.length > 320) throw new Error();
    return { store, smtp };
  } catch {
    throw new IntegrationFailure("not-connected", "That classic Outlook connection is invalid.");
  }
}

export class WindowsOutlook implements MailConnector {
  readonly app = provider;
  readonly label = "Classic Outlook for Windows";
  constructor(private readonly request: Runner = run) {}

  private async call<T>(input: Request, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    try {
      const reply = await this.request(input, signal);
      if (reply.error) {
        if (input.op === "send" && reply.error === "outlook-failed") throw new SendOutcomeUnknown("Classic Outlook did not confirm the send. Check Sent Items before composing it again.");
        const error = errors[reply.error];
        throw new IntegrationFailure(error && error.state !== "ready" ? error.state : "offline", error?.reason ?? "Classic Outlook returned an invalid response.");
      }
      return reply.value as T;
    } catch (e) {
      if (e instanceof IntegrationFailure || e instanceof SendOutcomeUnknown) throw e;
      if (input.op === "send") throw new SendOutcomeUnknown("Classic Outlook did not confirm the send. Check Sent Items before composing it again.");
      signal?.throwIfAborted();
      throw new IntegrationFailure("offline", "Classic Outlook did not respond. Check Outlook for an open prompt.");
    }
  }

  async health(): Promise<Health> {
    try {
      return (await this.accounts()).length ? { state: "ready" } : { state: "not-connected", reason: "Classic Outlook has no usable mail accounts in its current profile." };
    } catch (e) {
      return e instanceof IntegrationFailure ? { state: e.state, reason: e.message } : { state: "offline", reason: "Classic Outlook could not be checked." };
    }
  }

  async available() {
    const result = await this.health();
    return { ok: result.state === "ready", reason: result.reason };
  }

  async accounts(): Promise<MailAccount[]> {
    const accounts = await this.call<Account[]>({ op: "accounts" });
    return accounts.filter((a) => isAddress(a.smtp) && /^[a-f0-9]{1,1536}$/i.test(a.store)).map((a) => ({
      key: `${this.app}:${encode(a)}`, app: this.app, name: a.name || a.smtp,
      emails: [a.smtp.toLowerCase()], provider: guessProvider("outlook", [a.smtp], a.name), enabled: true,
    }));
  }

  private summary(row: Summary, key: string, mailbox: string): MailSummary {
    const { id, ...item } = row;
    return { ...item, account: key, mailbox, ref: encodeRef({ app: this.app, account: key.slice(this.app.length + 1), mailbox, id }) };
  }

  async list({ account, ...query }: MailQuery, signal?: AbortSignal): Promise<MailSummary[]> {
    const rows = await this.call<Summary[]>({ ...query, op: "list", limit: Math.max(1, Math.min(50, query.limit)), ...identity(account) }, signal);
    return rows.map((row) => this.summary(row, account, query.mailbox));
  }

  private reference(ref: string, expected?: string) {
    const r = decodeRef(ref);
    const key = `${this.app}:${r.account}`;
    if (r.app !== this.app || (expected && key !== expected) || !/^[a-f0-9]{1,1536}$/i.test(r.id))
      throw new IntegrationFailure("restricted", "That message reference doesn’t belong to this connection.");
    return { ...r, key };
  }

  async read(ref: string, signal?: AbortSignal): Promise<MailMessage> {
    const r = this.reference(ref);
    const { body, cc, truncated, ...row } = await this.call<Message>({ op: "read", ...identity(r.key), id: r.id, mailbox: r.mailbox }, signal);
    return { ...this.summary(row, r.key, r.mailbox), body, cc, truncated };
  }

  private async compose(m: Outgoing, op: "send" | "open", signal?: AbortSignal): Promise<void> {
    const recipients = [m.to, m.cc, m.bcc].flatMap((list, i) => list.map((address) => ({ address, type: i + 1 })));
    if (op === "send" && !m.to.length) throw new IntegrationFailure("restricted", "Add a recipient before sending.");
    await this.call({ op, ...identity(m.account), subject: m.subject, body: m.body, recipients,
      ...(m.replyTo ? { replyId: this.reference(m.replyTo, m.account).id } : {}), attachments: m.attachments }, signal);
  }

  send(m: Outgoing, signal?: AbortSignal): Promise<void> { return this.compose(m, "send", signal); }
  open(m: Outgoing, signal?: AbortSignal): Promise<void> { return this.compose(m, "open", signal); }
}
