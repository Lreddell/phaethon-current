import { setTimeout as delay } from "node:timers/promises";
import type { CalendarAccount, CalendarEvent, CalendarInfo, CalendarKind, CalendarNewEvent, CalendarRange, CalendarText } from "../../shared/calendar.ts";
import { graphCalendarAuth, type GraphCalendarScope } from "../integrations/graph-auth.ts";
import { IntegrationFailure } from "../integrations/registry.ts";
import type { CalendarProvider } from "./types.ts";

const origin = "https://graph.microsoft.com";
const root = `${origin}/v1.0/me/calendars`;
const headers = { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC", outlook.body-content-type="text"' };
const eventSelect = "id,subject,start,end,location,body,showAs,originalStartTimeZone,originalEndTimeZone,isAllDay,isCancelled,isOrganizer,attendees,seriesMasterId,type,changeKey";
const MAX_JSON = 2 * 1024 * 1024;
const graphKinds: Record<string, CalendarKind> = { singleInstance: "single", seriesMaster: "series", occurrence: "occurrence", exception: "exception" };

type GraphCalendarInfo = { id?: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean };
type GraphEvent = { id?: string; subject?: string; body?: { content?: string; contentType?: string }; location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string }; originalStartTimeZone?: string; originalEndTimeZone?: string;
  isAllDay?: boolean; isCancelled?: boolean; isOrganizer?: boolean; attendees?: unknown[]; showAs?: string; type?: string; seriesMasterId?: string; "@odata.etag"?: string };

function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_+=/-]{1,1024}$/.test(value)) throw new IntegrationFailure("restricted", "That calendar or event reference is invalid.");
  return encodeURIComponent(value);
}

function checkedUrl(input: string, expectedPath: string): URL {
  const url = new URL(input);
  if (url.origin !== origin || url.pathname !== expectedPath || url.username || url.password || url.hash)
    throw new IntegrationFailure("restricted", "Microsoft returned an unexpected calendar address.");
  return url;
}

async function readJson<T>(response: Response): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new IntegrationFailure("offline", "Microsoft returned an empty calendar response.");
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(pieces, length).toString("utf8")) as T;
      length += value.length;
      if (length > MAX_JSON) throw new IntegrationFailure("offline", "Microsoft returned too much calendar data.");
      pieces.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function utc(time?: { dateTime?: string; timeZone?: string }): string {
  if (!time?.dateTime || (time.timeZone && time.timeZone.toUpperCase() !== "UTC")) throw new IntegrationFailure("offline", "Microsoft returned an invalid calendar time.");
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(time.dateTime) ? time.dateTime : time.dateTime + "Z";
  if (!Number.isFinite(Date.parse(normalized))) throw new IntegrationFailure("offline", "Microsoft returned an invalid calendar time.");
  return new Date(normalized).toISOString();
}

function eventOf(raw: GraphEvent): CalendarEvent {
  if (!raw.id) throw new IntegrationFailure("offline", "Microsoft returned an event without an identity.");
  const kind = graphKinds[raw.type ?? ""] ?? "single";
  const revision = raw["@odata.etag"];
  const busy = raw.showAs === "free" || raw.showAs === "workingElsewhere" ? "free" : raw.showAs === "tentative" ? "tentative" : raw.showAs === "oof" ? "away" : "busy";
  return {
    id: raw.id, title: raw.subject ?? "", description: raw.body?.contentType?.toLowerCase() === "text" ? (raw.body.content ?? "").slice(0, 10_000) : "",
    location: raw.location?.displayName ?? "", start: utc(raw.start), end: utc(raw.end), originalStartZone: raw.originalStartTimeZone,
    originalEndZone: raw.originalEndTimeZone, allDay: raw.isAllDay === true, kind, seriesId: raw.seriesMasterId,
    cancelled: raw.isCancelled === true, revision, busy,
    editable: raw.isOrganizer === true && !raw.isCancelled && Array.isArray(raw.attendees) && raw.attendees.length === 0 &&
      raw.type === "singleInstance" && typeof revision === "string" && /^(?:W\/)?"[^"\r\n]+"$/.test(revision),
  };
}

function graphEdit(event: CalendarText) {
  return { subject: event.title, body: { contentType: "Text", content: event.description }, location: { displayName: event.location } };
}

function graphTime(iso: string) { return { dateTime: iso.slice(0, -1), timeZone: "UTC" }; }

export class MicrosoftCalendar implements CalendarProvider {
  readonly id = "microsoft";
  constructor(private readonly auth: Pick<typeof graphCalendarAuth, "accounts" | "token"> = graphCalendarAuth, private readonly fetcher = fetch) {}

  accounts(): CalendarAccount[] {
    return this.auth.accounts().map((entry) => ({ key: entry.key, provider: this.id, name: entry.name, email: entry.email, canWrite: entry.scopes.includes("Calendars.ReadWrite") }));
  }

  private async request<T>(account: string, url: URL, signal?: AbortSignal, write?: { method: "POST" | "PATCH" | "DELETE"; body?: unknown; revision?: string }): Promise<T> {
    const lifetime = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
    const scope: GraphCalendarScope = write ? "Calendars.ReadWrite" : "Calendars.Read";
    const token = await this.auth.token(account, scope, lifetime);
    for (let attempt = 0; ; attempt++) {
      lifetime.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(url, { redirect: "error", signal: lifetime, method: write?.method ?? "GET",
          headers: { ...headers, Authorization: `Bearer ${token}`, ...(write?.body ? { "Content-Type": "application/json" } : {}), ...(write?.revision ? { "If-Match": write.revision } : {}) },
          ...(write?.body ? { body: JSON.stringify(write.body) } : {}) });
      } catch {
        signal?.throwIfAborted();
        throw new IntegrationFailure("offline", write ? "Microsoft didn’t confirm this calendar change. Refresh the calendar before trying again." : "Microsoft Calendar could not be reached.");
      }
      if (response.ok) return response.status === 204 ? undefined as T : readJson<T>(response);
      await response.body?.cancel().catch(() => {});
      const retry = Number(response.headers.get("retry-after") ?? "-1");
      if (response.status === 429 && !write && attempt === 0 && retry >= 0 && retry <= 6) {
        await delay(Math.max(1, retry) * 1000, undefined, { signal: lifetime });
        continue;
      }
      if (response.status === 401) throw new IntegrationFailure("not-connected", "Reconnect the Microsoft calendar account.");
      if (response.status === 403) throw new IntegrationFailure("permission", "Microsoft denied this calendar operation. Check the account, consent, and calendar permissions.");
      if (response.status === 404 || response.status === 412 || response.status === 409) throw new IntegrationFailure("setup", "This calendar or event changed. Refresh before trying again.");
      if (response.status === 429) throw new IntegrationFailure("offline", "Microsoft Calendar is limiting requests. Try again in a moment.");
      if (write && response.status >= 500) throw new IntegrationFailure("offline", "Microsoft didn’t confirm this calendar change. Refresh the calendar before trying again.");
      throw new IntegrationFailure("offline", `Microsoft Calendar returned HTTP ${response.status}.`);
    }
  }

  private async pages<T>(account: string, target: URL, signal?: AbortSignal): Promise<T[]> {
    const lifetime = AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]);
    const values: T[] = [];
    let next: string | undefined = target.href;
    for (let page = 0; next && page < 12; page++) {
      const result: { value?: T[]; "@odata.nextLink"?: string } = await this.request(account, checkedUrl(next, target.pathname), lifetime);
      if (!Array.isArray(result.value) || values.length + result.value.length > 1000) throw new IntegrationFailure("offline", "This calendar response is too large or invalid. Choose a shorter date range.");
      values.push(...result.value);
      next = result["@odata.nextLink"];
    }
    if (next) throw new IntegrationFailure("offline", "There are more events than Phaethon can display. Choose a shorter date range.");
    return values;
  }

  async calendars(account: string, signal?: AbortSignal): Promise<CalendarInfo[]> {
    const url = new URL(root);
    url.searchParams.set("$select", "id,name,isDefaultCalendar,canEdit");
    return (await this.pages<GraphCalendarInfo>(account, url, signal)).flatMap((calendar) => calendar.id ? [{ id: calendar.id, name: calendar.name || "Calendar",
      primary: calendar.isDefaultCalendar === true, canEdit: calendar.canEdit === true }] : []);
  }

  async events(account: string, calendar: string, range: CalendarRange, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const url = new URL(`${root}/${identifier(calendar)}/calendarView`);
    url.search = new URLSearchParams({ startDateTime: range.start, endDateTime: range.end, "$select": eventSelect, "$top": "80" }).toString();
    return (await this.pages<GraphEvent>(account, url, signal)).map(eventOf);
  }

  async read(account: string, calendar: string, event: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const target = new URL(`${root}/${identifier(calendar)}/events/${identifier(event)}`);
    target.searchParams.set("$select", eventSelect);
    return eventOf(await this.request<GraphEvent>(account, target, signal));
  }

  async create(account: string, calendar: string, event: CalendarNewEvent, operation: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const body = { ...graphEdit(event), transactionId: operation, start: graphTime(event.start), end: graphTime(event.end),
      ...(event.recurrence ? { recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: [event.recurrence.day], firstDayOfWeek: "monday" },
        range: { type: "endDate", startDate: event.start.slice(0, 10), endDate: event.recurrence.until, recurrenceTimeZone: "UTC" } } } : {}) };
    return eventOf(await this.request<GraphEvent>(account, new URL(`${root}/${identifier(calendar)}/events`), signal, { method: "POST", body }));
  }

  async update(account: string, calendar: string, event: string, revision: string, edit: CalendarText, signal?: AbortSignal): Promise<CalendarEvent> {
    return eventOf(await this.request<GraphEvent>(account, new URL(`${root}/${identifier(calendar)}/events/${identifier(event)}`), signal, { method: "PATCH", revision, body: graphEdit(edit) }));
  }

  async delete(account: string, calendar: string, event: string, revision: string, signal?: AbortSignal): Promise<void> {
    await this.request(account, new URL(`${root}/${identifier(calendar)}/events/${identifier(event)}`), signal, { method: "DELETE", revision });
  }
}
