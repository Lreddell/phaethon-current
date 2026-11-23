import { IntegrationFailure, type Health } from "../integrations/registry.ts";
import { gmailAuth, gmailCompose, gmailRead, gmailSend } from "./google-auth.ts";
import { compileMime, MAX_INCOMING_MIME, messageIds, parseMime } from "./mime.ts";
import { decodeRef, encodeRef, SendOutcomeUnknown, type MailAccount, type MailConnector, type MailMessage, type MailQuery, type MailSummary, type Outgoing } from "./types.ts";

const root = new URL("https://gmail.googleapis.com/gmail/v1/users/me/");
const systemLabels: Record<string, string> = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT", junk: "SPAM", trash: "TRASH" };
const messageIdPattern = /^[A-Za-z0-9_-]{1,256}$/;
const metadataHeaders = ["From", "To", "Cc", "Subject", "Message-ID", "References"];
const metadataQuery = new URLSearchParams({ format: "metadata", fields: "id,threadId,labelIds,internalDate,payload(headers)" });
for (const header of metadataHeaders) metadataQuery.append("metadataHeaders", header);

type GmailMessage = { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; raw?: string; payload?: { headers?: { name: string; value: string }[] } };
type GmailLabel = { id?: string; name?: string };

function cleanHeader(input: unknown): string { return typeof input === "string" ? input.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 8192) : ""; }
function header(m: GmailMessage, key: string): string {
  return cleanHeader(m.payload?.headers?.find((h) => h.name?.toLowerCase() === key.toLowerCase())?.value);
}

class GmailResourceMissing extends IntegrationFailure {
  constructor() { super("setup", "Gmail could not find this mailbox or message."); }
}

async function readResponse<T>(response: Response, limit: number): Promise<T> {
  const stream = response.body?.getReader();
  if (!stream) throw new IntegrationFailure("offline", "Gmail returned an empty response.");
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await stream.read();
      if (done) return JSON.parse(Buffer.concat(pieces, length).toString("utf8")) as T;
      length += value.length;
      if (length > limit) throw new IntegrationFailure("restricted", "Gmail returned more data than Phaethon can display.");
      pieces.push(value);
    }
  } catch (error) {
    if (error instanceof IntegrationFailure) throw error;
    throw new IntegrationFailure("offline", "Gmail returned an unreadable response.");
  } finally { await stream.cancel().catch(() => {}); }
}

function normalizeSubject(value: string): string { return value.trim().replace(/^(?:re:\s*)+/i, "").toLowerCase(); }

export class Gmail implements MailConnector {
  readonly app = "google-mail";
  readonly label = "Gmail";
  constructor(private readonly auth: Pick<typeof gmailAuth, "accounts" | "token"> = gmailAuth, private readonly fetcher = fetch) {}

  async accounts(): Promise<MailAccount[]> {
    return this.auth.accounts().map(({ key, email, scopes }) => ({ key, app: this.app, name: email, emails: [email.toLowerCase()], provider: "gmail",
      enabled: true, canSend: scopes.includes(gmailSend), canOpen: scopes.includes(gmailCompose) }));
  }

  async health(): Promise<Health> {
    const accounts = this.auth.accounts();
    if (!accounts.length) return { state: "not-connected", reason: "Connect Gmail with a Google Desktop OAuth client." };
    try {
      const profile = await this.call<{ emailAddress?: string }>(accounts[0]!.key, gmailRead, "profile?fields=emailAddress", AbortSignal.timeout(8000));
      if (profile?.emailAddress?.toLowerCase() !== accounts[0]!.email.toLowerCase())
        return { state: "permission", reason: "Reconnect using the Gmail account you selected." };
      return { state: "ready" };
    } catch (error) {
      return error instanceof IntegrationFailure ? { state: error.state, reason: error.message } : { state: "offline", reason: "Gmail is temporarily unavailable." };
    }
  }

  async available() {
    const health = await this.health();
    return { ok: health.state === "ready", reason: health.reason };
  }

  private async call<T>(account: string, scope: string, route: string, signal?: AbortSignal, post?: { body: unknown; sends?: boolean }, size = 512 * 1024): Promise<T> {
    const url = new URL(route, root);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password || url.hash)
      throw new IntegrationFailure("restricted", "The Gmail operation tried to leave its account endpoint.");
    const operation = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
    const token = await this.auth.token(account, scope, operation);
    const uncertain = () => new SendOutcomeUnknown("Gmail didn’t confirm whether it accepted this message. Check Sent before composing it again.");
    let response: Response;
    try {
      response = await this.fetcher(url, { redirect: "error", signal: operation, method: post ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(post ? { "Content-Type": "application/json" } : {}) }, ...(post ? { body: JSON.stringify(post.body) } : {}) });
    } catch {
      if (post?.sends) throw uncertain();
      signal?.throwIfAborted();
      throw new IntegrationFailure("offline", "Gmail could not be reached.");
    }
    if (response.ok) {
      if (post?.sends) { await response.body?.cancel().catch(() => {}); return { accepted: true } as T; }
      return readResponse<T>(response, size);
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new IntegrationFailure("not-connected", "Reconnect this Gmail account in Settings.");
    if (response.status === 403) throw new IntegrationFailure("permission", "Google denied mailbox access. Check Gmail API access and the account’s granted permissions.");
    if (response.status === 404) throw new GmailResourceMissing();
    if (response.status === 429) throw new IntegrationFailure("offline", "Gmail is limiting requests. Try again in a moment.");
    if (post?.sends && (response.status === 408 || response.status >= 500)) throw uncertain();
    throw new IntegrationFailure("offline", `Gmail returned HTTP ${response.status}.`);
  }

  private async labelId(key: string, mailbox: string, signal: AbortSignal): Promise<string | undefined> {
    const normalized = mailbox.trim().toLowerCase() || "inbox";
    if (normalized === "archive" || normalized === "all mail") return undefined;
    if (Object.hasOwn(systemLabels, normalized)) return systemLabels[normalized];
    const result = await this.call<{ labels?: GmailLabel[] }>(key, gmailRead, "labels?fields=labels(id,name)", signal);
    const id = result?.labels?.find((item) => item.name?.toLowerCase() === normalized)?.id;
    if (!id || !messageIdPattern.test(id)) throw new GmailResourceMissing();
    return id;
  }

  private reference(ref: string, account?: string) {
    const r = decodeRef(ref);
    const key = `google-mail:${r.account}`;
    if (r.app !== this.app || !/^[a-f0-9]{32}$/.test(r.account) || !messageIdPattern.test(r.id) || (account && key !== account))
      throw new IntegrationFailure("restricted", "That message is from a different Gmail account or its reference is invalid.");
    return { ...r, account: key };
  }

  private getMetadata(account: string, id: string, signal?: AbortSignal): Promise<GmailMessage> {
    return this.call(account, gmailRead, `messages/${id}?${metadataQuery}`, signal);
  }

  private summary(m: GmailMessage, account: string, mailbox: string): MailSummary {
    const timestamp = Number(m.internalDate);
    return {
      ref: encodeRef({ app: this.app, account: account.slice("google-mail:".length), mailbox, id: m.id }),
      account, mailbox, from: header(m, "from"), to: header(m, "to") ? [header(m, "to")] : [], subject: header(m, "subject"),
      date: timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp).toISOString() : "", unread: m.labelIds?.includes("UNREAD") === true,
    };
  }

  async list(q: MailQuery, signal?: AbortSignal): Promise<MailSummary[]> {
    const lifetime = AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]);
    const label = await this.labelId(q.account, q.mailbox, lifetime);
    const terms = [];
    const after = q.since ? Date.parse(q.since) : NaN;
    if (!label && q.mailbox.toLowerCase() === "archive") terms.push("-in:inbox -in:spam -in:trash -in:drafts");
    if (Number.isFinite(after) && after > 0) terms.push(`after:${Math.floor(after / 1000)}`);
    if (q.unread !== undefined) terms.push(q.unread ? "is:unread" : "is:read");
    const max = Math.min(100, Math.max(1, q.limit));
    const out: MailSummary[] = [];
    let next = "";
    for (let page = 0; page < 6; page++) {
      const query = new URLSearchParams({ maxResults: String(Math.min(40, Math.max(max, 12))), fields: "messages(id),nextPageToken" });
      if (label) query.set("labelIds", label);
      if (label === "SPAM" || label === "TRASH") query.set("includeSpamTrash", "true");
      if (terms.length) query.set("q", terms.join(" "));
      if (next) query.set("pageToken", next);
      const result = await this.call<{ messages?: { id?: string }[]; nextPageToken?: string }>(q.account, gmailRead, `messages?${query}`, lifetime);
      const ids = (result?.messages ?? []).flatMap((item) => item.id && messageIdPattern.test(item.id) ? [item.id] : []).slice(0, 40);
      for (let i = 0; i < ids.length && out.length < max; i += 5) {
        const summaries = await Promise.all(ids.slice(i, i + 5).map(async (id) => {
          try {
            const message = await this.getMetadata(q.account, id, lifetime);
            const summary = this.summary(message, q.account, q.mailbox);
            const { default: addressParser } = await import("nodemailer/lib/addressparser");
            summary.to = addressParser(header(message, "to"), { flatten: true }).map(({ address }) => address).filter(Boolean);
            return summary;
          }
          catch (error) { if (error instanceof GmailResourceMissing) return null; throw error; }
        }));
        for (const summary of summaries) {
          if (!summary || (q.since && Date.parse(summary.date) < after) || (q.unread !== undefined && summary.unread !== q.unread)) continue;
          const from = q.mailbox === "sent" ? summary.to.join(" ") : summary.from;
          if (q.from && !from.toLowerCase().includes(q.from.toLowerCase())) continue;
          if (q.text && !`${summary.subject} ${summary.from}`.toLowerCase().includes(q.text.toLowerCase())) continue;
          out.push(summary);
          if (out.length >= max) break;
        }
      }
      if (out.length >= max || typeof result?.nextPageToken !== "string" || !result.nextPageToken || result.nextPageToken.length > 4096) break;
      next = result.nextPageToken;
    }
    return out;
  }

  async read(ref: string, signal?: AbortSignal): Promise<MailMessage> {
    const r = this.reference(ref);
    const raw = await this.call<GmailMessage>(r.account, gmailRead, `messages/${r.id}?format=raw&fields=id,internalDate,labelIds,raw`,
      signal, undefined, Math.ceil(MAX_INCOMING_MIME * 4 / 3) + 65_536);
    if (!raw?.raw || typeof raw.raw !== "string" || !/^[A-Za-z0-9_\-=]+$/.test(raw.raw)) throw new IntegrationFailure("offline", "Gmail returned an invalid message.");
    const parsed = await parseMime(Buffer.from(raw.raw, "base64url"));
    const list = (value: typeof parsed.to) => (Array.isArray(value) ? value : value ? [value] : []).flatMap((part) => part.value.map((address) => address.address ?? "").filter(Boolean));
    const body = parsed.text ?? "";
    return { ...this.summary(raw, r.account, r.mailbox), from: parsed.from?.text ?? "", to: list(parsed.to), cc: list(parsed.cc),
      subject: parsed.subject ?? "", body: body.slice(0, 34_000), truncated: body.length > 34_000 || (!body && Boolean(parsed.html)), messageId: parsed.messageId };
  }

  private async assemble(message: Outgoing, signal?: AbortSignal, draft = false) {
    const account = this.auth.accounts().find((a) => a.key === message.account);
    if (!account) throw new IntegrationFailure("not-connected", "Connect this Gmail account in Settings.");
    let threadId: string | undefined;
    let reply: string | undefined;
    let references: string[] | undefined;
    if (message.replyTo) {
      const r = this.reference(message.replyTo, message.account);
      const source = await this.getMetadata(r.account, r.id, signal);
      threadId = source.threadId;
      reply = messageIds(header(source, "message-id"))[0];
      if (!threadId || !messageIdPattern.test(threadId) || !reply || normalizeSubject(header(source, "subject")) !== normalizeSubject(message.subject))
        throw new IntegrationFailure("restricted", "The reviewed reply does not match its Gmail thread. Use the original subject or create a new message.");
      references = [...messageIds(header(source, "references")), reply];
    }
    const raw = await compileMime(message, account.email, { keepBcc: true, draft, inReplyTo: reply, references });
    return { raw: raw.toString("base64url"), ...(threadId ? { threadId } : {}) };
  }

  async send(message: Outgoing, signal?: AbortSignal): Promise<{ accepted: true }> {
    const body = await this.assemble(message, signal);
    return this.call(message.account, gmailSend, "messages/send", signal, { body, sends: true });
  }

  async open(message: Outgoing, signal?: AbortSignal): Promise<void> {
    const payload = await this.assemble(message, signal, true);
    await this.call(message.account, gmailCompose, "drafts", signal, { body: { message: payload } });
  }
}
