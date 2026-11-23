import { useState } from "react";
import type { CalendarAccount, CalendarBusy, CalendarEvent, CalendarInfo, CalendarMutation, CalendarNewEvent, CalendarText } from "#shared/calendar";
import { cleanMessage, FieldError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { invoke } from "@/lib/core";
import { useQuery } from "@/lib/query";
import { ConfirmDialog, EmptyRow, Loader, Row, SettingsGroup, useLoad } from "../ui";
import { SmallSelect } from "./shared";

type CalendarStatus = { desktop: boolean; accounts: CalendarAccount[] };
type Review = { id: string; change: CalendarMutation; account: string; calendar: string; previous?: CalendarEvent };
const loadStatus = () => invoke<CalendarStatus>("calendar_status");
const startDay = (days = 0) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const display = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const dayStart = (input: string) => `${input}T00:00:00Z`;

function MicrosoftConnection({ view, reload }: { view: CalendarStatus; reload: () => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [pending, setPending] = useState<"sign-in" | "other" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<CalendarAccount | null>(null);
  const change = async (kind: NonNullable<typeof pending>, task: () => Promise<unknown>) => {
    setError(null);
    setPending(kind);
    try { await task(); await reload(); }
    catch (reason) { setError(cleanMessage(reason)); }
    finally { setPending(null); }
  };
  const connect = (args: Record<string, unknown>) => change("sign-in", () => invoke("calendar_microsoft_connect", args));
  return (
    <>
      <SettingsGroup label="Microsoft Calendar">
        {view.accounts.filter((account) => account.provider === "microsoft").map((account) => (
          <Row key={account.key} label={account.name} description={`${account.email} · ${account.canWrite ? "Read and edit" : "Read only"}`}>
            <Button size="xs" variant="outline" disabled={pending !== null} onClick={() => void connect({ key: account.key })}>Reconnect</Button>
            {!account.canWrite ? <Button size="xs" variant="outline" disabled={pending !== null} onClick={() => void connect({ key: account.key, scope: "Calendars.ReadWrite" })}>Enable editing</Button> : null}
            <Button size="xs" variant="ghost-muted" disabled={pending !== null} onClick={() => setDisconnect(account)}>Disconnect</Button>
          </Row>
        ))}
        {view.desktop ? (
          <Row label="Desktop application ID" description="Use your Entra registration with delegated calendar permissions and the loopback redirect URI http://localhost/oauth/callback.">
            <Input size="sm" aria-label="Microsoft Calendar application ID" className="w-44" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={pending !== null} />
            <Button size="xs" variant="outline" disabled={pending !== null || !clientId.trim()} onClick={() => void connect({ clientId })}>Connect</Button>
          </Row>
        ) : <EmptyRow>Connect an account in the Phaethon desktop app.</EmptyRow>}
        {pending === "sign-in" ? <Row label="Finish sign-in in your browser"><Button size="xs" variant="outline" onClick={() => void invoke("calendar_microsoft_cancel")}>Cancel sign-in</Button></Row> : null}
        {error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
      </SettingsGroup>
      <ConfirmDialog open={disconnect !== null} onOpenChange={(open) => { if (!open) setDisconnect(null); }} title={`Disconnect ${disconnect?.name ?? "calendar account"}?`} confirm="Disconnect"
        onConfirm={() => { if (disconnect) void change("other", () => invoke("calendar_microsoft_disconnect", { key: disconnect.key })); setDisconnect(null); }}>
        <p>This removes the local calendar connection.</p>
      </ConfirmDialog>
    </>
  );
}

type Fields = CalendarText & { start: string; end: string; until: string };
const emptyFields = (): Fields => ({ title: "", location: "", description: "", start: `${startDay()}T09:00`, end: `${startDay()}T10:00`, until: "" });

function CalendarBrowser({ accounts }: { accounts: CalendarAccount[] }) {
  const [accountId, setAccountId] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [start, setStart] = useState(startDay());
  const [end, setEnd] = useState(startDay(14));
  const [filter, setFilter] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [viewing, setViewing] = useState<CalendarEvent | null>(null);
  const [edit, setEdit] = useState<{ event?: CalendarEvent; fields: Fields } | null>(null);
  const [availability, setAvailability] = useState<CalendarBusy[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((item) => item.key === accountId);
  const calendars = useQuery(account ? ["calendar:list", account.key] : null, () => invoke<CalendarInfo[]>("calendar_list", { account: account?.key }));
  const calendar = calendars.data?.find((item) => item.id === calendarId);
  const range = { start: dayStart(start), end: dayStart(end) };
  const scope = { account: account?.key, calendar: calendar?.id };
  const query = useQuery(account && calendar && start && end && end > start ? ["calendar:events", account.key, calendar.id, start, end] : null,
    () => invoke<CalendarEvent[]>("calendar_events", { ...scope, ...range }));
  const canEdit = account?.canWrite === true && calendar?.canEdit === true;
  const lower = filter.trim().toLowerCase();
  const events = query.data?.filter((event) => !lower || `${event.title} ${event.location} ${event.description}`.toLowerCase().includes(lower)) ?? [];

  const run = async (task: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try { await task(); }
    catch (reason) { setError(cleanMessage(reason)); }
    finally { setBusy(false); }
  };
  const propose = (payload: Record<string, unknown>) => run(async () => setReview(await invoke<Review>("calendar_review", { ...scope, ...payload })));
  const fill = (field: keyof Fields, value: string) => setEdit((draft) => draft ? { ...draft, fields: { ...draft.fields, [field]: value } } : null);
  const reviewEdit = () => {
    if (!edit) return;
    const { fields, event } = edit;
    const changes = { title: fields.title, location: fields.location, description: fields.description };
    if (event) void propose({ kind: "update", event: event.id, revision: event.revision, proposal: changes });
    else {
      const proposal: Partial<CalendarNewEvent> = { ...changes, start: `${fields.start}Z`, end: `${fields.end}Z` };
      void propose({ kind: "create", proposal: { ...proposal, ...(fields.until ? { recurrence: { until: fields.until } } : {}) } });
    }
  };
  const reset = () => { setError(null); setAvailability(null); setViewing(null); setEdit(null); };

  return (
    <>
      <SettingsGroup label="Calendar events" action={calendar && canEdit ? <Button size="xs" variant="outline" disabled={busy} onClick={() => { reset(); setEdit({ fields: emptyFields() }); }}>New event</Button> : null}>
        <Row label="Account">
          <SmallSelect value={accountId} label="Calendar account" disabled={busy} options={[{ value: "", label: "Choose account" }, ...accounts.map((entry) => ({ value: entry.key, label: entry.email }))]}
            onChange={(key) => { reset(); setAccountId(key); setCalendarId(""); }} />
        </Row>
        {account ? (
          <Row label="Calendar" description={calendars.error ? cleanMessage(calendars.error) : undefined}>
            <SmallSelect value={calendarId} label="Calendar" disabled={busy || calendars.loading} options={[{ value: "", label: "Choose calendar" }, ...(calendars.data ?? []).map((item) => ({ value: item.id, label: item.name }))]}
              onChange={(key) => { reset(); setCalendarId(key); }} />
          </Row>
        ) : null}
        {calendar ? (
          <>
            <Row label="Date range (UTC)" description="The end date is excluded.">
              <Input type="date" aria-label="Calendar start date" size="sm" value={start} onChange={(e) => { setAvailability(null); setStart(e.target.value); }} />
              <Input type="date" aria-label="Calendar end date" size="sm" value={end} onChange={(e) => { setAvailability(null); setEnd(e.target.value); }} />
            </Row>
            <Row label="Find events">
              <Input size="sm" aria-label="Search calendar events" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <Button size="xs" variant="outline" disabled={busy || !start || !end || end <= start} onClick={() => void run(async () => setAvailability(await invoke<CalendarBusy[]>("calendar_availability", { ...scope, ...range })))}>Busy times</Button>
              <Button size="xs" variant="ghost-muted" onClick={() => void query.reload()}>Refresh</Button>
            </Row>
            {query.error ? <EmptyRow>{cleanMessage(query.error)}</EmptyRow> : null}
            {!events.length ? <EmptyRow>{query.loading ? "Loading events…" : "No matching events in this date range."}</EmptyRow> : null}
            {events.map((event) => (
              <Row key={event.id} label={event.title || "Untitled event"} description={`${display(event.start)} UTC${event.allDay ? " · All day" : ""}${event.kind !== "single" ? " · Recurring" : ""}`}>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(async () => setViewing(await invoke<CalendarEvent>("calendar_read", { ...scope, event: event.id })))}>Details</Button>
              </Row>
            ))}
          </>
        ) : null}
        {!edit && error ? <div className="px-3 py-2"><FieldError>{error}</FieldError></div> : null}
      </SettingsGroup>
      {availability ? <SettingsGroup label="Busy times (UTC)">{availability.length ? availability.map((item, i) => <Row key={`${item.start}-${i}`} label={`${display(item.start)} – ${display(item.end)}`} description={item.status} />) : <EmptyRow>No busy times in this range.</EmptyRow>}</SettingsGroup> : null}
      <Dialog open={viewing !== null} onOpenChange={(open) => { if (!open) setViewing(null); }}>
        <DialogPopup>
          <DialogHeader><DialogTitle>{viewing?.title || "Event details"}</DialogTitle></DialogHeader>
          {viewing ? <DialogPanel className="space-y-2 text-sm">
            <p>{display(viewing.start)} – {display(viewing.end)} UTC</p>
            {viewing.originalStartZone ? <p>Original time zone {viewing.originalStartZone}{viewing.originalEndZone && viewing.originalEndZone !== viewing.originalStartZone ? ` to ${viewing.originalEndZone}` : ""}</p> : null}
            {viewing.location ? <p>{viewing.location}</p> : null}
            {viewing.description ? <p className="max-h-48 overflow-auto whitespace-pre-wrap">{viewing.description}</p> : null}
            {canEdit && !viewing.editable ? <p className="text-muted-foreground">Edit this event in your calendar app.</p> : null}
            <FieldError>{error}</FieldError>
          </DialogPanel> : null}
          {viewing?.editable && canEdit ? <DialogFooter>
            <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => void propose({ kind: "delete", event: viewing.id, revision: viewing.revision })}>Review deletion</Button>
            <Button size="sm" disabled={busy} onClick={() => { setEdit({ event: viewing, fields: { ...emptyFields(), title: viewing.title, location: viewing.location, description: viewing.description } }); setViewing(null); }}>Edit details</Button>
          </DialogFooter> : null}
        </DialogPopup>
      </Dialog>
      <Dialog open={edit !== null} onOpenChange={(open) => { if (!open && !busy) setEdit(null); }}>
        <DialogPopup>
          <DialogHeader><DialogTitle>{edit?.event ? "Edit event details" : "New calendar event"}</DialogTitle></DialogHeader>
          <DialogPanel className="grid gap-3">
            <Label htmlFor="calendar-title">Title</Label><Input id="calendar-title" value={edit?.fields.title ?? ""} maxLength={250} onChange={(e) => fill("title", e.target.value)} />
            {!edit?.event ? <>
              <Label htmlFor="calendar-start">Starts (UTC)</Label><Input id="calendar-start" type="datetime-local" value={edit?.fields.start ?? ""} onChange={(e) => fill("start", e.target.value)} />
              <Label htmlFor="calendar-end">Ends (UTC)</Label><Input id="calendar-end" type="datetime-local" value={edit?.fields.end ?? ""} onChange={(e) => fill("end", e.target.value)} />
              <Label htmlFor="calendar-until">Repeat weekly until (optional)</Label><Input id="calendar-until" type="date" value={edit?.fields.until ?? ""} onChange={(e) => fill("until", e.target.value)} />
            </> : null}
            <Label htmlFor="calendar-location">Location</Label><Input id="calendar-location" value={edit?.fields.location ?? ""} maxLength={200} onChange={(e) => fill("location", e.target.value)} />
            <Label htmlFor="calendar-description">Description</Label><Textarea id="calendar-description" rows={3} value={edit?.fields.description ?? ""} maxLength={10_000} onChange={(e) => fill("description", e.target.value)} />
            <FieldError>{error}</FieldError>
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button>
            <Button size="sm" pending={busy} disabled={!edit?.fields.title.trim()} onClick={reviewEdit}>Review change</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={review !== null} onOpenChange={(open) => {
        if (!open && review) { void invoke("calendar_cancel_review", { id: review.id }).catch(() => {}); setReview(null); }
      }}>
        <DialogPopup className="max-w-md">
          <DialogHeader><DialogTitle>{review?.change.kind === "delete" ? "Delete this calendar event?" : review?.change.kind === "update" ? "Save these event changes?" : "Create this calendar event?"}</DialogTitle></DialogHeader>
          {review ? <DialogPanel className="space-y-2 text-sm">
          <p>{review.account} · {review.calendar}</p>
          <p>{review.change.kind === "delete" ? review.previous?.title : review.change.proposal.title}</p>
          {review.change.kind === "create" ? <p>{display(review.change.proposal.start)} – {display(review.change.proposal.end)} UTC{review.change.proposal.recurrence ? ` · Weekly until ${review.change.proposal.recurrence.until}` : ""}</p> : null}
          {review.change.kind !== "delete" && review.change.proposal.location ? <p>{review.change.proposal.location}</p> : null}
          {review.change.kind !== "delete" && review.change.proposal.description ? <p className="max-h-36 overflow-auto whitespace-pre-wrap">{review.change.proposal.description}</p> : null}
          </DialogPanel> : null}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => {
              if (!review) return;
              void invoke("calendar_cancel_review", { id: review.id }).catch(() => {});
              setReview(null);
            }}>Cancel</Button>
            <Button size="sm" variant={review?.change.kind === "delete" ? "destructive" : "default"} disabled={!review || busy} onClick={() => {
              if (!review) return;
              setReview(null);
              void run(async () => { await invoke("calendar_apply", { id: review.id }); reset(); await query.reload(); });
            }}>{review?.change.kind === "delete" ? "Delete event" : "Apply to calendar"}</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function CalendarSection() {
  const status = useLoad(loadStatus, [], "calendar:status");
  return (
    <Loader state={status} errorTitle="Couldn’t load calendar connections">
      {(view) => <><MicrosoftConnection view={view} reload={status.reload} />{view.accounts.length ? <CalendarBrowser accounts={view.accounts} /> : null}</>}
    </Loader>
  );
}
