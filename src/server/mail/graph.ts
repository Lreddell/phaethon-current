import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IntegrationFailure, type Health } from "../integrations/registry.ts";
import { graphAccounts, graphToken, type GraphScope } from "./graph-auth.ts";
import { addressOf, decodeRef, encodeRef, isAddress, SendOutcomeUnknown, type MailAccount, type MailConnector, type MailMessage, type MailQuery, type MailSummary, type Outgoing } from "./types.ts";

const origin = "https://graph.microsoft.com";
const base = `${origin}/v1.0/`;
const headers = "$select=id,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead";
const standardFolders: Record<string, string> = { inbox: "inbox", sent: "sentitems", drafts: "drafts", archive: "archive", junk: "junkemail", trash: "deleteditems" };
const maxResponse = 2 * 1024 * 1024;
const maxAttachments = 2_500_000;
type Address = { emailAddress?: { name?: string; address?: string } };
type Message = { id: string; subject?: string; from?: Address; sender?: Address; toRecipients?: Address[]; ccRecipients?: Address[];
  receivedDateTime?: string; sentDateTime?: string; isRead?: boolean; body?: { content?: string }; internetMessageId?: string };
type Page<T> = { value: T[]; "@odata.nextLink"?: string };

function operationUrl(target: string): URL {
  const url = new URL(target, base);
  if (url.origin !== origin || url.username || url.password || url.hash || !url.pathname.startsWith("/v1.0/me/"))
    throw new IntegrationFailure("restricted", "Microsoft returned an unexpected API address.");
  return url;
}

async function readJson<T>(response: Response): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new IntegrationFailure("offline", "Microsoft returned an empty response.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxResponse) throw new IntegrationFailure("offline", "Microsoft returned more mail data than Phaethon can display.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const label = (a?: Address) => a?.emailAddress?.address
  ? a.emailAddress.name && a.emailAddress.name !== a.emailAddress.address ? `${a.emailAddress.name} <${a.emailAddress.address}>` : a.emailAddress.address
  : "";
const recipients = (addresses: string[]) => addresses.map((address) => ({ emailAddress: { address } }));
const accepted = { accepted: true } as const;

export class GraphMail implements MailConnector {
  readonly app = "graph";
  readonly label = "Microsoft Graph";
  constructor(private readonly token = graphToken, private readonly request = fetch) {}

  async health(): Promise<Health> {
    const accounts = graphAccounts();
    if (!accounts.length) return { state: "not-connected", reason: "Connect an Outlook or Microsoft 365 account through Microsoft Graph." };
    const probes = await Promise.all(accounts.map(async ({ key }): Promise<Health> => {
      try {
        await this.call(key, "Mail.Read", "me/mailFolders/inbox?$select=id", AbortSignal.timeout(8_000));
        return { state: "ready" };
      } catch (error) {
        return error instanceof IntegrationFailure ? { state: error.state, reason: error.message } : { state: "offline", reason: "Microsoft Graph is temporarily unavailable." };
      }
    }));
    return probes.find((probe) => probe.state === "ready") ?? probes[0]!;
  }

  async available() {
    const health = await this.health();
    return { ok: health.state === "ready", reason: health.reason };
  }

  async accounts(): Promise<MailAccount[]> {
    return graphAccounts().map((a) => ({
      key: a.key, app: this.app, name: a.name, emails: [a.email], fullName: a.name,
      provider: "outlook", enabled: true, canSend: a.scopes.includes("Mail.Send"), canOpen: a.scopes.includes("Mail.ReadWrite"),
    }));
  }

  private async call<T>(account: string, scope: GraphScope, target: string, signal?: AbortSignal, post?: { body: unknown; sends?: boolean }): Promise<T> {
    const url = operationUrl(target);
    const operation = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
    const token = await this.token(account, scope, operation);
    for (let attempt = 0; ; attempt++) {
      operation.throwIfAborted();
      let response: Response;
      try {
        response = await this.request(url, {
          method: post ? "POST" : "GET", redirect: "error", signal: operation,
          headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"', ...(post ? { "Content-Type": "application/json" } : {}) },
          ...(post ? { body: JSON.stringify(post.body) } : {}),
        });
      } catch {
        if (post?.sends) throw new SendOutcomeUnknown("Microsoft didn’t confirm whether it accepted this message. Check Sent Items before composing it again.");
        signal?.throwIfAborted();
        throw new IntegrationFailure("offline", "Microsoft Graph could not be reached.");
      }
      if (response.ok) {
        if (post?.sends) {
          await response.body?.cancel();
          return accepted as T;
        }
        return readJson<T>(response);
      }
      await response.body?.cancel();
      const retry = Number(response.headers.get("retry-after") ?? "1");
      if (!post && response.status === 429 && attempt < 2 && retry >= 0 && retry <= 8) {
        await delay(Math.max(1, retry) * 1000, undefined, { signal: operation });
        continue;
      }
      if (response.status === 401) throw new IntegrationFailure("not-connected", "Reconnect this Microsoft account in Settings.");
      if (response.status === 403) throw new IntegrationFailure("permission", "Microsoft denied mailbox access. Check the account permissions or ask your organization’s administrator.");
      if (response.status === 404) throw new IntegrationFailure("setup", "Microsoft could not find this mailbox or message.");
      if (response.status === 429) throw new IntegrationFailure("offline", "Microsoft is limiting requests. Wait and try again.");
      if (post?.sends && response.status >= 500) throw new SendOutcomeUnknown("Microsoft didn’t confirm whether it accepted this message. Check Sent Items before composing it again.");
      throw new IntegrationFailure("offline", `Microsoft Graph returned HTTP ${response.status}.`);
    }
  }

  private async *pages<T>(key: string, target: string, signal?: AbortSignal): AsyncGenerator<T> {
    const lifetime = AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]);
    let next: string | undefined = target;
    for (let count = 0; next && count < 12; count++) {
      const page: Page<T> = await this.call(key, "Mail.Read", next, lifetime);
      if (!Array.isArray(page.value)) throw new IntegrationFailure("offline", "Microsoft returned an invalid mailbox page.");
      yield* page.value;
      next = page["@odata.nextLink"];
    }
  }

  private async folder(key: string, name: string, signal?: AbortSignal): Promise<string> {
    const wanted = name.trim().toLowerCase();
    if (Object.hasOwn(standardFolders, wanted)) return standardFolders[wanted]!;
    for await (const folder of this.pages<{ id: string; displayName: string }>(key, "me/mailFolders?$select=id,displayName&$top=50", signal)) {
      if (folder.displayName.toLowerCase() === wanted) return folder.id;
    }
    throw new IntegrationFailure("setup", "This folder was not found in the Microsoft mailbox.");
  }

  private summary(m: Message, account: string, mailbox: string): MailSummary {
    return {
      ref: encodeRef({ app: this.app, account: account.slice("graph:".length), mailbox, id: m.id }), account, mailbox,
      from: label(m.from ?? m.sender), to: (m.toRecipients ?? []).map(label).filter(Boolean),
      subject: m.subject ?? "", date: (mailbox === "sent" ? m.sentDateTime : m.receivedDateTime) ?? m.sentDateTime ?? "", unread: m.isRead === false,
    };
  }

  async list(q: MailQuery, signal?: AbortSignal): Promise<MailSummary[]> {
    const out: MailSummary[] = [];
    const folder = await this.folder(q.account, q.mailbox, signal);
    const time = q.mailbox === "sent" ? "sentDateTime" : "receivedDateTime";
    const order = q.since && Number.isFinite(Date.parse(q.since)) ? `&$filter=${time}%20ge%20${encodeURIComponent(new Date(q.since).toISOString())}` : "";
    const target = `me/mailFolders/${encodeURIComponent(folder)}/messages?${headers}&$top=50&$orderby=${time}%20desc${order}`;
    for await (const m of this.pages<Message>(q.account, target, signal)) {
      if (typeof m.id !== "string") continue;
      const s = this.summary(m, q.account, q.mailbox);
      if (q.unread !== undefined && s.unread !== q.unread) continue;
      if (q.from && !(q.mailbox === "sent" ? s.to.join(" ") : s.from).toLowerCase().includes(q.from.toLowerCase())) continue;
      if (q.text && !`${s.subject} ${s.from}`.toLowerCase().includes(q.text.toLowerCase())) continue;
      out.push(s);
      if (out.length >= Math.min(100, Math.max(1, q.limit))) break;
    }
    return out;
  }

  private reference(ref: string, key?: string) {
    const r = decodeRef(ref);
    const account = `graph:${r.account}`;
    if (r.app !== this.app || !/^[a-f0-9]{32}$/.test(r.account) || !/^[A-Za-z0-9_+=/-]{1,1024}$/.test(r.id) || (key && account !== key))
      throw new IntegrationFailure("restricted", "That message is from a different mail account or its reference is invalid.");
    return { ...r, account };
  }

  async read(ref: string, signal?: AbortSignal): Promise<MailMessage> {
    const r = this.reference(ref);
    const m = await this.call<Message>(r.account, "Mail.Read", `me/messages/${encodeURIComponent(r.id)}?${headers},body,internetMessageId`, signal);
    const body = m.body?.content ?? "";
    return { ...this.summary(m, r.account, r.mailbox), body: body.slice(0, 34_000), truncated: body.length > 34_000, cc: (m.ccRecipients ?? []).map(label), messageId: m.internetMessageId };
  }

  private async message(m: Outgoing) {
    let remaining = maxAttachments;
    const attachments = [];
    for (const file of m.attachments ?? []) {
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > remaining) throw new IntegrationFailure("restricted", "Graph attachments must total 2.5 MB or less for this send method.");
        const content = Buffer.alloc(stat.size);
        if ((await handle.read(content, 0, content.length, 0)).bytesRead !== stat.size || (await handle.stat()).size !== stat.size)
          throw new IntegrationFailure("restricted", "An attachment changed while being read. Review it and try again.");
        remaining -= stat.size;
        attachments.push({ "@odata.type": "#microsoft.graph.fileAttachment", name: path.basename(file), contentBytes: content.toString("base64") });
      } finally { await handle.close(); }
    }
    return { subject: m.subject, body: { contentType: "Text", content: m.body }, toRecipients: recipients(m.to), ccRecipients: recipients(m.cc), bccRecipients: recipients(m.bcc), attachments };
  }

  async send(m: Outgoing, signal?: AbortSignal) {
    if (m.replyTo) {
      const ref = this.reference(m.replyTo, m.account);
      // Graph's reply endpoint chooses the original sender. Check it matches the reviewed draft.
      const original = await this.read(m.replyTo, signal);
      if (m.to.length !== 1 || !isAddress(addressOf(original.from)) || m.to[0] !== addressOf(original.from) || m.cc.length || m.bcc.length || m.attachments?.length)
        throw new IntegrationFailure("restricted", "A Graph reply must go to the original sender only. Compose a new message for other recipients or attachments.");
      return this.call<typeof accepted>(m.account, "Mail.Send", `me/messages/${encodeURIComponent(ref.id)}/reply`, signal, { body: { message: { toRecipients: recipients(m.to) }, comment: m.body }, sends: true });
    }
    return this.call<typeof accepted>(m.account, "Mail.Send", "me/sendMail", signal, { body: { message: await this.message(m) }, sends: true });
  }

  async open(m: Outgoing, signal?: AbortSignal) {
    if (m.replyTo) throw new IntegrationFailure("restricted", "Graph doesn’t open threaded drafts in this version. Send the reviewed reply from Phaethon.");
    await this.call(m.account, "Mail.ReadWrite", "me/messages", signal, { body: await this.message(m) });
  }
}
