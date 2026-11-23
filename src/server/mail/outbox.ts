import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { isNotFound, readJson, writeJsonAtomic } from "../core/fsx.ts";
import { spaceDir } from "../core/vault.ts";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { log } from "../log.ts";
import { notifyLater } from "../background/background.ts";
import { findByEmail, logInteraction, newPerson } from "../people/people.ts";
import { resolveLocal } from "../agent/tools/files.ts";
import { authorizeIntegration } from "../integrations/policy.ts";
import { accountsFor, appOf, connector, readMailSettings, resolveAccount, senderFor } from "./access.ts";
import { addressOf, isAddress, nameOf, SendOutcomeUnknown, type MailProvider, type Outgoing } from "./types.ts";

/**
 * Drafts and their sending, one file each in `<space>/.phaethon/outbox/`.
 * Nothing is sent from the renderer: a send is a time on the draft and a
 * timer here, so a reload or a second window can't lose or double it. The
 * person can stop it (back to draft), edit it (which stops it), or send it
 * now. A send whose time passed while Phaethon was closed goes back to draft.
 */

export type DraftStatus = "draft" | "scheduled" | "sending" | "sent" | "opened" | "discarded" | "failed" | "uncertain";

export type Review = { tone: string; summary: string; issues: string[]; at: number };

export type Draft = {
  id: string;
  space: string;
  thread?: string;
  account: string;
  accountName: string;
  provider: MailProvider;
  sender: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  replyTo?: string;
  /** What the agent was asked for: a draft never sends by itself. */
  intent: "draft" | "send";
  status: DraftStatus;
  sendAt?: number;
  /** Recorded only by the user-facing send command. Older countdowns lack it. */
  approvedAt?: number;
  approvedAttachments?: string[];
  acceptedByProvider?: boolean;
  sentAt?: number;
  created: number;
  updated: number;
  /** Why it is where it is ("Stopped", "Phaethon was closed before it was sent"). */
  note?: string;
  error?: string;
  review?: Review;
  /** For a draft made from a `phaethon-email` block: the block's fingerprint, so showing it again finds the same draft. */
  key?: string;
  /** Recipients named without an address Phaethon could find; the card asks for them. */
  missing?: string[];
  /** Names known for recipients' addresses ("Name <address>", or a name the card asked an address for). */
  names?: Record<string, string>;
  /** Files from the space that go with it, found again (and checked again) when it's sent. */
  attachments?: DraftAttachment[];
};

/** `path` is the file's place in the space, as the agent's file tools name it ("files/essay.pdf"). */
export type DraftAttachment = { path: string; name: string; size: number };

export type DraftFields = { account?: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; replyTo?: string; attachments?: string[] };

const isDraftId = (id: unknown): id is string => typeof id === "string" && /^d_[a-z0-9]{6,32}$/.test(id);
const MAX_BODY = 100_000;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 10;
/** Together; most mail services refuse a message much over 20–25 MB. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** The undo window when the person presses Send themselves. */
export const MANUAL_DELAY_SECONDS = 5;

function outboxDir(space: string): string {
  return path.join(spaceDir(space), ".phaethon", "outbox");
}

function fileOf(space: string, id: string): string {
  if (!isDraftId(id)) throw new Refusal("That isn’t a draft id.");
  return path.join(outboxDir(space), `${id}.json`);
}

export function readDraft(space: string, id: string): Draft {
  let d: Draft | null;
  try {
    d = readJson<Draft | null>(fileOf(space, id), null);
  } catch (e) {
    throw new Refusal(`That draft couldn’t be read: ${messageOf(e)}`);
  }
  if (!d) throw new Refusal("That draft no longer exists.");
  return d;
}

function save(d: Draft): Draft {
  d.updated = Math.max(Date.now(), d.updated + 1);
  writeJsonAtomic(fileOf(d.space, d.id), d, { newline: true });
  for (const l of listeners) l(d);
  return d;
}

export function listDrafts(space: string): Draft[] {
  let names: string[];
  try {
    names = fs.readdirSync(outboxDir(space));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  return names
    .filter((n) => n.endsWith(".json") && isDraftId(n.slice(0, -5)))
    .map((n) => {
      try {
        return readDraft(space, n.slice(0, -5));
      } catch {
        return null;
      }
    })
    .filter((d): d is Draft => d !== null)
    .sort((a, b) => b.created - a.created);
}

function cleanList(v: string[] | undefined, what: string): string[] {
  const out = [...new Set((v ?? []).flatMap((s) => s.split(/[,;]/)).map((s) => s.trim()).filter(Boolean))];
  if (out.length > MAX_RECIPIENTS) throw new Refusal(`At most ${MAX_RECIPIENTS} ${what} recipients.`);
  for (const a of out) if (!isAddress(addressOf(a))) throw new Refusal(`“${a}” isn’t an email address.`);
  return out.map(addressOf);
}

/** Names given with addresses ("Dana Reyes <dana@x.com>"), by address. */
export function namesIn(lists: (string[] | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lists) for (const raw of (l ?? []).flatMap((s) => s.split(/[,;]/))) {
    const n = nameOf(raw);
    if (n && isAddress(addressOf(raw))) out[addressOf(raw)] = n;
  }
  return out;
}

function checkFields(f: DraftFields): { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } {
  const to = cleanList(f.to, "To");
  const cc = cleanList(f.cc, "Cc");
  const bcc = cleanList(f.bcc, "Bcc");
  const subject = String(f.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 400);
  const body = String(f.body ?? "");
  if (Buffer.byteLength(body) > MAX_BODY) throw new Refusal("That message is too long to draft here.");
  return { to, cc, bcc, subject, body };
}

/** Where an attached file really is: inside the space, under the same rules as the agent's file tools (course access, excluded folders, never Phaethon's own state). */
function attachmentFile(space: string, rel: string): string {
  return resolveLocal({ space, root: spaceDir(space), once: [] }, rel, true).real;
}

/**
 * Files to attach, by their place in the space: each must be a file there,
 * at most ten of them and 20 MB together. Repeats are dropped.
 */
export function checkAttachments(space: string, paths: readonly string[] | undefined): DraftAttachment[] {
  const wanted = [...new Set((paths ?? []).map((p) => String(p).trim().replace(/^\.\//, "")).filter(Boolean))];
  if (wanted.length > MAX_ATTACHMENTS) throw new Refusal(`Attach at most ${MAX_ATTACHMENTS} files to one email.`);
  const out: DraftAttachment[] = [];
  let total = 0;
  for (const rel of wanted) {
    const real = attachmentFile(space, rel);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Refusal(`"${rel}" is a folder; attach the files in it instead`);
    total += st.size;
    if (total > MAX_ATTACHMENT_BYTES) throw new Refusal(`Those files are over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB together, more than most mail services accept. Attach fewer, or share a link instead`);
    out.push({ path: rel, name: path.basename(real), size: st.size });
  }
  return out;
}

// ---- Timers -------------------------------------------------------------------

const timers = new Map<string, NodeJS.Timeout>();
const listeners = new Set<(d: Draft) => void>();
const key = (space: string, id: string) => `${space}/${id}`;

/** Tests and the UI's live view: every saved change to a draft. */
export function onDraftChange(f: (d: Draft) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function disarm(space: string, id: string): void {
  const t = timers.get(key(space, id));
  if (t) clearTimeout(t);
  timers.delete(key(space, id));
}

function arm(d: Draft): void {
  disarm(d.space, d.id);
  if (d.status !== "scheduled" || d.sendAt === undefined || d.approvedAt === undefined) return;
  const t = setTimeout(() => void fire(d.space, d.id), Math.max(0, d.sendAt - Date.now()));
  t.unref?.();
  timers.set(key(d.space, d.id), t);
}

async function fire(space: string, id: string): Promise<void> {
  timers.delete(key(space, id));
  let d: Draft;
  try {
    d = readDraft(space, id);
  } catch {
    return;
  }
  // Changed since it was armed (stopped, edited, rescheduled): the newer state wins.
  if (d.status !== "scheduled" || d.sendAt === undefined) return;
  if (d.approvedAt === undefined) return;
  if (d.sendAt > Date.now() + 250) return arm(d);
  await deliver(d);
}

/** What the mail app is given. Attachments are found again now: a file moved or deleted since stops the send with its name. */
function outgoing(d: Draft): Outgoing {
  const attachments = (d.attachments ?? []).map((a) => {
    try {
      return attachmentFile(d.space, a.path);
    } catch {
      throw new Refusal(`“${a.name}” isn’t at ${a.path} anymore, so the message wasn’t sent. Remove it or put it back, then send again.`);
    }
  });
  return { account: d.account, sender: d.sender, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body, ...(d.replyTo ? { replyTo: d.replyTo } : {}), ...(attachments.length ? { attachments } : {}) };
}

function attachmentDigests(paths: string[] = [], snapshot?: string): string[] {
  let remaining = MAX_ATTACHMENT_BYTES;
  return paths.map((file, index) => {
    const fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > remaining) throw new Refusal("An attachment became too large. Review the draft again.");
      const bytes = Buffer.alloc(stat.size);
      if (fs.readSync(fd, bytes) !== stat.size || fs.fstatSync(fd).size !== stat.size) throw new Refusal("An attachment changed while it was being read.");
      remaining -= stat.size;
      if (snapshot) {
        const destination = path.join(snapshot, String(index));
        fs.mkdirSync(destination, { mode: 0o700 });
        fs.writeFileSync(path.join(destination, path.basename(file)), bytes, { mode: 0o600, flag: "wx" });
      }
      return createHash("sha256").update(bytes).digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  });
}

async function deliver(d: Draft): Promise<Draft> {
  // The account must still be assigned to this space at the moment of sending.
  const account = accountsFor(d.space).find((a) => a.key === d.account);
  if (!account) {
    return save({ ...d, status: "failed", sendAt: undefined, error: "That account is no longer set up for this space, so the message wasn’t sent." });
  }
  if (!readMailSettings().allowSend) return save({ ...d, status: "draft", sendAt: undefined, note: "Sending is turned off in Settings › Mail, so it wasn’t sent." });
  if (account.canSend === false) return save({ ...d, status: "failed", sendAt: undefined, error: "Enable sending for this account in Settings." });
  let accepted = false;
  let snapshot: string | undefined;
  save({ ...d, status: "sending", error: undefined });
  try {
    const message = outgoing(d);
    if (message.attachments?.length) snapshot = fs.mkdtempSync(path.join(tmpdir(), "phaethon-mail-send-"));
    const hashes = attachmentDigests(message.attachments, snapshot);
    if (JSON.stringify(hashes) !== JSON.stringify(d.approvedAttachments ?? [])) throw new Refusal("An attachment changed after approval. Review the draft and send it again.");
    if (snapshot && message.attachments) {
      const directory = snapshot;
      message.attachments = message.attachments.map((file, index) => path.join(directory, String(index), path.basename(file)));
    }
    accepted = (await connector(appOf(d.account)).send(message))?.accepted === true;
  } catch (e) {
    log.warn("mail send failed", { error: messageOf(e) });
    const uncertain = e instanceof SendOutcomeUnknown;
    notifyLater({ kind: "mail", title: `${uncertain ? "Send outcome unknown" : "Not sent"}: ${d.subject || "(no subject)"}`, body: messageOf(e).slice(0, 200), target: d.thread ? { kind: "thread", space: d.space, thread: d.thread } : { kind: "space", space: d.space } });
    return save({ ...readDraft(d.space, d.id), status: uncertain ? "uncertain" : "failed", sendAt: undefined, error: messageOf(e) });
  } finally {
    if (snapshot) {
      try {
        fs.rmSync(snapshot, { recursive: true, force: true });
      } catch {
        log.warn("could not remove mail attachment snapshot");
      }
    }
  }
  const sent = save({ ...readDraft(d.space, d.id), status: "sent", sendAt: undefined, sentAt: Date.now(), error: undefined, note: undefined, ...(accepted ? { acceptedByProvider: true } : {}) });
  if (accepted) {
    const provider = appOf(sent.account) === "google-mail" ? "Gmail" : "Microsoft";
    notifyLater({ kind: "mail", title: `Accepted by ${provider} · ${sent.subject || "(no subject)"}`, body: "Check the mailbox’s Sent folder for the message.", whenAway: true, target: { kind: "space", space: sent.space } });
    return sent;
  }
  const added = await recordSent(sent);
  notifyLater({ kind: "mail", title: `Sent: ${sent.subject || "(no subject)"}`, body: `To ${sent.to.join(", ")}${added.length ? ` · added ${added.join(" and ")} to People` : ""}`, whenAway: true, target: sent.thread ? { kind: "thread", space: sent.space, thread: sent.thread } : { kind: "space", space: sent.space } });
  return added.length ? save({ ...readDraft(d.space, d.id), note: `Added ${added.join(" and ")} to People.` }) : sent;
}

/** A sent message goes on the card of everyone it went to that Phaethon knows. */
/** The name an address goes by in this account's mail (the newest message from it), if any. */
async function nameInMail(d: Draft, address: string): Promise<string | undefined> {
  try {
    const found = await connector(appOf(d.account)).list({ account: d.account, mailbox: "inbox", from: address, since: new Date(Date.now() - 2 * 365 * 86_400_000).toISOString(), limit: 1 });
    const n = found[0] ? nameOf(found[0].from) : "";
    return n && !n.includes("@") ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sent message goes on the card of everyone it went to; someone not in
 * People yet gets a card when a name can be found for them (given with the
 * address, asked for on the card, or in their mail). Returns who was added.
 */
async function recordSent(d: Draft): Promise<string[]> {
  const added: string[] = [];
  for (const addr of [...d.to, ...d.cc]) {
    try {
      let p = findByEmail(addr);
      if (!p) {
        const name = d.names?.[addr] ?? (await nameInMail(d, addr));
        if (name) {
          p = newPerson({ name, emails: [addr] }, d.space, "mail");
          added.push(p.name);
        }
      }
      if (p) logInteraction(p.id, { at: d.sentAt ?? Date.now(), channel: "email", direction: "out", summary: d.subject ? `Sent “${d.subject}”` : "Sent an email", ...(d.thread ? { ref: { space: d.space, thread: d.thread } } : {}) });
    } catch {
      // the send matters more than the log
    }
  }
  return added;
}

// ---- Operations ---------------------------------------------------------------

/**
 * A new draft from the agent. The send intent highlights the approval action.
 */
export function createDraft(space: string, f: DraftFields, opts: { intent: "draft" | "send"; thread?: string; unattended?: boolean; key?: string; missing?: string[]; names?: Record<string, string> }): Draft {
  const account = resolveAccount(space, f.account);
  const fields = checkFields(f);
  const attachments = checkAttachments(space, f.attachments);
  const settings = readMailSettings();
  const now = Date.now();
  const id = `d_${now.toString(36)}${randomBytes(4).toString("hex")}`;
  const addressed = fields.to.length > 0 || !!f.replyTo;
  const d: Draft = {
    id,
    space,
    ...(opts.thread ? { thread: opts.thread } : {}),
    account: account.key,
    accountName: account.name,
    provider: account.provider,
    sender: senderFor(account, f.account?.includes("@") ? f.account : undefined),
    ...fields,
    ...(f.replyTo ? { replyTo: f.replyTo } : {}),
    intent: opts.intent,
    status: "draft",
    created: now,
    updated: now,
    ...(opts.intent === "send"
      ? { note: opts.unattended ? "Written while you were away, so it waits for you." : !addressed ? "Add who it goes to, then send." : !settings.allowSend ? "Sending is turned off in Settings › Mail." : "Review this draft and press Send when it’s ready." }
      : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(opts.key ? { key: opts.key } : {}),
    ...(opts.missing?.length ? { missing: opts.missing } : {}),
    ...(() => {
      const names = { ...namesIn([f.to, f.cc, f.bcc]), ...(opts.names ?? {}) };
      return Object.keys(names).length ? { names } : {};
    })(),
  };
  save(d);
  return d;
}

const opening = new Set<string>();
const editable = (d: Draft) => !opening.has(key(d.space, d.id)) && (d.status === "draft" || d.status === "scheduled" || d.status === "failed" || d.status === "opened");

/** Changes fields; a scheduled send stops so nothing goes out that the person hasn't seen. */
export function updateDraft(space: string, id: string, patch: Partial<DraftFields>): Draft {
  const d = readDraft(space, id);
  if (!editable(d)) throw new Refusal(d.status === "sent" ? "That message was already sent." : "That draft can’t be changed now.");
  disarm(space, id);
  let account = { key: d.account, name: d.accountName, provider: d.provider, sender: d.sender };
  if (patch.account !== undefined && patch.account !== d.account) {
    const a = resolveAccount(space, patch.account);
    account = { key: a.key, name: a.name, provider: a.provider, sender: senderFor(a) };
  }
  const fields = checkFields({ to: patch.to ?? d.to, cc: patch.cc ?? d.cc, bcc: patch.bcc ?? d.bcc, subject: patch.subject ?? d.subject, body: patch.body ?? d.body, replyTo: d.replyTo });
  const attachments = patch.attachments === undefined ? d.attachments : checkAttachments(space, patch.attachments);
  const missing = fields.to.length ? [] : (d.missing ?? []);
  // An address typed while a name was missing is that person's address.
  const names = { ...(d.names ?? {}), ...namesIn([patch.to, patch.cc, patch.bcc]) };
  const fresh = fields.to.filter((a) => !d.to.includes(a) && !names[a]);
  (d.missing ?? []).forEach((n, i) => {
    if (fresh[i]) names[fresh[i]!] = n;
  });
  return save({ ...d, ...fields, attachments: attachments?.length ? attachments : undefined, ...(missing.length ? { missing } : { missing: undefined }), ...(Object.keys(names).length ? { names } : {}), account: account.key, accountName: account.name, provider: account.provider, sender: account.sender, status: "draft", sendAt: undefined, note: d.status === "scheduled" ? "Paused while you edit." : fields.to.length && d.note?.startsWith("Add who") ? undefined : d.note, error: undefined, review: d.review && patch.body === undefined && patch.subject === undefined ? d.review : undefined });
}

/** Starts (or restarts) the countdown; 0 sends now. */
export async function sendDraft(space: string, id: string, delaySeconds: number, expectedRevision?: number): Promise<Draft> {
  const d = readDraft(space, id);
  if (!editable(d)) throw new Refusal(d.status === "sent" ? "That message was already sent." : "That draft can’t be sent now.");
  if (!readMailSettings().allowSend) throw new Refusal("Sending is turned off in Settings › Mail.");
  authorizeIntegration("send", "user", true);
  if (expectedRevision !== undefined && d.updated !== expectedRevision) throw new Refusal("The draft changed. Review it again before sending.");
  if (!d.to.length && !d.replyTo) throw new Refusal("Add a recipient first.");
  disarm(space, id);
  let approvedAttachments: string[] | undefined;
  try {
    approvedAttachments = d.status === "scheduled" ? d.approvedAttachments : attachmentDigests(outgoing(d).attachments);
  } catch (e) {
    return save({ ...d, status: "failed", sendAt: undefined, error: messageOf(e) });
  }
  const approved = { ...d, approvedAt: Date.now(), approvedAttachments };
  if (delaySeconds <= 0) return deliver(approved);
  const next = save({ ...approved, status: "scheduled", sendAt: Date.now() + Math.min(delaySeconds, 600) * 1000, note: undefined, error: undefined });
  arm(next);
  return next;
}

/** The draft made from a block with this fingerprint, if any. */
export function draftByKey(space: string, key: string): Draft | undefined {
  return listDrafts(space).find((d) => d.key === key);
}

export function stopSend(space: string, id: string): Draft {
  const d = readDraft(space, id);
  disarm(space, id);
  if (d.status !== "scheduled") return d;
  return save({ ...d, status: "draft", sendAt: undefined, note: "Stopped. Nothing was sent." });
}

export function discardDraft(space: string, id: string): Draft {
  const d = readDraft(space, id);
  if (opening.has(key(space, id))) throw new Refusal("Wait for the draft to open before discarding it.");
  if (d.status === "sent" || d.status === "sending" || d.status === "uncertain") throw new Refusal("This draft already has a send attempt.");
  disarm(space, id);
  return save({ ...d, status: "discarded", sendAt: undefined });
}

export async function openDraft(space: string, id: string): Promise<Draft> {
  const d = readDraft(space, id);
  if (!editable(d)) throw new Refusal("That draft can’t be opened now.");
  const account = accountsFor(space).find((a) => a.key === d.account);
  authorizeIntegration("modify", "user", !!account && account.canOpen !== false);
  const openKey = key(space, id);
  opening.add(openKey);
  try {
    if (d.status === "scheduled") stopSend(space, id);
    const app = appOf(d.account);
    await connector(app).open(outgoing(d));
    const note = app === "graph" ? "Saved to the Microsoft mailbox’s Drafts folder." :
      app === "google-mail" ? "Saved to the Gmail Drafts folder." : "Opened in Mail to finish there.";
    return save({ ...readDraft(space, id), status: "opened", sendAt: undefined, note });
  } finally {
    opening.delete(openKey);
  }
}

export function setReview(space: string, id: string, review: Review): Draft {
  return save({ ...readDraft(space, id), review });
}

/**
 * At startup: a scheduled send whose time passed while Phaethon was closed
 * goes back to draft (a person should see it before it goes); a future one
 * is armed again.
 */
export function recoverOutbox(spaces: string[]): { reverted: number; armed: number } {
  let reverted = 0;
  let armed = 0;
  const now = Date.now();
  for (const space of spaces) {
    let drafts: Draft[];
    try {
      drafts = listDrafts(space);
    } catch {
      continue;
    }
    for (const d of drafts) {
      if (d.status === "sending") {
        save({ ...d, status: "uncertain", sendAt: undefined, error: "Phaethon closed while this was sending. Check Sent Items before composing it again." });
        reverted++;
      } else if (d.status === "scheduled") {
        if (d.approvedAt === undefined) {
          save({ ...d, status: "draft", sendAt: undefined, note: "Review and approve this draft to send it." });
          reverted++;
        } else if ((d.sendAt ?? 0) <= now) {
          save({ ...d, status: "draft", sendAt: undefined, note: "Phaethon was closed before it was sent, so it wasn’t sent." });
          reverted++;
        } else {
          arm(d);
          armed++;
        }
      }
    }
  }
  return { reverted, armed };
}

/** Tests and shutdown. */
export function disarmAll(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
