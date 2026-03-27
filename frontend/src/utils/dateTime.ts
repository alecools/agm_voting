/**
 * Format an ISO 8601 date-time string for display in the browser's local timezone.
 *
 * @param isoString - ISO 8601 date-time string (e.g. "2025-06-01T10:00:00Z")
 * @param options - Optional Intl.DateTimeFormatOptions to override the default format.
 *                  Defaults to { dateStyle: "medium", timeStyle: "short" }.
 * @returns Formatted date-time string, or empty string if input is falsy.
 */
export function formatLocalDateTime(
  isoString: string | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!isoString) return "";
  const fmt = options ?? { dateStyle: "medium", timeStyle: "short" };
  return new Intl.DateTimeFormat(undefined, fmt).format(new Date(isoString));
}
