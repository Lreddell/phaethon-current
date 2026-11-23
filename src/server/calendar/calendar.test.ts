import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "../../shared/calendar.ts";
import { call, tempHome } from "../../../tests/harness.ts";
import { MicrosoftCalendar } from "./microsoft.ts";
import { calendarRange, setCalendarProviderForTest } from "./service.ts";

const env = tempHome("phaethon-calendar-");
afterAll(env.cleanup);
afterEach(() => setCalendarProviderForTest(undefined));

const account = "graph-calendar:calendar-fixture";
const calendar = "fixture+/=";
const primary = "https://graph.microsoft.com/v1.0/me/calendars";
const range = { start: "2026-11-23T00:00:00.000Z", end: "2026-11-24T00:00:00.000Z" };
const proposal = { title: "Project meeting", start: "2026-11-23T09:00-05:00", end: "2026-11-23T10:00-05:00" };

function fixture(canWrite = true) {
  const token = vi.fn(async (_: string, scope: "Calendars.Read" | "Calendars.ReadWrite") => {
    if (scope === "Calendars.ReadWrite" && !canWrite) throw new Error("No write consent");
    return "fake-test-token";
  });
  const raw = {
    id: "event+01=", subject: "Project meeting", body: { contentType: "text", content: "Budget" },
    start: { dateTime: "2026-11-23T14:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T15:00:00", timeZone: "UTC" },
    originalStartTimeZone: "Eastern Standard Time", originalEndTimeZone: "Eastern Standard Time", type: "singleInstance",
    isOrganizer: true, isAllDay: false, isCancelled: false, attendees: [] as unknown[], showAs: "busy", "@odata.etag": 'W/"original"',
  };
  let created = false;
  const send = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://graph.microsoft.com");
    const route = url.pathname.replace("/v1.0/me/calendars", "");
    if (!route) return Response.json({ value: [{ id: calendar, name: "Private calendar", canEdit: true, isDefaultCalendar: true }] });
    if (route.endsWith("/calendarView")) return Response.json({ value: [raw] });
    if (options?.method === "POST") { created = true; return Response.json(raw, { status: 201 }); }
    if (options?.method === "PATCH") return Response.json({ ...raw, subject: "Planning" });
    if (options?.method === "DELETE") return new Response(null, { status: 204 });
    return created || route.includes("/events/") ? Response.json(raw) : new Response(null, { status: 404 });
  });
  const provider = new MicrosoftCalendar({
    accounts: () => [{ key: account, name: "Example", email: "example@example.invalid",
      scopes: canWrite ? ["Calendars.Read", "Calendars.ReadWrite"] : ["Calendars.Read"] }],
    token,
  }, send);
  setCalendarProviderForTest(provider);
  const request = (method: string) => send.mock.calls.find(([, options]) => options?.method === method)?.[1];
  return { send, provider, raw, request, token };
}

describe("calendar integrations", () => {
  it("lists, searches and computes availability for the selected calendar under read consent", async () => {
    const { token } = fixture(false);
    await expect(call("calendar_list", { account })).resolves.toEqual([{ id: calendar, name: "Private calendar", primary: true, canEdit: true }]);
    await expect(call("calendar_events", { account, calendar, ...range, query: "budget" })).resolves.toEqual([
      expect.objectContaining({ title: proposal.title, start: "2026-11-23T14:00:00.000Z", originalStartZone: "Eastern Standard Time" }),
    ]);
    await expect(call("calendar_availability", { account, calendar, ...range })).resolves.toEqual([
      { start: "2026-11-23T14:00:00.000Z", end: "2026-11-23T15:00:00.000Z", status: "busy" },
    ]);
    await expect(call("calendar_review", { account, calendar, kind: "create", proposal })).rejects.toThrow();
    expect(token.mock.calls.map(([, scope]) => scope)).toEqual(["Calendars.Read", "Calendars.Read", "Calendars.Read"]);
    expect(() => calendarRange("2026-02-30T11:00Z", range.end)).toThrow("time with a time zone");
  });

  it("reviews without writing, applies an approval once and deduplicates repeated creates", async () => {
    const { request, send } = fixture();
    const args = { account, calendar, kind: "create", proposal: { ...proposal, recurrence: { until: "2026-12-07" } } };
    const review = await call<{ id: string }>("calendar_review", args);
    expect(request("POST")).toBeUndefined();
    await expect(call("calendar_apply", { id: review.id })).resolves.toMatchObject({ id: "event+01=" });
    await expect(call("calendar_apply", { id: review.id })).rejects.toThrow("Review this calendar change");
    const again = await call<{ id: string }>("calendar_review", args);
    await expect(call("calendar_apply", { id: again.id })).resolves.toMatchObject({ id: "event+01=" });
    expect(send.mock.calls.filter(([, config]) => config?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(String(request("POST")?.body))).toMatchObject({
      transactionId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      start: { dateTime: "2026-11-23T14:00:00.000", timeZone: "UTC" },
      recurrence: { pattern: { daysOfWeek: ["monday"] }, range: { endDate: "2026-12-07", recurrenceTimeZone: "UTC" } },
    });
  });

  it("guards text-only edits and deletions with the original revision", async () => {
    const { raw, request } = fixture();
    const event = await call<CalendarEvent>("calendar_read", { account, calendar, event: raw.id });
    const args = { account, calendar, event: event.id, revision: event.revision };
    const review = await call<{ id: string }>("calendar_review", { ...args, kind: "update", proposal: { title: "Planning" } });
    expect(request("PATCH")).toBeUndefined();
    await expect(call("calendar_apply", { id: review.id })).resolves.toMatchObject({ title: "Planning" });
    expect(new Headers(request("PATCH")?.headers).get("if-match")).toBe(event.revision);
    expect(Object.keys(JSON.parse(String(request("PATCH")?.body)))).toEqual(["subject", "body", "location"]);
    const deleteReview = await call<{ id: string }>("calendar_review", { ...args, kind: "delete" });
    raw["@odata.etag"] = 'W/"changed"';
    await expect(call("calendar_apply", { id: deleteReview.id })).rejects.toThrow("This event changed");
    expect(request("DELETE")).toBeUndefined();
    raw.attendees.push({ emailAddress: { address: "guest@example.invalid" } });
    await expect(call("calendar_review", { ...args, revision: raw["@odata.etag"], kind: "delete" })).rejects.toThrow("original calendar app");
  });

  it("refuses Graph pagination that tries to leave the same calendar endpoint", async () => {
    const { provider, send, token } = fixture();
    send.mockResolvedValueOnce(Response.json({ value: [], "@odata.nextLink": "https://example.invalid/other" }));
    await expect(provider.calendars(account)).rejects.toThrow("unexpected calendar address");
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origin: new URL(primary).origin }), expect.anything());
    expect(token).toHaveBeenCalledTimes(1);
  });
});
