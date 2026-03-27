import { describe, it, expect } from "vitest";
import { formatLocalDateTime } from "../dateTime";

describe("formatLocalDateTime", () => {
  // --- Happy path ---

  it("formats a valid UTC ISO string using default options", () => {
    const result = formatLocalDateTime("2025-06-01T10:00:00Z");
    // The exact format depends on the locale, but it should contain year and
    // a time component.  We test that it is a non-empty string.
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Should include the year 2025.
    expect(result).toContain("2025");
  });

  it("formats a non-UTC ISO string correctly", () => {
    // An ISO string with timezone offset should still produce output.
    const result = formatLocalDateTime("2025-12-15T14:30:00+10:00");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  // --- Boundary values ---

  it("returns empty string for null input", () => {
    expect(formatLocalDateTime(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(formatLocalDateTime(undefined)).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(formatLocalDateTime("")).toBe("");
  });

  // --- Custom format options ---

  it("uses custom Intl.DateTimeFormatOptions when provided", () => {
    // Request only the year — numeric year should appear
    const result = formatLocalDateTime("2025-06-01T10:00:00Z", { year: "numeric" });
    expect(result).toContain("2025");
  });

  it("uses custom options that include only month and day", () => {
    const result = formatLocalDateTime("2025-06-15T10:00:00Z", {
      month: "long",
      day: "numeric",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  // --- Edge cases ---

  it("handles a DST boundary date without throwing", () => {
    // Australian DST transition: clocks go back on first Sunday in April.
    // This should not throw regardless of the local timezone.
    expect(() => formatLocalDateTime("2025-04-06T02:00:00+11:00")).not.toThrow();
  });

  it("default options produce dateStyle medium and timeStyle short format", () => {
    // The default should include both a date and a time component.
    // We check this heuristically: the output should contain at least one digit
    // from a time (colon-separated) and a year.
    const result = formatLocalDateTime("2025-06-01T10:00:00Z");
    // Contains a colon for the time portion
    expect(result).toMatch(/:/);
    expect(result).toContain("2025");
  });
});
