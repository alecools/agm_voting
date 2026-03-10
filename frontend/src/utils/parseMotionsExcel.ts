import * as XLSX from "xlsx";
import type { MotionFormEntry } from "../components/admin/MotionEditor";

export type ParseSuccess = { motions: MotionFormEntry[] };
export type ParseError = { errors: string[] };
export type ParseResult = ParseSuccess | ParseError;

export async function parseMotionsExcel(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    header: 1,
    defval: null,
  }) as unknown[][];

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

  const missingErrors: string[] = [];
  if (motionColIdx === -1) missingErrors.push("Missing required column: Motion");
  if (descColIdx === -1) missingErrors.push("Missing required column: Description");
  if (missingErrors.length > 0) return { errors: missingErrors };

  const rowErrors: string[] = [];
  const motionNumbers: number[] = [];
  const motionEntries: Array<{ order: number; title: string }> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const rowNum = i; // 1-based data row number

    const motionCell = row[motionColIdx];
    const descCell = row[descColIdx];

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
      const descIsEmpty =
        descCell === null || descCell === undefined || String(descCell).trim() === "";
      if (descIsEmpty) {
        rowErrors.push(`Row ${rowNum}: Description is empty`);
      } else {
        motionEntries.push({ order: motionValue, title: String(descCell) });
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
    description: "",
  }));

  return { motions };
}
