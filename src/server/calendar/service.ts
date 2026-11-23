import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { WEEKDAYS, type CalendarAccount, type CalendarBusy, type CalendarEvent, type CalendarMutation, type CalendarNewEvent, type CalendarProviderId, type CalendarRange, type CalendarText } from "../../shared/calendar.ts";
import { readJson, writeJsonAtomic } from "../core/fsx.ts";
import { vaultStateDir } from "../core/vault.ts";
import { authorizeIntegration } from "../integrations/policy.ts";
import { graphCalendarAuth } from "../integrations/graph-auth.ts";
import { Providers } from "../integrations/registry.ts";
import { host } from "../host.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import { GoogleCalendar, googleCalendarAuth } from "./google.ts";
import { MicrosoftCalendar } from "./microsoft.ts";
import type { CalendarProvider } from "./types.ts";

const providers = new Providers<CalendarProviderId, CalendarProvider>()
  .register("microsoft", () => new MicrosoftCalendar())
  .register("google", () => new GoogleCalendar());
const providersForSession = () => (override ? [override] : providers.ids().map((id) => providers.get(id)));
let override: CalendarProvider | undefined;
export function setCalendarProviderForTest(provider: CalendarProvider | undefined) { override = provider; }

function resolve(key: unknown): { provider: CalendarProvider; account: CalendarAccount } {
  for (const provider of providersForSession()) {
    const account = provider.accounts().find((item) => item.key === key);
    if (account) return { provider, account };
  }
  throw new Refusal("Connect and choose a calendar account first.");
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Refusal(`Enter a valid ${field}.`);
  return value.trim();
}

function id(value: unknown): string {
  const identifier = text(value, "calendar reference", 1024);
  if (!identifier || /[\r\n]/.test(identifier)) throw new Refusal("Choose a valid calendar or event reference.");
  return identifier;
}

function iso(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10))
    throw new Refusal("Enter a calendar time with a time zone.");
  return new Date(value).toISOString();
}

export function calendarRange(start: unknown, end: unknown, maxDays = 92): CalendarRange {
  const range = { start: iso(start), end: iso(end) };
  const duration = Date.parse(range.end) - Date.parse(range.start);
  if (duration <= 0 || duration > maxDays * 86_400_000) throw new Refusal(`Choose a date range up to ${maxDays} days with the end after the start.`);
  return range;
}

function calendarText(raw: unknown): CalendarText {
  if (!raw || typeof raw !== "object") throw new Refusal("Enter the event details.");
  const event = raw as Partial<CalendarText>;
  const title = text(event.title, "event title", 250);
  if (!title) throw new Refusal("Give the event a title.");
  return { title, location: text(event.location ?? "", "location", 200), description: text(event.description ?? "", "description", 10_000) };
}

function newEvent(raw: unknown): CalendarNewEvent {
  const fields = calendarText(raw);
  const event = raw as Partial<CalendarNewEvent>;
  const times = calendarRange(event.start, event.end, 31);
  if (!event.recurrence) return { ...fields, ...times };
  const day = WEEKDAYS[(new Date(times.start).getUTCDay() + 6) % WEEKDAYS.length]!;
  const until = event.recurrence.until;
  if (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(until) || !Number.isFinite(Date.parse(until)) ||
      new Date(until).toISOString().slice(0, 10) !== until || until < times.start.slice(0, 10) || Date.parse(until) - Date.parse(times.start) > 366 * 86_400_000)
    throw new Refusal("Choose an end date within one year of the first event.");
  return { ...fields, ...times, recurrence: { day, until } };
}

export function busyTimes(events: readonly CalendarEvent[], range: CalendarRange): CalendarBusy[] {
  return events.flatMap((event) => {
    if (event.cancelled || event.busy === "free" || event.end <= range.start || event.start >= range.end) return [];
    return [{ start: event.start < range.start ? range.start : event.start, end: event.end > range.end ? range.end : event.end, status: event.busy }];
  }).sort((a, b) => a.start.localeCompare(b.start));
}

type Approval = { id: string; change: CalendarMutation; expires: number };
const approvals = new Map<string, Approval>();
type Creation = { operation: string; started: number; event?: string };
const activeCreates = new Set<string>();
const ledgerFile = () => path.join(vaultStateDir(), "calendar-creates.json");
const readLedger = () => readJson<Record<string, Creation>>(ledgerFile(), {});

async function reviewedTarget(provider: CalendarProvider, account: CalendarAccount, calendar: string, signal: AbortSignal): Promise<string> {
  authorizeIntegration("modify", "user", account.canWrite);
  const target = (await provider.calendars(account.key, signal)).find((item) => item.id === calendar);
  if (!target?.canEdit) throw new Refusal("Choose a calendar this account can edit.");
  return target.name;
}

async function currentEvent(provider: CalendarProvider, account: string, calendar: string, event: string, revision: string, signal: AbortSignal) {
  const previous = await provider.read(account, calendar, event, signal);
  if (!previous.editable) throw new Refusal("This event can only be changed in the original calendar app.");
  if (previous.revision !== revision) throw new Refusal("This event changed. Refresh the calendar and review it again.");
  return previous;
}

async function createOnce(provider: CalendarProvider, change: Extract<CalendarMutation, { kind: "create" }>, signal: AbortSignal): Promise<CalendarEvent> {
  const fingerprint = createHash("sha256").update(JSON.stringify(change)).digest("hex");
  if (activeCreates.has(fingerprint)) throw new Refusal("This calendar event is already being created.");
  const now = Date.now();
  const ledger = Object.fromEntries(Object.entries(readLedger()).filter(([, value]) => value && typeof value.operation === "string" && value.started > now - 86_400_000));
  const record = ledger[fingerprint] ?? { operation: randomUUID(), started: now };
  if (record.event) return provider.read(change.account, change.calendar, record.event, signal);
  if (!ledger[fingerprint] && Object.keys(ledger).length >= 1000) throw new Refusal("Too many recent calendar operations. Try again later.");
  ledger[fingerprint] = record;
  writeJsonAtomic(ledgerFile(), ledger, { newline: true });
  activeCreates.add(fingerprint);
  try {
    const created = await provider.create(change.account, change.calendar, change.proposal, record.operation, signal);
    writeJsonAtomic(ledgerFile(), { ...readLedger(), [fingerprint]: { ...record, event: created.id } }, { newline: true });
    return created;
  } finally { activeCreates.delete(fingerprint); }
}

commands({
  calendar_status: () => ({ desktop: host().available, accounts: providersForSession().flatMap((provider) => provider.accounts()) }),
  calendar_microsoft_connect: async (input: { clientId?: unknown; key?: unknown; scope?: unknown }, ctx) => {
    authorizeIntegration("modify", "user", host().available);
    return graphCalendarAuth.connect(input ?? {}, ctx.signal);
  },
  calendar_microsoft_disconnect: ({ key }: { key: string }) => graphCalendarAuth.disconnect(key),
  calendar_microsoft_cancel: () => graphCalendarAuth.cancel(),
  calendar_google_connect: (input: { key?: unknown; editing?: unknown; replaceClient?: unknown }, ctx) => {
    authorizeIntegration("modify", "user", host().available);
    return googleCalendarAuth.connect(input, ctx.signal);
  },
  calendar_google_disconnect: ({ key }: { key: string }) => googleCalendarAuth.disconnect(key),
  calendar_google_cancel: () => googleCalendarAuth.cancel(),
  calendar_list: ({ account }: { account: unknown }, ctx) => {
    const selected = resolve(account);
    return selected.provider.calendars(selected.account.key, ctx.signal);
  },
  calendar_events: async ({ account, calendar, start, end, query }: { account: unknown; calendar: unknown; start: unknown; end: unknown; query?: unknown }, ctx) => {
    const selected = resolve(account);
    const range = calendarRange(start, end);
    const search = query === undefined ? "" : text(query, "search term", 160).toLowerCase();
    const events = await selected.provider.events(selected.account.key, id(calendar), range, ctx.signal);
    return events.filter((event) => !event.cancelled && (!search || `${event.title} ${event.location} ${event.description}`.toLowerCase().includes(search))).sort((a, b) => a.start.localeCompare(b.start));
  },
  calendar_read: ({ account, calendar, event }: { account: unknown; calendar: unknown; event: unknown }, ctx) => {
    const selected = resolve(account);
    return selected.provider.read(selected.account.key, id(calendar), id(event), ctx.signal);
  },
  calendar_availability: async ({ account, calendar, start, end }: { account: unknown; calendar: unknown; start: unknown; end: unknown }, ctx) => {
    const selected = resolve(account);
    const range = calendarRange(start, end);
    const target = id(calendar);
    return selected.provider.availability
      ? selected.provider.availability(selected.account.key, target, range, ctx.signal)
      : busyTimes(await selected.provider.events(selected.account.key, target, range, ctx.signal), range);
  },
  calendar_review: async (raw: Record<string, unknown>, ctx) => {
    if (!raw || !["create", "update", "delete"].includes(String(raw.kind))) throw new Refusal("Choose a calendar action.");
    const { provider, account } = resolve(raw.account);
    const calendar = id(raw.calendar);
    const name = await reviewedTarget(provider, account, calendar, ctx.signal);
    let change: CalendarMutation;
    let previous: CalendarEvent | undefined;
    if (raw.kind === "create") change = { kind: "create", account: account.key, calendar, proposal: newEvent(raw.proposal) };
    else {
      const event = id(raw.event);
      const revision = text(raw.revision, "event revision", 1024);
      previous = await currentEvent(provider, account.key, calendar, event, revision, ctx.signal);
      change = raw.kind === "update" ? { kind: "update", account: account.key, calendar, event, revision, proposal: calendarText(raw.proposal) }
        : { kind: "delete", account: account.key, calendar, event, revision };
    }
    const now = Date.now();
    for (const [key, review] of approvals) if (review.expires <= now) approvals.delete(key);
    if (approvals.size >= 100) throw new Refusal("Cancel an existing calendar review or wait for it to expire.");
    const approval = { id: randomUUID(), change, expires: now + 300_000 };
    approvals.set(approval.id, approval);
    return { ...approval, account: account.name, calendar: name, previous };
  },
  calendar_cancel_review: ({ id }: { id: string }) => { approvals.delete(id); },
  calendar_apply: async ({ id }: { id: string }, ctx) => {
    const approval = approvals.get(id);
    if (!approval || approval.expires <= Date.now()) throw new Refusal("Review this calendar change again before applying it.");
    approvals.delete(id);
    const change = approval.change;
    const { provider, account } = resolve(change.account);
    await reviewedTarget(provider, account, change.calendar, ctx.signal);
    if (change.kind === "create") return createOnce(provider, change, ctx.signal);
    await currentEvent(provider, change.account, change.calendar, change.event, change.revision, ctx.signal);
    if (change.kind === "update") return provider.update(change.account, change.calendar, change.event, change.revision, change.proposal, ctx.signal);
    await provider.delete(change.account, change.calendar, change.event, change.revision, ctx.signal);
    return null;
  },
});
