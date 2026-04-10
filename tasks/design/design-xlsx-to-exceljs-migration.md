# Design: xlsx to exceljs Migration

**Status:** Implemented

---

## Overview

The `xlsx` (SheetJS community edition) npm package, currently used to parse motion import files (Excel and CSV), carries two unpatched HIGH-severity CVEs:

- **GHSA-4r6h-8v6p-xvw6** — Prototype Pollution (CVSS 7.8)
- **GHSA-5pgg-2g8v-p4x9** — ReDoS (CVSS 7.5)

SheetJS community edition is effectively unmaintained. This design replaces it with `exceljs` (v4.4.0), an actively maintained alternative under the MIT licence, in the one place `xlsx` is used: `frontend/src/utils/parseMotionsExcel.ts`.

The backend is unaffected — it uses Python's `openpyxl` package, which is separate and has no known CVEs.

---

## Root Cause / Background

`xlsx@0.18.5` is the current production dependency. The two CVEs exist in the parsing path (`XLSX.read`) that `parseMotionsExcel.ts` calls for every file upload. Because parsing runs in the user's browser, the ReDoS risk is constrained to the user's own tab, but the prototype pollution risk could affect downstream code that trusts parsed output objects.

`exceljs` exposes a `Workbook` class that reads `.xlsx` files. It does not natively auto-detect and parse CSV files the way SheetJS does — this is the main API gap that must be bridged (see Technical Design below).

---

## Technical Design

### Database changes

None.

### Backend changes

None. The backend uses `openpyxl` (Python), not the npm `xlsx` package.

### Frontend changes

#### Package changes

- Remove: `xlsx` from `dependencies` in `frontend/package.json`
- Add: `exceljs` to `dependencies` in `frontend/package.json` (latest: `4.4.0`)

#### `frontend/src/utils/parseMotionsExcel.ts`

This is the only file in the codebase that imports `xlsx`. The entire parsing entry point must change. The current API usage is:

| SheetJS call | Purpose |
|---|---|
| `await import("xlsx")` | Dynamic import to avoid loading ~650 KB for voter-flow users |
| `XLSX.read(buffer, { type: "array" })` | Parse a buffer into a workbook; handles both `.xlsx` and `.csv` transparently |
| `XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })` | Flatten the first worksheet into a row-major array where each row is an array of raw cell values; sparse cells filled with `null` |

The `exceljs` equivalents:

| ExcelJS call | Purpose |
|---|---|
| `await import("exceljs")` | Dynamic import — same lazy-loading pattern preserved |
| `new ExcelJS.Workbook()` | Create a workbook instance |
| `workbook.xlsx.load(buffer)` | Load an `.xlsx` buffer; returns a Promise |
| `worksheet.getRow(rowNumber).values` | Returns a 1-indexed sparse array (`values[0]` is always `undefined`; data starts at `values[1]`) |

**CSV support gap.** SheetJS auto-detects CSV via `XLSX.read`. ExcelJS has no built-in CSV reader — `workbook.xlsx.load()` throws on CSV content. CSV must be handled separately before calling ExcelJS.

The existing function accepts both `.csv` and `.xlsx/.xls` files (the `accept` attribute on the file input is `.csv,text/csv,.xlsx,.xls`). This must be preserved.

**Proposed approach — file-type branch before ExcelJS:**

```
if file.name ends with .csv (or file.type === text/csv):
    read the buffer as UTF-8 text
    split into lines, parse each line as comma-separated values
    build the same row[][] structure that ExcelJS would produce
else:
    use exceljs Workbook.xlsx.load(buffer) to read the workbook
    extract rows from worksheet using getRow()
```

The CSV path is a simple naive parser: split lines on `\n`, split each line on `,`, trim whitespace. This is sufficient because the only CSV use case is the motion import template which has plain text cells with no quoted commas or embedded newlines. The existing `examples/AGM Motion test.xlsx` template has a CSV version (`/agm_motions_template.csv`) referenced by the Download template link — its content is simple.

After both paths produce the same `rows: unknown[][]` structure (0-indexed, same as what `sheet_to_json({ header: 1 })` returned), the rest of `parseMotionsExcel.ts` — column detection, row validation, duplicate checking, sorting — is unchanged.

**ExcelJS row extraction detail.** `worksheet.getRow(n).values` returns a 1-indexed array (index 0 is always `undefined`). The utility must slice off index 0:

```typescript
const row = worksheet.getRow(n).values as (unknown)[];
// row[0] === undefined always; data is at row[1], row[2], ...
const dataRow = row.slice(1);   // shift to 0-based matching the current shape
```

ExcelJS also uses `worksheet.rowCount` to iterate over rows (1-based). Empty trailing rows may be returned; the existing blank-row skip logic in `parseMotionsExcel.ts` already handles this.

#### `frontend/src/utils/__tests__/parseMotionsExcel.test.ts`

The test file currently mocks the `xlsx` module directly:

```typescript
import * as XLSX from "xlsx";
vi.mock("xlsx");
const mockedXLSX = vi.mocked(XLSX);
// setupMockSheetData sets mockedXLSX.read and mockedXLSX.utils.sheet_to_json
```

After migration this must become a mock of `exceljs`. The new mock strategy:

1. `vi.mock("exceljs")` — mock the module
2. Expose a mock `Workbook` class whose instance has:
   - `xlsx.load`: async function that resolves without error
   - `worksheets[0]`: an object with `rowCount` and `getRow(n)` that returns synthetic row data
3. `setupMockSheetData(rows: unknown[][])` becomes a helper that configures the mock worksheet to return those rows (converting from 0-based to 1-based indexing, since `getRow(n).values` is 1-indexed)

The CSV path does not use ExcelJS at all. Tests that exercise CSV parsing must instead rely on the real CSV branch (providing a CSV `File` whose buffer decodes to real CSV text), or mock the `file.arrayBuffer` to return a UTF-8 encoded buffer of CSV content. Since the CSV parser is pure string manipulation, no mocking is needed for CSV tests — they can pass real CSV content.

The test for "XLSX.read was called with type: 'array'" (currently asserting SheetJS-specific call signature) must be updated to assert the equivalent ExcelJS fact — either that `workbook.xlsx.load` was called with an `ArrayBuffer`, or that the correct rows were returned (which is implied by the existing result assertion).

**All other test logic — every assertion about `ParseResult` shape, error messages, motion ordering, column detection, blank row handling, duplicate detection — is identical and needs no change.** Only the mock setup wiring changes.

#### `frontend/vite.config.ts`

The comment on line 18 currently reads:

> `// xlsx is NOT listed here — it is pulled in only via dynamic imports`

This comment must be updated to reference `exceljs` instead of `xlsx`.

#### No changes needed

- `frontend/src/components/admin/MotionExcelUpload.tsx` — imports `parseMotionsExcel` dynamically from `../../utils/parseMotionsExcel`; the public interface of that function does not change
- `frontend/src/components/admin/__tests__/MotionExcelUpload.test.tsx` — mocks `../../../utils/parseMotionsExcel` (not `xlsx` directly); no changes needed
- `frontend/src/pages/admin/SettingsPage.tsx` — does not use `xlsx` at all
- `frontend/src/pages/admin/__tests__/SettingsPage.test.tsx` — does not use `xlsx` at all
- All other `__tests__` files that appear in the grep results — they contain `.xlsx` only as a file extension string in `new File(...)` constructor calls, not as an import of the `xlsx` package
- `frontend/src/api/__tests__/admin.test.ts` — same; `.xlsx` appears only as a file extension string

### Key design decisions

**Why ExcelJS over alternatives?**
ExcelJS is the most widely adopted maintained alternative to SheetJS for browser + Node environments, has no known CVEs, and is MIT-licensed. Other candidates (`xlsx-js-style`, `read-excel-file`) have smaller ecosystems or different API shapes.

**Why keep dynamic import?**
The dynamic `import("exceljs")` pattern is preserved so the ExcelJS bundle is only fetched when an admin actually triggers the motion import UI. ExcelJS is approximately 1.4 MB unminified (smaller after tree-shaking and compression). Voter-flow bundle size is unaffected.

**Why a separate CSV branch instead of a CSV-capable library?**
The CSV use case is extremely constrained: a two-to-four column template with no embedded commas, no quoted fields, no multi-line cells. Pulling in a full CSV parsing library (e.g. `papaparse`) solely for this would add another dependency. A ten-line naive splitter is sufficient and eliminates the dependency entirely.

**Why 0-based row normalisation inside the helper?**
All downstream logic in `parseMotionsExcel.ts` was written against 0-based row arrays (what `sheet_to_json({ header: 1 })` returned). Rather than rewrite every index expression, the adapter normalises ExcelJS's 1-based output into the same 0-based shape at the point of extraction. This is the smallest-diff migration path.

### Data flow

1. Admin selects a `.csv` or `.xlsx` file via the motion import UI in `MotionExcelUpload.tsx`
2. `MotionExcelUpload` calls `parseMotionsExcel(file)` (dynamically imported)
3. `parseMotionsExcel` calls `file.arrayBuffer()` to get raw bytes
4. **Branch A (CSV):** detected by `file.name.endsWith('.csv')` or `file.type === 'text/csv'`; buffer decoded as UTF-8 text; lines split by `\n`; each line split by `,`; result is `unknown[][]`
5. **Branch B (Excel):** `new ExcelJS.Workbook()` created; `workbook.xlsx.load(buffer)` called; rows extracted from `workbook.worksheets[0]` using `getRow(n).values.slice(1)` for each row 1..`rowCount`; result is `unknown[][]`
6. Both branches produce the same `rows: unknown[][]` shape
7. Remaining logic (header detection, column validation, row iteration, error collection, sorting) is unchanged
8. `ParseResult` returned to `MotionExcelUpload`, which either calls `onMotionsLoaded` or displays errors

---

## Security Considerations

This change eliminates two HIGH-severity CVEs (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9) present in the `xlsx` package. No new security surface is introduced:

- No new endpoints
- No new credentials or secrets
- Input validation (column presence, row content) is unchanged
- ExcelJS does not have known prototype pollution or ReDoS issues at v4.4.0
- The CSV parser added is a trivial string splitter with no regex, eliminating ReDoS risk entirely for the CSV path

---

## Files to Change

| File | Change |
|------|--------|
| `frontend/package.json` | Remove `xlsx`; add `exceljs@^4.4.0` to `dependencies` |
| `frontend/src/utils/parseMotionsExcel.ts` | Replace SheetJS API calls with ExcelJS API; add CSV branch for `.csv` files |
| `frontend/src/utils/__tests__/parseMotionsExcel.test.ts` | Replace `vi.mock("xlsx")` mock wiring with `vi.mock("exceljs")` mock; update `setupMockSheetData` helper; update the one SheetJS-specific call-signature assertion |
| `frontend/vite.config.ts` | Update comment referencing `xlsx` to reference `exceljs` |

---

## Test Cases

### Unit / Integration

All existing test cases in `parseMotionsExcel.test.ts` must continue to pass with identical assertions. The test changes are confined to the mock-wiring boilerplate at the top of the file and the `setupMockSheetData` helper.

Additional test cases to add or verify after migration:

- **ExcelJS happy path (.xlsx):** mock `workbook.xlsx.load` and `getRow()` to return a valid 2-row sheet; assert `ParseResult` shape is correct
- **CSV happy path (.csv):** pass a real CSV `File` whose `arrayBuffer()` resolves to UTF-8 bytes of `"Motion,Description\n1,My Motion"`; assert correct `ParseResult` without any ExcelJS mock
- **CSV with CRLF line endings:** `"Motion,Description\r\n1,My Motion\r\n"`; assert CRLF is stripped correctly so cells are not padded with `\r`
- **CSV file with `.csv` extension but mismatched MIME type:** `file.name.endsWith('.csv')` triggers the CSV path regardless of `file.type`
- **ExcelJS `workbook.xlsx.load` rejection:** assert that a thrown error from ExcelJS propagates as a caught error (handled by `MotionExcelUpload`'s try/catch)
- **Dynamic import of `exceljs` fails:** `mockParse.mockRejectedValue(...)` in `MotionExcelUpload.test.tsx` already covers the chunk-load-failure path — no change needed there

### E2E

The motion import E2E flow (admin uploads an Excel file and sees motions populated in the form) is covered by existing E2E specs. No new E2E scenarios are required — the external behaviour of the upload UI is unchanged. The `examples/AGM Motion test.xlsx` fixture remains valid.

---

## Schema Migration Required

No

---

## E2E Test Scenarios

### Happy path

- Admin navigates to Create AGM, clicks "Import motions from CSV or Excel", uploads `examples/AGM Motion test.xlsx` — motions are populated correctly in the motion editor

### Error / edge cases

- Upload a CSV file (`/agm_motions_template.csv`) — same result as xlsx
- Upload a malformed file (e.g. a `.txt` renamed to `.xlsx`) — ExcelJS throws; MotionExcelUpload shows "Failed to load the file parser. Please try again."

### Existing E2E specs affected

The admin persona journey ("login → building/meeting management") touches the Create AGM form which includes the motion import UI. Any E2E spec that exercises motion import via file upload must remain passing. No spec logic needs to change — the file format and UI behaviour are identical post-migration.

---

## Vertical slice decomposition

This feature is frontend-only and contained in a single utility file plus its test. It is a single indivisible slice — no backend work, no DB work, no parallel decomposition needed.
