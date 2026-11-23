import { describe, expect, it, vi } from "vitest";
import { Gmail } from "./gmail.ts";
import { gmailCompose, gmailRead, gmailSend } from "./google-auth.ts";
import { parseMime } from "./mime.ts";
import { encodeRef, SendOutcomeUnknown, type Outgoing } from "./types.ts";

const id = "a".repeat(32);
const account = `google-mail:${id}`;
const original = {
  id: "fake-message", threadId: "thread-ref", labelIds: ["UNREAD", "INBOX"],
  internalDate: "1795449942000",
  payload: { headers: [
    { name: "From", value: "Example <friend@example.invalid>" },
    { name: "To", value: "me@example.invalid, teammate@example.invalid" },
    { name: "Subject", value: "Trip" },
    { name: "Message-ID", value: "<original@example.invalid>" },
  ] },
};
const outgoing: Outgoing = {
  account, sender: "me@example.invalid", to: ["friend@example.invalid"], cc: [], bcc: ["blind@example.invalid"], subject: "Re: Trip", body: "Résumé ready.",
};

function adapter(scopes = [gmailRead, gmailSend, gmailCompose]) {
  const token = vi.fn(async (_: string, scope: string) => {
    if (!scopes.includes(scope)) throw new Error("Permission not granted");
    return "gmail-fixture-token";
  });
  const fetcher = vi.fn<typeof fetch>();
  const gmail = new Gmail({ accounts: () => [{ key: account, email: outgoing.sender, scopes }], token }, fetcher);
  return { gmail, fetcher, token };
}

describe("Gmail connector", () => {
  it("queries headers under read permission and opens only the authorized message", async () => {
    const { gmail, fetcher, token } = adapter([gmailRead]);
    const message = Buffer.from("From: Example <friend@example.invalid>\r\nTo: me@example.invalid\r\nSubject: Trip\r\nMessage-ID: <original@example.invalid>\r\n\r\nPlan for Thursday.");
    fetcher.mockResolvedValueOnce(Response.json({ messages: [{ id: original.id }] }))
      .mockResolvedValueOnce(Response.json(original))
      .mockResolvedValueOnce(Response.json({ id: original.id, labelIds: original.labelIds, internalDate: original.internalDate, raw: message.toString("base64url") }));
    const [result] = await gmail.list({ account, mailbox: "inbox", text: "trip", unread: true, limit: 5 });
    expect(result).toMatchObject({ unread: true, subject: "Trip", account, to: ["me@example.invalid", "teammate@example.invalid"] });
    const list = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(list.origin).toBe("https://gmail.googleapis.com");
    expect(list.searchParams.get("labelIds")).toBe("INBOX");
    expect(list.searchParams.get("q")).toBe("is:unread");
    await expect(gmail.read(result!.ref)).resolves.toMatchObject({ body: "Plan for Thursday.", messageId: "<original@example.invalid>" });
    expect(token.mock.calls.map(([, scope]) => scope)).toEqual([gmailRead, gmailRead, gmailRead]);
    await expect(gmail.send(outgoing)).rejects.toThrow("Permission not granted");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("preserves reply headers and Bcc, and saves an approved draft with separate consent", async () => {
    const { gmail, fetcher, token } = adapter();
    const reference = encodeRef({ app: "google-mail", account: id, mailbox: "inbox", id: original.id });
    fetcher.mockResolvedValueOnce(Response.json(original)).mockResolvedValueOnce(Response.json({ id: "fake-sent" }))
      .mockResolvedValueOnce(Response.json({ id: "fake-draft" }));
    await expect(gmail.send({ ...outgoing, replyTo: reference })).resolves.toEqual({ accepted: true });
    const send = fetcher.mock.calls[1]!;
    expect(String(send[0])).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(send[1]?.redirect).toBe("error");
    const sent = JSON.parse(String(send[1]?.body));
    expect(sent.threadId).toBe(original.threadId);
    const mail = await parseMime(Buffer.from(sent.raw, "base64url"));
    expect(mail).toMatchObject({ subject: "Re: Trip", inReplyTo: "<original@example.invalid>", text: expect.stringContaining("Résumé ready.") });
    expect(mail.bcc).toMatchObject({ value: [{ address: "blind@example.invalid" }] });
    await expect(gmail.open(outgoing)).resolves.toBeUndefined();
    expect(String(fetcher.mock.calls[2]?.[0])).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(token.mock.calls.map(([, scope]) => scope)).toEqual([gmailRead, gmailSend, gmailCompose]);
  });

  it("does not retry uncertain delivery or accept a reply reference from another account", async () => {
    const { gmail, fetcher } = adapter();
    const other = encodeRef({ app: "google-mail", account: "b".repeat(32), mailbox: "inbox", id: original.id });
    await expect(gmail.send({ ...outgoing, replyTo: other })).rejects.toThrow("different Gmail account");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(gmail.send(outgoing)).rejects.toBeInstanceOf(SendOutcomeUnknown);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
