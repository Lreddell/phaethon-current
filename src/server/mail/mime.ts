import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedMail } from "mailparser";
import { IntegrationFailure } from "../integrations/registry.ts";
import { addressOf, isAddress, type Outgoing } from "./types.ts";

export const MAX_ATTACHMENT_BYTES = 2_500_000;
export const MAX_INCOMING_MIME = 6 * 1024 * 1024;
const messageIdPattern = /^<[^<>"\s\x00-\x1f]+>$/;

export function messageIds(value: string): string[] {
  return [...value.matchAll(/<[^<>]{1,500}>/g)].map((match) => match[0]).filter((id) => messageIdPattern.test(id)).slice(-24);
}

export async function parseMime(raw: Buffer | string): Promise<ParsedMail> {
  if (Buffer.byteLength(raw) > MAX_INCOMING_MIME) throw new IntegrationFailure("restricted", "This message is too large to read in Phaethon.");
  const { simpleParser } = await import("mailparser");
  try { return await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: 350_000 }); }
  catch { throw new IntegrationFailure("offline", "This provider returned mail Phaethon couldn’t read."); }
}

export async function compileMime(message: Outgoing, sender: string, options: { keepBcc: boolean; draft?: boolean; inReplyTo?: string; references?: string[] }): Promise<Buffer> {
  if (!isAddress(sender) || addressOf(message.sender) !== sender.toLowerCase() || (!options.draft && !message.to.length) ||
    [...message.to, ...message.cc, ...message.bcc].some((address) => !isAddress(address)) ||
    /[\r\n\x00]/.test(message.subject) || message.subject.length > 998 || message.body.length > 100_000)
    throw new IntegrationFailure("restricted", "Review the sender, recipients, subject and message before continuing.");
  const attachments = [];
  let left = MAX_ATTACHMENT_BYTES;
  for (const file of message.attachments ?? []) {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > left) throw new IntegrationFailure("restricted", "Attachments must total 2.5 MB or less for this delivery method.");
      const content = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(content, 0, content.length, 0);
      const now = await handle.stat();
      if (bytesRead !== stat.size || now.size !== stat.size || now.mtimeMs !== stat.mtimeMs)
        throw new IntegrationFailure("restricted", "An attachment changed while being read. Review it and try again.");
      left -= stat.size;
      attachments.push({ filename: path.basename(file), content });
    } finally { await handle.close(); }
  }
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer");
  const inReplyTo = options.inReplyTo && messageIdPattern.test(options.inReplyTo) ? options.inReplyTo : undefined;
  const references = options.references?.filter((id) => messageIdPattern.test(id)).slice(-24);
  const mime = new MailComposer({
    from: sender, to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, text: message.body,
    inReplyTo, references, attachments, disableFileAccess: true, disableUrlAccess: true,
    newline: "windows",
  }).compile();
  mime.keepBcc = options.keepBcc;
  try { return await mime.build(); }
  catch { throw new IntegrationFailure("setup", "Phaethon couldn’t assemble the reviewed email."); }
}
