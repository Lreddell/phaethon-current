// node --test scripts/unit/
import assert from "node:assert/strict";
import { test } from "node:test";

import { citationOf, citationsIn, citeName, markCitations } from "../../src/lib/study-cite.ts";

const CS101 = "courses/CS 101 Fall 2026 (All Sections)";

test("a citation becomes a link that carries it, and back", () => {
  const text = `Test 1 stops at Problem set 6 [source: ${CS101}/announcements.md "Test 1 will not cover series or sequences."].`;
  const md = markCitations(text);
  assert.match(md, /^Test 1 stops at Problem set 6 \[announcements\.md\]\(#phaethon-cite:[^)\s]+\)\.$/);
  const href = /\((#phaethon-cite:[^)]+)\)/.exec(md)![1];
  assert.deepEqual(citationOf(href), { path: `${CS101}/announcements.md`, quote: "Test 1 will not cover series or sequences." });
  assert.equal(citationOf("#other"), null);
  assert.equal(citationOf(undefined), null);
  assert.equal(citeName(`${CS101}/files/Notes/Lecture Notes.pdf`), "Lecture Notes.pdf");
});

test("curly quotes, math and brackets in a quote survive; code is left alone", () => {
  const q = "A function $f$ is *injective* if f(x) = f(y) implies x = y";
  const text = [
    `See [source: ${CS101}/files/Notes.pdf “${q}”] and also`,
    "```",
    `[source: ${CS101}/files/Notes.pdf "inside a fence stays code"]`,
    "```",
    `and \`[source: x.md "inline code stays code too"]\` here.`,
  ].join("\n");
  const found = citationsIn(text);
  assert.deepEqual(found, [{ path: `${CS101}/files/Notes.pdf`, quote: q }]);
  const md = markCitations(text);
  assert.ok(!md.split("\n")[0].includes("$f$"), "the quote's math is inside the link's address, not drawn");
  assert.ok(md.includes('[source: x.md "inline code stays code too"]') && md.includes("inside a fence stays code"));
});

test("a citation still being written stays text; text without any is unchanged", () => {
  const half = `It covers sets [source: ${CS101}/announcements.md "Test 1 will`;
  assert.equal(markCitations(half), half);
  assert.equal(markCitations("No sources here."), "No sources here.");
  assert.equal(citationsIn(`[source: a.md "two quotes" "x"]`).length, 0, "a malformed one isn't guessed at");
});
