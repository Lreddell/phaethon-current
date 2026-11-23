import { describe, expect, it, vi } from "vitest";
import { GraphMail } from "./graph.ts";
import { decodeRef, encodeRef, SendOutcomeUnknown, type Outgoing } from "./types.ts";

const id = "a".repeat(32);
const key = `graph:${id}`;
const request = (value: unknown) => Response.json(value);
const query = { account: key, mailbox: "inbox", text: "essay", limit: 1 };
const outgoing: Outgoing = { account: key, sender: "test@example.com", to: ["other@example.com"], cc: [], bcc: [], subject: "Essay", body: "Here are my notes." };

describe("Microsoft Graph mail", () => {
  it("paginates message headers and reads an account-qualified immutable ID", async () => {
    const token = vi.fn(async () => "mock-token");
    const next = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50";
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(request({ value: [{ id: "first", subject: "Other thread" }], "@odata.nextLink": next }))
      .mockResolvedValueOnce(request({ value: [{ id: "mail-2", subject: "Essay rubric" }] }))
      .mockResolvedValueOnce(request({ id: "mail-2", subject: "Essay rubric", body: { content: "Rubric" } }));
    const provider = new GraphMail(token, fetch);
    const result = await provider.list(query);
    expect(result.map((m) => m.subject)).toEqual(["Essay rubric"]);
    const [message] = result;
    expect(decodeRef(message!.ref)).toMatchObject({ app: "graph", account: id, id: "mail-2" });
    expect(String(fetch.mock.calls[1]![0])).toBe(next);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { Prefer: expect.stringContaining("ImmutableId") } });
    await expect(provider.read(message!.ref)).resolves.toMatchObject({ body: "Rubric", account: key });
    expect(token.mock.calls).toHaveLength(3);
  });

  it("refuses to send a token to a pagination destination outside Graph", async () => {
    const token = vi.fn(async () => "mock-token");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(request({ value: [], "@odata.nextLink": "https://elsewhere.example/me/folders" }));
    await expect(new GraphMail(token, fetch).list(query)).rejects.toMatchObject({ state: "restricted" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledTimes(1);
  });

  it("uses Mail.Send, treats HTTP 202 as acceptance, and never retries a send on network failure", async () => {
    const token = vi.fn(async () => "mock-token");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 202 })).mockRejectedValueOnce(new Error("connection lost"));
    const provider = new GraphMail(token, fetch);
    await expect(provider.send(outgoing)).resolves.toEqual({ accepted: true });
    expect(token).toHaveBeenCalledWith(key, "Mail.Send", expect.any(AbortSignal));
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).message.toRecipients).toEqual([{ emailAddress: { address: outgoing.to[0] } }]);
    await expect(provider.send(outgoing)).rejects.toBeInstanceOf(SendOutcomeUnknown);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects replies from a different connection before reaching a mailbox", async () => {
    const other = encodeRef({ app: "graph", mailbox: "inbox", id: "message", account: "b".repeat(32) });
    const token = vi.fn(async () => "mock-token");
    await expect(new GraphMail(token).send({ ...outgoing, replyTo: other })).rejects.toMatchObject({ state: "restricted" });
    expect(token).not.toHaveBeenCalled();
  });
});
