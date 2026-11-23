export type CalendarProviderId = "microsoft" | "google";
export type CalendarAccount = { key: string; provider: CalendarProviderId; name: string; email: string; canWrite: boolean };
export type CalendarInfo = { id: string; name: string; canEdit: boolean; primary: boolean };
export type CalendarRange = { start: string; end: string };
export type CalendarBusy = CalendarRange & { status: "busy" | "tentative" | "away" };
export type CalendarKind = "single" | "series" | "occurrence" | "exception";
export type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  originalStartZone?: string;
  originalEndZone?: string;
  allDay: boolean;
  kind: CalendarKind;
  seriesId?: string;
  cancelled: boolean;
  busy: CalendarBusy["status"] | "free";
  revision?: string;
  editable: boolean;
};
export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type CalendarText = { title: string; location: string; description: string };
export type CalendarNewEvent = CalendarText & CalendarRange & { recurrence?: { day: Weekday; until: string } };
export type CalendarMutation =
  | { kind: "create"; account: string; calendar: string; proposal: CalendarNewEvent }
  | { kind: "update"; account: string; calendar: string; event: string; revision: string; proposal: CalendarText }
  | { kind: "delete"; account: string; calendar: string; event: string; revision: string };
