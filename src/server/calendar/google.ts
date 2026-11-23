import type { CalendarAccount, CalendarBusy, CalendarEvent, CalendarInfo, CalendarNewEvent, CalendarRange, CalendarText } from "../../shared/calendar.ts";
import { GoogleDesktopAuth } from "../integrations/google-auth.ts";
import { IntegrationFailure } from "../integrations/registry.ts";
import type { CalendarProvider } from "./types.ts";

const root = "https://www.googleapis.com/calendar/v3";
const googleScope = "https://www.googleapis.com/auth";
const listScope = `${googleScope}/calendar.calendarlist.readonly`;
const readScope = `${googleScope}/calendar.events.readonly`;
const freeBusyScope = `${googleScope}/calendar.events.freebusy`;
const writeScope = `${googleScope}/calendar.events`;
export const googleCalendarAuth = new GoogleDesktopAuth("google-calendar", [listScope, readScope, freeBusyScope], [writeScope]);

type GoogleTime = { date?: string; dateTime?: string; timeZone?: string };
type RawEvent = { id?: string; etag?: string; start?: GoogleTime; end?: GoogleTime; summary?: string; description?: string; location?: string;
  eventType?: string; status?: string; transparency?: string; recurringEventId?: string; recurrence?: string[]; locked?: boolean;
  organizer?: { self?: boolean }; attendeesOmitted?: boolean; attendees?: unknown[]; extendedProperties?: { private?: { phaethonOperation?: string } } };
type RawCalendar = { id?: string; summary?: string; summaryOverride?: string; timeZone?: string; primary?: boolean; accessRole?: string };

class GoogleCalendarFailure extends IntegrationFailure {
  constructor(readonly status: number, state: IntegrationFailure["state"], display: string) { super(state, display); }
}

function segment(id: string): string {
  if (typeof id !== "string" || !id || id.length > 1024 || id === "." || id === ".." || /[/\\\x00-\x20\x7f]/.test(id))
    throw new IntegrationFailure("restricted", "That calendar or event reference is invalid.");
  return encodeURIComponent(id);
}

function eventPath(calendar: string, event?: string): string {
  return `/calendars/${segment(calendar)}/events${event === undefined ? "" : "/" + segment(event)}`;
}

function utc(value: string | undefined): string {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))
    throw new IntegrationFailure("offline", "Google returned an invalid calendar time.");
  return new Date(value).toISOString();
}

function dateStart(date: string, zone: string): string {
  const midnight = Date.parse(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight))
    throw new IntegrationFailure("offline", "Google returned an invalid all-day event date.");
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { throw new IntegrationFailure("offline", "Google returned an unsupported calendar time zone."); }
  // Find the first minute belonging to the calendar date, including a skipped
  // local midnight when the UTC offset changes for daylight saving.
  let low = midnight / 60_000 - 1440;
  let high = midnight / 60_000 + 1440;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (format.format(mid * 60_000) < date) low = mid + 1;
    else high = mid;
  }
  if (format.format(low * 60_000) !== date) throw new IntegrationFailure("offline", "Google returned an invalid date for this calendar time zone.");
  return new Date(low * 60_000).toISOString();
}

function eventOf(raw: RawEvent, zone = "UTC"): CalendarEvent {
  if (!raw?.id) throw new IntegrationFailure("offline", "Google returned an event without an identity.");
  const originalStartZone = raw.start?.timeZone || (raw.start?.date ? zone : undefined);
  const originalEndZone = raw.end?.timeZone || (raw.end?.date ? zone : undefined);
  const kind = raw.recurringEventId ? "occurrence" : raw.recurrence?.length ? "series" : "single";
  const revision = raw.etag;
  return {
    id: raw.id, title: raw.summary ?? "", description: (raw.description ?? "").slice(0, 10_000), location: raw.location ?? "",
    start: raw.start?.date ? dateStart(raw.start.date, originalStartZone ?? zone) : utc(raw.start?.dateTime),
    end: raw.end?.date ? dateStart(raw.end.date, originalEndZone ?? zone) : utc(raw.end?.dateTime),
    originalStartZone, originalEndZone, allDay: Boolean(raw.start?.date), kind, seriesId: raw.recurringEventId,
    revision, cancelled: raw.status === "cancelled",
    busy: raw.transparency === "transparent" ? "free" : raw.eventType === "outOfOffice" ? "away" : raw.status === "tentative" ? "tentative" : "busy",
    editable: raw.status === "confirmed" && raw.organizer?.self === true && raw.eventType === "default" && kind === "single" &&
      !raw.locked && !raw.attendeesOmitted && !raw.attendees?.length && typeof revision === "string" && /^"[^"\r\n]+"$/.test(revision),
  };
}

function details(event: CalendarText) { return { summary: event.title, description: event.description, location: event.location }; }
const eventTime = (dateTime: string) => ({ dateTime, timeZone: "UTC" });
const weekdays = { monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA", sunday: "SU" } as const;

export class GoogleCalendar implements CalendarProvider {
  readonly id = "google";

  constructor(private readonly auth: Pick<GoogleDesktopAuth, "accounts" | "token"> = googleCalendarAuth, private readonly fetcher = fetch) {}

  accounts(): CalendarAccount[] {
    return this.auth.accounts().map((account) => ({ key: account.key, name: account.email, email: account.email, provider: this.id, canWrite: account.scopes.includes(writeScope) }));
  }

  private async request<T>(account: string, scope: string, route: string, signal?: AbortSignal, options: RequestInit = {}): Promise<T> {
    const lifetime = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
    const token = await this.auth.token(account, scope, lifetime);
    let response: Response;
    try {
      response = await this.fetcher(root + route, { ...options, signal: lifetime, redirect: "error",
        headers: { ...options.headers, Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}) } });
    } catch {
      signal?.throwIfAborted();
      throw new IntegrationFailure("offline", scope === writeScope ? "Google didn’t confirm this calendar change. Refresh before trying again." : "Google Calendar could not be reached.");
    }
    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status === 401) throw new GoogleCalendarFailure(status, "not-connected", "Reconnect the Google calendar account.");
      if (status === 403) throw new GoogleCalendarFailure(status, "permission", "Google denied this operation. Check Calendar API access, consent, and calendar permissions.");
      if ([404, 409, 410, 412].includes(status)) throw new GoogleCalendarFailure(status, "setup", "This calendar or event changed. Refresh before trying again.");
      if (status === 429) throw new GoogleCalendarFailure(status, "offline", "Google Calendar is limiting requests. Try again in a moment.");
      if (status >= 500 && scope === writeScope) throw new GoogleCalendarFailure(status, "offline", "Google didn’t confirm this calendar change. Refresh before trying again.");
      throw new GoogleCalendarFailure(status, "offline", `Google Calendar returned HTTP ${status}.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new IntegrationFailure("offline", "Google returned an empty calendar response.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as T;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error("Calendar page too large");
        chunks.push(value);
      }
    } catch {
      signal?.throwIfAborted();
      throw new IntegrationFailure("offline", "Google returned an unreadable calendar response. Try a shorter date range.");
    } finally { await reader.cancel().catch(() => {}); }
  }

  private async pages<T>(account: string, scope: string, route: string, query: Record<string, string>, signal?: AbortSignal) {
    const lifetime = AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]);
    const results: T[] = [];
    let next: string | undefined;
    let zone: string | undefined;
    for (let i = 0; i < 12; i++) {
      const params = new URLSearchParams({ ...query, ...(next ? { pageToken: next } : {}) });
      const page: { items?: T[]; nextPageToken?: string; timeZone?: string } = await this.request(account, scope, `${route}?${params}`, lifetime);
      if (!page || typeof page !== "object") break;
      const items = page.items ?? [];
      if (!Array.isArray(items) || results.length + items.length > 1000) break;
      results.push(...items);
      zone ??= page.timeZone;
      next = page.nextPageToken;
      if (!next) return { results, zone };
      if (typeof next !== "string" || next.length > 4096) break;
    }
    throw new IntegrationFailure("offline", "This Google Calendar response is too large or invalid. Try a shorter date range.");
  }

  async calendars(account: string, signal?: AbortSignal): Promise<CalendarInfo[]> {
    const { results } = await this.pages<RawCalendar>(account, listScope, "/users/me/calendarList", { maxResults: "100",
      fields: "items(id,summary,summaryOverride,primary,accessRole),nextPageToken" }, signal);
    return results.flatMap((item) => item.id ? [{ id: item.id, name: item.summaryOverride ?? item.summary ?? item.id, primary: item.primary === true,
      canEdit: item.accessRole === "owner" || item.accessRole === "writer" }] : []);
  }

  async events(account: string, calendar: string, range: CalendarRange, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const { results, zone } = await this.pages<RawEvent>(account, readScope, eventPath(calendar), {
      timeMin: range.start, timeMax: range.end, singleEvents: "true", showDeleted: "false", orderBy: "startTime", maxResults: "80",
    }, signal);
    return results.filter((raw) => raw.status !== "cancelled").map((raw) => eventOf(raw, zone));
  }

  async availability(account: string, calendar: string, range: CalendarRange, signal?: AbortSignal): Promise<CalendarBusy[]> {
    segment(calendar);
    const result = await this.request<{ calendars?: Record<string, { busy?: { start?: string; end?: string }[]; errors?: unknown[] }> }>(
      account, freeBusyScope, "/freeBusy", signal, { method: "POST", body: JSON.stringify({ timeMin: range.start, timeMax: range.end, items: [{ id: calendar }] }) });
    const entry = result?.calendars && Object.hasOwn(result.calendars, calendar) ? result.calendars[calendar] : undefined;
    if (entry?.errors?.length || !Array.isArray(entry?.busy) || entry.busy.length > 1000)
      throw new IntegrationFailure("permission", "Google could not return availability for this calendar.");
    return entry.busy.flatMap((period) => {
      const start = utc(period.start);
      const end = utc(period.end);
      if (start >= end || end <= range.start || start >= range.end) return [];
      return [{ start: start < range.start ? range.start : start, end: end > range.end ? range.end : end, status: "busy" as const }];
    }).sort((a, b) => a.start.localeCompare(b.start));
  }

  private async withTimeZone(account: string, calendar: string, raw: RawEvent, signal?: AbortSignal): Promise<CalendarEvent> {
    if (!raw.start?.date || (raw.start.timeZone && raw.end?.timeZone)) return eventOf(raw);
    const result = await this.request<RawCalendar>(account, listScope, `/users/me/calendarList/${segment(calendar)}?fields=timeZone`, signal);
    return eventOf(raw, result.timeZone);
  }

  async read(account: string, calendar: string, event: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const raw = await this.request<RawEvent>(account, readScope, eventPath(calendar, event), signal);
    if (raw?.status === "cancelled") throw new IntegrationFailure("setup", "This calendar event was cancelled. Refresh the calendar.");
    return this.withTimeZone(account, calendar, raw, signal);
  }

  async create(account: string, calendar: string, event: CalendarNewEvent, operation: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const id = operation.replaceAll("-", "");
    if (!/^[a-f0-9]{32}$/.test(id)) throw new IntegrationFailure("restricted", "This calendar operation has an invalid identity.");
    const body = { ...details(event), id, start: eventTime(event.start), end: eventTime(event.end),
      extendedProperties: { private: { phaethonOperation: operation } }, ...(event.recurrence ? {
        recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${weekdays[event.recurrence.day]};UNTIL=${event.recurrence.until.replaceAll("-", "")}T235959Z`],
      } : {}) };
    try {
      return eventOf(await this.request<RawEvent>(account, writeScope, eventPath(calendar) + "?sendUpdates=none", signal, { method: "POST", body: JSON.stringify(body) }));
    } catch (error) {
      if (!(error instanceof GoogleCalendarFailure) || error.status !== 409) throw error;
      const existing = await this.request<RawEvent>(account, readScope, eventPath(calendar, id), signal);
      if (existing?.extendedProperties?.private?.phaethonOperation !== operation || existing.status === "cancelled") throw error;
      return eventOf(existing);
    }
  }

  async update(account: string, calendar: string, event: string, revision: string, edit: CalendarText, signal?: AbortSignal): Promise<CalendarEvent> {
    const raw = await this.request<RawEvent>(account, writeScope, eventPath(calendar, event) + "?sendUpdates=none", signal,
      { method: "PATCH", headers: { "If-Match": revision }, body: JSON.stringify(details(edit)) });
    return this.withTimeZone(account, calendar, raw, signal);
  }

  async delete(account: string, calendar: string, event: string, revision: string, signal?: AbortSignal): Promise<void> {
    await this.request(account, writeScope, eventPath(calendar, event) + "?sendUpdates=none", signal, { method: "DELETE", headers: { "If-Match": revision } });
  }
}
