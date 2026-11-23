import { describe, expect, it, vi } from "vitest";
import { WindowsOutlook } from "./outlook-win.ts";
import { encodeRef, SendOutcomeUnknown } from "./types.ts";

const accounts = [{ name: "Test mailbox", smtp: "test@example.test", store: "A10352" }, { name: "Second mailbox", smtp: "second@example.test", store: "A10353" }];
const row = { id: "AB12", from: "test@example.test", to: ["test@example.test"], subject: "Fixture", date: "2026-01-01T00:00:00Z", unread: true };

describe("classic Outlook adapter", () => {
  it("scopes list and read to the exact account and delivery store", async () => {
    const requests: Record<string, unknown>[] = [];
    const adapter = new WindowsOutlook(async (request) => {
      requests.push(request);
      if (request.op === "accounts") return { value: accounts };
      if (request.op === "list") return { value: [row] };
      return { value: { ...row, body: "Body", truncated: false, cc: [] } };
    });
    const [first, second] = await adapter.accounts();
    const [message] = await adapter.list({ account: first!.key, mailbox: "inbox", limit: 10 });
    expect(await adapter.read(message!.ref)).toMatchObject({ account: first!.key, body: "Body" });
    expect(requests[1]).toMatchObject({ op: "list", smtp: "test@example.test", store: "A10352", mailbox: "inbox" });
    expect(requests[2]).toMatchObject({ op: "read", smtp: "test@example.test", store: "A10352", id: "AB12" });
    await expect(adapter.send({ account: second!.key, sender: "second@example.test", subject: "Re: Fixture", body: "Hi", to: ["test@example.test"], cc: [], bcc: [], replyTo: message!.ref })).rejects.toThrow("doesn’t belong");
    expect(requests).toHaveLength(3);
  });

  it("rejects foreign references and already-cancelled calls without invoking COM", async () => {
    const run = vi.fn();
    const adapter = new WindowsOutlook(run);
    await expect(adapter.read(encodeRef({ app: "graph", account: "foreign", mailbox: "inbox", id: "AB12" }))).rejects.toThrow("doesn’t belong");
    const identity = Buffer.from(JSON.stringify(["A10352", "test@example.test"])).toString("base64url");
    await expect(adapter.read(encodeRef({ app: "outlook-win", account: identity, mailbox: "inbox", id: "AB12" }), AbortSignal.abort())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("reports setup separately from an unconfirmed send", async () => {
    const adapter = new WindowsOutlook(async (request) => {
      if (request.op === "send") throw new Error("simulation: connection lost");
      return { error: "start-classic" };
    });
    expect(await adapter.health()).toMatchObject({ state: "setup" });
    const identity = Buffer.from(JSON.stringify(["A10352", "test@example.test"])).toString("base64url");
    await expect(adapter.send({ account: `outlook-win:${identity}`, sender: "test@example.test", subject: "Fixture", body: "Hi", to: ["test@example.test"], cc: [], bcc: [] })).rejects.toBeInstanceOf(SendOutcomeUnknown);
  });
});
