import type { CalendarAccount, CalendarEvent, CalendarInfo, CalendarMutation } from "../src/shared/calendar";
import { expect, openSettings, startCore, test, type Core } from "./core";

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test("calendar settings require review before creating and deleting events", async ({ page }) => {
  const account: CalendarAccount = { key: "fixture-account", provider: "microsoft", name: "Example", email: "me@example.invalid", canWrite: true };
  const calendar: CalendarInfo = { id: "fixture-calendar", name: "Personal calendar", canEdit: true, primary: true };
  let events: CalendarEvent[] = [];
  let reviewed: CalendarMutation | undefined;
  let applied = 0;
  const responses: Record<string, (args: Record<string, unknown>) => unknown> = {
    calendar_status: () => ({ desktop: false, accounts: [account] }),
    calendar_list: () => [calendar],
    calendar_events: () => events,
    calendar_read: () => events[0],
    calendar_availability: () => events.map(({ start, end }) => ({ start, end, status: "busy" })),
    calendar_review: (args) => {
      reviewed = args as CalendarMutation;
      return { id: "one-time-review", change: reviewed, account: account.name, calendar: calendar.name, previous: events[0] };
    },
    calendar_cancel_review: () => { reviewed = undefined; return null; },
    calendar_apply: ({ id }) => {
      expect(id).toBe("one-time-review");
      if (!reviewed) throw new Error("Review missing");
      if (reviewed.kind === "create") {
        events = [{ ...reviewed.proposal, id: "new-event", kind: "single", allDay: false, cancelled: false, busy: "busy", editable: true, revision: '"test"' }];
      } else if (reviewed.kind === "delete") events = [];
      applied++;
      reviewed = undefined;
      return events[0] ?? null;
    },
  };
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      const respond = responses[request.cmd];
      if (request.t === "req" && respond) socket.send(JSON.stringify({ t: "ok", id: request.id, value: respond(request.args) }));
      else server.send(message);
    });
  });
  core = await startCore();
  await core.open(page);
  await openSettings(page, "Calendar");
  await page.getByRole("combobox", { name: "Calendar account" }).click();
  await page.getByRole("option", { name: account.email }).click();
  await page.getByRole("combobox", { name: "Calendar", exact: true }).click();
  await page.getByRole("option", { name: calendar.name }).click();
  await page.getByRole("button", { name: "New event" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Fixture appointment");
  await page.getByRole("button", { name: "Review change" }).click();
  await expect(page.getByRole("heading", { name: "Create this calendar event?" })).toBeVisible();
  expect(applied).toBe(0);
  await page.getByRole("button", { name: "Apply to calendar" }).click();
  await expect(page.getByText("Fixture appointment", { exact: true })).toBeVisible();
  expect(applied).toBe(1);

  await page.getByRole("button", { name: "Busy times" }).click();
  await expect(page.getByText("Busy times (UTC)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await page.getByRole("button", { name: "Review deletion" }).click();
  await expect(page.getByRole("heading", { name: "Delete this calendar event?" })).toBeVisible();
  expect(applied).toBe(1);
  await page.getByRole("dialog").filter({ hasText: "Delete this calendar event?" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Fixture appointment" })).toBeVisible();
  await page.getByRole("button", { name: "Review deletion" }).click();
  await page.getByRole("button", { name: "Delete event" }).click();
  await expect(page.getByText("No matching events in this date range.")).toBeVisible();
  expect(applied).toBe(2);
});
