import type { CalendarAccount, CalendarBusy, CalendarEvent, CalendarInfo, CalendarNewEvent, CalendarProviderId, CalendarRange, CalendarText } from "../../shared/calendar.ts";

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  accounts(): CalendarAccount[];
  calendars(account: string, signal?: AbortSignal): Promise<CalendarInfo[]>;
  events(account: string, calendar: string, range: CalendarRange, signal?: AbortSignal): Promise<CalendarEvent[]>;
  availability?(account: string, calendar: string, range: CalendarRange, signal?: AbortSignal): Promise<CalendarBusy[]>;
  read(account: string, calendar: string, event: string, signal?: AbortSignal): Promise<CalendarEvent>;
  create(account: string, calendar: string, event: CalendarNewEvent, operation: string, signal?: AbortSignal): Promise<CalendarEvent>;
  update(account: string, calendar: string, event: string, revision: string, edit: CalendarText, signal?: AbortSignal): Promise<CalendarEvent>;
  delete(account: string, calendar: string, event: string, revision: string, signal?: AbortSignal): Promise<void>;
}
