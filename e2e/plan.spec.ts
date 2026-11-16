import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

function write(home: string, rel: string, value: object) {
  const file = path.join(home, "Phaethon", "default", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function school(home: string) {
  write(home, "spaces/school/.phaethon/space.json", { name: "School", educationEnabled: true });
}

test("the exam calendar moves keyboard focus to the day selected with arrows", async ({ page }) => {
  core = await startCore({ setup: school });
  await page.clock.setFixedTime(new Date(2026, 10, 15, 12));
  await core.open(page);
  await page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Plan/ }).click();
  await page.getByRole("button", { name: "Add exam", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add exam" });
  await form.getByRole("textbox", { name: "Name" }).fill("Keyboard test");
  await form.getByRole("button", { name: "Date", exact: true }).click();
  const today = page.getByRole("button", { name: "Sun 15 Nov", exact: true });
  await today.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Mon 16 Nov", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "Date", exact: true })).toContainText("Mon 16 Nov");

  // Moving beyond the last day renders the next month before focusing its day.
  await form.getByRole("button", { name: "Date", exact: true }).click();
  await page.getByRole("button", { name: "Mon 30 Nov", exact: true }).focus();
  // The roving date is initially the selected day, so choose the end of month first.
  await page.getByRole("button", { name: "Mon 30 Nov", exact: true }).press("Enter");
  await form.getByRole("button", { name: "Date", exact: true }).click();
  await page.getByRole("button", { name: "Mon 30 Nov", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Tue 1 Dec", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "Date", exact: true })).toContainText("Tue 1 Dec");
});

test("changing the calendar month keeps a day reachable with Tab", async ({ page }) => {
  core = await startCore({ setup: school });
  await page.clock.setFixedTime(new Date(2026, 10, 15, 12));
  await core.open(page);
  await page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Plan/ }).click();
  await page.getByRole("button", { name: "Add exam", exact: true }).click();
  await page.getByRole("dialog", { name: "Add exam" }).getByRole("button", { name: "Date", exact: true }).click();
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Tue 15 Dec", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await page.getByRole("button", { name: "Sun 31 Jan", exact: true }).click();
  await page.getByRole("dialog", { name: "Add exam" }).getByRole("button", { name: "Date", exact: true }).click();
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sun 28 Feb", exact: true })).toBeFocused();
});

test("returning to Grades and Plan reads course data updated while their tabs were hidden", async ({ page }) => {
  const course = "QA course";
  const grades = (percent: number) => ({ courses: { "canvas-qa/1": { connection: "canvas-qa", courseId: "1", course, folder: `courses/${course}`, updated: Date.now(), current: { percent }, groups: [], items: [] } } });
  const imported = (title: string) => ({ connections: [{ id: "canvas-qa", kind: "canvas", address: "https://canvas.example", signedIn: false, courses: { "1": { name: course, folder: course, files: {}, links: {}, due: [{ title, due: new Date(Date.now() + 5 * 86400_000).toISOString(), anchor: "qa" }] } } }] });
  core = await startCore({ setup: (home) => {
    school(home);
    fs.mkdirSync(path.join(home, "Phaethon", "default", "courses", course), { recursive: true });
    write(home, ".phaethon/lms.json", imported("Original deadline"));
    write(home, ".phaethon/course-access.json", { school: { "canvas-qa/1": ["overview", "assignments", "grades"] } });
    write(home, ".phaethon/grades.json", grades(80));
  } });
  await core.open(page);
  const views = page.getByRole("list", { name: "Views" });
  const gradePage = page.locator('[data-page="grades"]:not([hidden])');
  const planPage = page.locator('[data-page="plan"]:not([hidden])');
  await views.getByRole("button", { name: /^Grades/ }).click();
  await expect(gradePage).toContainText("80%");
  await views.getByRole("button", { name: /^Plan/ }).click();
  await expect(planPage).toContainText("Original deadline");
  await views.getByRole("button", { name: /^Courses/ }).click();
  // An import or background grade check replaces these shared core records.
  write(core.home, ".phaethon/lms.json", imported("Updated deadline"));
  write(core.home, ".phaethon/grades.json", grades(95));
  await views.getByRole("button", { name: /^Grades/ }).click();
  await expect(gradePage).toContainText("95%");
  await views.getByRole("button", { name: /^Plan/ }).click();
  await expect(planPage).toContainText("Updated deadline");
  await expect(planPage).not.toContainText("Original deadline");

  // Removing a space's course access also clears its previously cached records.
  await views.getByRole("button", { name: /^Courses/ }).click();
  write(core.home, ".phaethon/course-access.json", {});
  await views.getByRole("button", { name: /^Grades/ }).click();
  await expect(gradePage).toContainText("No grades here yet");
  await views.getByRole("button", { name: /^Plan/ }).click();
  await expect(planPage).toContainText("Nothing coming up");
});
