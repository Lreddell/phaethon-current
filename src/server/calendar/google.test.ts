import { describe, expect, it, vi } from "vitest";
import { GoogleCalendar } from "./google.ts";

const account = "google-calendar:fixture";
const calendar = "fixture@example.invalid";
const range = { start: "2026-11-01T00:00:00.000Z", end: "2026-11-04T00:00:00.000Z" };
const operation = "01234567-1234-1234-1234-1234567890ab";
const eventId = operation.replaceAll("-", "");
const scope = "https://www.googleapis.com/auth";
const original = {
  id: eventId, summary: "Planning", status: "confirmed", eventType: "default", organizer: { self: true }, etag: '"example"',
  start: { dateTime: "2026-11-02T09:00:00-05:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-11-02T10:00:00-05:00", timeZone: "America/New_York" },
  extendedProperties: { private: { phaethonOperation: operation } },
};

function adapter() {
  const token = vi.fn(async () => "fixture-access-token");
  const send = vi.fn<typeof fetch>();
  return { provider: new GoogleCalendar({ accounts: () => [], token }, send), send, token };
}

describe("Google Calendar adapter", () => {
  it("lists calendars and keeps all-day dates in the calendar's time zone across a DST change", async () => {
    const { provider, send, token } = adapter();
    send.mockResolvedValueOnce(Response.json({ items: [{ id: calendar, summary: "Default", primary: true, accessRole: "owner" }], nextPageToken: "next&param=1" }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: "shared@example.invalid", summaryOverride: "Shared", accessRole: "reader" }] }))
      .mockResolvedValueOnce(Response.json({ timeZone: "America/New_York", items: [
        { id: "cancelled", status: "cancelled" },
        { ...original, start: { date: "2026-11-01" }, end: { date: "2026-11-02" }, recurringEventId: "series-parent" },
      ] }));
    await expect(provider.calendars(account)).resolves.toEqual([
      { id: calendar, name: "Default", primary: true, canEdit: true },
      { id: "shared@example.invalid", name: "Shared", primary: false, canEdit: false },
    ]);
    expect(new URL(String(send.mock.calls[1]?.[0])).searchParams.get("pageToken")).toBe("next&param=1");
    await expect(provider.events(account, calendar, range)).resolves.toEqual([expect.objectContaining({
      allDay: true, kind: "occurrence", seriesId: "series-parent", editable: false, originalStartZone: "America/New_York",
      start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z",
    })]);
    expect(token.mock.calls).toEqual([
      [account, `${scope}/calendar.calendarlist.readonly`, expect.any(AbortSignal)],
      [account, `${scope}/calendar.calendarlist.readonly`, expect.any(AbortSignal)],
      [account, `${scope}/calendar.events.readonly`, expect.any(AbortSignal)],
    ]);
  });

  it("checks busy times with read consent and without fetching event contents", async () => {
    const { provider, send, token } = adapter();
    send.mockResolvedValueOnce(Response.json({ calendars: { [calendar]: { busy: [{ start: "2026-11-02T09:00:00-05:00", end: "2026-11-02T10:00:00-05:00" }] } } }));
    await expect(provider.availability(account, calendar, range)).resolves.toEqual([{ start: "2026-11-02T14:00:00.000Z", end: "2026-11-02T15:00:00.000Z", status: "busy" }]);
    expect(send).toHaveBeenCalledWith("https://www.googleapis.com/calendar/v3/freeBusy", expect.objectContaining({ method: "POST", redirect: "error" }));
    expect(token).toHaveBeenCalledWith(account, `${scope}/calendar.events.freebusy`, expect.any(AbortSignal));
  });

  it("recovers an accepted create with the same operation ID and uses conditional writes", async () => {
    const { provider, send } = adapter();
    send.mockResolvedValueOnce(new Response(null, { status: 409 })).mockResolvedValueOnce(Response.json(original))
      .mockResolvedValueOnce(Response.json({ ...original, summary: "Revised" })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const proposal = { title: "Planning", location: "", description: "", start: "2026-11-02T14:00:00.000Z", end: "2026-11-02T15:00:00.000Z",
      recurrence: { day: "monday" as const, until: "2026-11-16" } };
    await expect(provider.create(account, calendar, proposal, operation)).resolves.toMatchObject({ id: eventId });
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
      id: eventId, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T235959Z"], extendedProperties: { private: { phaethonOperation: operation } },
    });
    await expect(provider.update(account, calendar, eventId, original.etag, { ...proposal, title: "Revised" })).resolves.toMatchObject({ title: "Revised" });
    await provider.delete(account, calendar, eventId, original.etag);
    const [, , patch, remove] = send.mock.calls;
    expect(patch?.[0]).toMatch(/sendUpdates=none$/);
    expect(new Headers(patch?.[1]?.headers).get("if-match")).toBe(original.etag);
    expect(Object.keys(JSON.parse(String(patch?.[1]?.body)))).toEqual(["summary", "description", "location"]);
    expect(new Headers(remove?.[1]?.headers).get("if-match")).toBe(original.etag);
    await expect(provider.read(account, "..", eventId)).rejects.toThrow("reference is invalid");
  });
});
