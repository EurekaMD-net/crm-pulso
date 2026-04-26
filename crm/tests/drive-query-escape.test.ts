/**
 * B2 — Drive query injection regression tests
 *
 * Drive's `q` query language uses single-quoted string literals with
 * backslash as the escape character. Unescaped single quotes break out of
 * the literal and let an attacker rewrite the query (e.g. drop `trashed =
 * false`, broaden scope to other folders). Mexican surnames like O'Brien
 * are valid input — the fix must escape, not reject.
 */

import { describe, expect, it } from "vitest";
import { escapeDriveQueryString } from "../src/workspace/google/files.js";

describe("escapeDriveQueryString", () => {
  it("passes through plain ASCII unchanged", () => {
    expect(escapeDriveQueryString("hello world")).toBe("hello world");
  });

  it("escapes single quotes (the apostrophe surname case)", () => {
    expect(escapeDriveQueryString("O'Brien")).toBe("O\\'Brien");
  });

  it("escapes backslashes BEFORE quotes (avoids double-escape)", () => {
    // Order matters. If we escaped quotes first, then backslashes, the
    // backslash we add to escape the quote would itself get re-escaped,
    // turning `O'Brien` into `O\\\\'Brien` instead of `O\\'Brien`.
    expect(escapeDriveQueryString("a\\b")).toBe("a\\\\b");
    expect(escapeDriveQueryString("O\\'Brien")).toBe("O\\\\\\'Brien");
  });

  it("neutralizes injection payloads that try to break out of the literal", () => {
    // Without escaping, this collapses `'fullText contains 'X'' or trashed
    // = true and 'Y'` and exposes trashed files. With escaping the
    // single-quote is data, not delimiter.
    const payload = "X' or trashed = true and 'Y";
    const escaped = escapeDriveQueryString(payload);
    expect(escaped).toBe("X\\' or trashed = true and \\'Y");
    // Round-tripped into the q context: `fullText contains '${escaped}'`
    // — Drive sees one literal containing the whole payload as text.
    const wrapped = `fullText contains '${escaped}'`;
    // No unescaped single-quote remains in the value portion.
    const valueStart = wrapped.indexOf("'") + 1;
    const valueEnd = wrapped.lastIndexOf("'");
    const value = wrapped.slice(valueStart, valueEnd);
    // Every `'` inside the value is preceded by `\`.
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "'") {
        expect(value[i - 1]).toBe("\\");
      }
    }
  });

  it("handles empty string", () => {
    expect(escapeDriveQueryString("")).toBe("");
  });

  it("preserves Unicode (Mexican accented names)", () => {
    expect(escapeDriveQueryString("Núñez")).toBe("Núñez");
    expect(escapeDriveQueryString("D'Ávila")).toBe("D\\'Ávila");
  });
});
