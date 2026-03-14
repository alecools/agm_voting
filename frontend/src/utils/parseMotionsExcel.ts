import * as XLSX from "xlsx";
import type { MotionFormEntry } from "../components/admin/MotionEditor";
import type { MotionType } from "../types";

export type ParseSuccess = { motions: MotionFormEntry[] };
export type ParseError = { errors: string[] };
export type ParseResult = ParseSuccess | ParseError;

function parseMotionType(raw: unknown): MotionType {
  if (raw === null || raw === undefined) return "general";
  const s = String(raw).trim().toLowerCase();
  if (s === "special") return "special";
  return "general";
}

/**
 * Parse motions from an uploaded file.
 *
 * Accepts CSV (.csv) and Excel (.xlsx / .xls) files. The xlsx library
 * (SheetJS) auto-detects the file format from the buffer contents, so no
 * special handling is required to support CSV — `XLSX.read` handles both.
 *
 * Required columns (case-insensitive): Motion, Description
 * Optional columns:
 *   - Title: when present, used as the motion title; Description becomes the
 *     full description text. When absent, Description is used as the title
 *     (backwards-compatible with the old 2-column format).
 *   - Motion Type: "General" or "Special" (case-insensitive); defaults to
 *     "general" when absent or unrecognised.
 *
 * Backwards compatibility: files with only Motion + Description columns
 * (old 2-column format) continue to work — Description is used as the title
 * and description is set to empty string.
 */
export async function parseMotionsExcel(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
  });

  if (rows.length === 0) {
    return { errors: ["Missing required column: Motion", "Missing required column: Description"] };
  }

  // Find header row (first row)
  const headerRow = rows[0] as unknown[];
  const headers = headerRow.map((h) =>
    h != null ? String(h).toLowerCase().trim() : ""
  );

  const motionColIdx = headers.findIndex((h) => h === "motion");
  const descColIdx = headers.findIndex((h) => h === "description");
  const titleColIdx = headers.findIndex((h) => h === "title");
  const motionTypeColIdx = headers.findIndex((h) => h === "motion type");

  const missingErrors: string[] = [];
  if (motionColIdx === -1) missingErrors.push("Missing required column: Motion");
  if (descColIdx === -1) missingErrors.push("Missing required column: Description");
  if (missingErrors.length > 0) return { errors: missingErrors };

  // Whether file uses new 4-column format (Title column present) or old 2-column format
  const hasTitleColumn = titleColIdx !== -1;

  const rowErrors: string[] = [];
  const motionNumbers: number[] = [];
  const motionEntries: Array<{
    order: number;
    title: string;
    description: string;
    motion_type: MotionType;
  }> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const rowNum = i; // 1-based data row number

    const motionCell = row[motionColIdx];
    const descCell = row[descColIdx];
    const titleCell = hasTitleColumn ? row[titleColIdx] : null;
    const motionTypeCell = motionTypeColIdx !== -1 ? row[motionTypeColIdx] : null;

    // Skip completely blank rows
    const allBlank = row.every(
      (cell) => cell === null || cell === undefined || String(cell).trim() === ""
    );
    if (allBlank) continue;

    // Validate Motion cell
    const motionIsEmpty =
      motionCell === null || motionCell === undefined || String(motionCell).trim() === "";
    const motionValue = Number(motionCell);
    if (motionIsEmpty || isNaN(motionValue)) {
      rowErrors.push(`Row ${rowNum}: Motion must be a number`);
    } else {
      motionNumbers.push(motionValue);

      if (hasTitleColumn) {
        // New 4-column format: Title column present
        // Determine title: use Title cell if non-blank, else fall back to Description
        const titleIsEmpty =
          titleCell === null || titleCell === undefined || String(titleCell).trim() === "";
        const descIsEmpty =
          descCell === null || descCell === undefined || String(descCell).trim() === "";

        const resolvedTitle = !titleIsEmpty ? String(titleCell) : (!descIsEmpty ? String(descCell) : null);
        const resolvedDescription = !descIsEmpty ? String(descCell) : "";

        if (resolvedTitle === null) {
          rowErrors.push(`Row ${rowNum}: Description is empty`);
        } else {
          motionEntries.push({
            order: motionValue,
            title: resolvedTitle,
            description: resolvedDescription,
            motion_type: parseMotionType(motionTypeCell),
          });
        }
      } else {
        // Old 2-column format: no Title column — Description becomes the title
        const descIsEmpty =
          descCell === null || descCell === undefined || String(descCell).trim() === "";
        if (descIsEmpty) {
          rowErrors.push(`Row ${rowNum}: Description is empty`);
        } else {
          motionEntries.push({
            order: motionValue,
            title: String(descCell),
            description: "",
            motion_type: parseMotionType(motionTypeCell),
          });
        }
      }
    }

  }

  // Check for duplicate Motion numbers
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const n of motionNumbers) {
    if (seen.has(n)) duplicates.add(n);
    seen.add(n);
  }
  for (const n of Array.from(duplicates).sort((a, b) => a - b)) {
    rowErrors.push(`Duplicate Motion number: ${n}`);
  }

  if (rowErrors.length > 0) return { errors: rowErrors };

  motionEntries.sort((a, b) => a.order - b.order);
  const motions: MotionFormEntry[] = motionEntries.map((e) => ({
    title: e.title,
    description: e.description,
    motion_type: e.motion_type,
  }));

  return { motions };
}
