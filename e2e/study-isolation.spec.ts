import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

function fixtures(home: string) {
  const root = path.join(home, "Phaethon", "default", "spaces");
  const put = (rel: string, text: string) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const id of ["school", "other"]) put(`${id}/.phaethon/space.json`, JSON.stringify({ name: id === "school" ? "School" : "Other", educationEnabled: true }));
  put("school/study/decks/qa.md", "---\ntitle: QA cards\n---\n\nQ: What is the Amber code?\nA: 17\n");
  put("school/study/quizzes/qa.json", JSON.stringify({ title: "QA quiz", created: Date.now(), sources: [], questions: [{ id: "q1", kind: "truefalse", prompt: "The Amber code is 17.", answer: true, explanation: "The test notes say 17." }] }));
}

test("a hidden flashcard session does not respond to keys on another page", async ({ page }) => {
  core = await startCore({ setup: fixtures });
  await core.open(page);
  await page.getByRole("button", { name: "Go to School", exact: true }).click();
  const views = page.getByRole("list", { name: "Views" });
  await views.getByRole("button", { name: /^Study/ }).click();
  await page.getByRole("button", { name: "QA cards", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Show answer/ })).toBeVisible();
  await views.getByRole("button", { name: /^Plan/ }).click();
  await page.getByRole("heading", { name: "Nothing coming up" }).click();
  await page.keyboard.press("Space");
  await page.locator('[role="tab"][data-tab="view:school/study"]').click();
  await expect(page.getByRole("button", { name: /^Show answer/ })).toBeVisible();
  // The same key still works when this session is visible.
  await page.getByText("What is the Amber code?", { exact: true }).click();
  await page.keyboard.press("Space");
  await expect(page.getByRole("group", { name: "How well did you know it?" })).toBeVisible();
});

test("a hidden quiz does not answer a question from keys on another page", async ({ page }) => {
  core = await startCore({ setup: fixtures });
  await core.open(page);
  await page.getByRole("button", { name: "Go to School", exact: true }).click();
  const views = page.getByRole("list", { name: "Views" });
  await views.getByRole("button", { name: /^Study/ }).click();
  await page.getByRole("button", { name: "QA quiz", exact: true }).click();
  await expect(page.getByRole("radio", { name: /True/ })).not.toBeChecked();
  await views.getByRole("button", { name: /^Plan/ }).click();
  await page.getByRole("heading", { name: "Nothing coming up" }).click();
  await page.keyboard.press("1");
  await page.locator('[role="tab"][data-tab="view:school/study"]').click();
  await expect(page.getByRole("radio", { name: /True/ })).not.toBeChecked();
  await page.getByTestId("quiz-question").getByText("The Amber code is 17.", { exact: true }).click();
  await page.keyboard.press("1");
  await expect(page.getByRole("radio", { name: /True/ })).toBeChecked();
});

test("retapping Study in another space keeps the first space's session", async ({ page }) => {
  core = await startCore({ setup: fixtures });
  await core.open(page);
  await page.getByRole("button", { name: "Go to School", exact: true }).click();
  const study = page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Study/ });
  await study.click();
  await page.getByRole("button", { name: "QA cards", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Show answer/ })).toBeVisible();
  await page.getByRole("button", { name: "Go to Other", exact: true }).click();
  await study.click();
  await expect(page.getByRole("heading", { name: "Nothing to study yet" })).toBeVisible();
  await study.click();
  await page.locator('[role="tab"][data-tab="view:school/study"]').click();
  await expect(page.getByRole("button", { name: /^Show answer/ })).toBeVisible();
});
