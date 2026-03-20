# Technical Design: TOCS Financial Position Import

## Overview

This feature allows admins to import lot financial positions from a TOCS Lot Positions Report (CSV or Excel). The parser auto-detects whether the file is a standard two-column template or a full TOCS report. For TOCS reports it handles multiple fund sections and applies worst-case logic: a lot marked `in_arrear` in any fund section is recorded as `in_arrear` regardless of its position in other sections.

**Schema migration required: NO.** The `financial_position` column already exists on `LotOwner` (added by an earlier migration).

---

## Data Model

### `FinancialPosition` enum — `backend/app/models/lot_owner.py`

```python
class FinancialPosition(str, enum.Enum):
    normal   = "normal"
    in_arrear = "in_arrear"
```

This enum is stored on `LotOwner.financial_position`. Default value is `normal`.

### `FinancialPositionSnapshot` enum — `backend/app/models/general_meeting_lot_weight.py`

A parallel enum on `GeneralMeetingLotWeight.financial_position_snapshot`. Captures the lot's position at AGM creation time and is never updated by subsequent imports.

```python
class FinancialPositionSnapshot(str, enum.Enum):
    normal    = "normal"
    in_arrear = "in_arrear"
```

---

## Endpoint

### `POST /api/admin/buildings/{building_id}/lot-owners/import-financial-positions`

**File:** `backend/app/routers/admin.py`

| Field | Value |
|---|---|
| Method | `POST` |
| Auth | Admin (`require_admin` dependency on router) |
| Body | `multipart/form-data` with `file` field |
| Accepted MIME types | `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx) |
| Response | `FinancialPositionImportResult` |
| Status codes | `200` success, `404` building not found, `422` invalid file / parse errors |

**Response schema (`backend/app/schemas/admin.py`):**

```python
class FinancialPositionImportResult(BaseModel):
    updated: int   # number of lot owners whose financial_position was updated
    skipped: int   # number of rows where lot_number was not found in the building
```

The router detects the file format via `_detect_file_format(file)` and dispatches to either `import_financial_positions_from_csv` or `import_financial_positions_from_excel`.

---

## CSV Format

### Simple template format

Two columns, header row required:

| Column | Description |
|---|---|
| `Lot#` | Lot number (matches `LotOwner.lot_number`) |
| `Financial Position` | `Normal` or `In Arrear` (case-insensitive) |

**Auto-detection:** The first cell of the first line equals `lot#` (case-insensitive).

Example:
```
Lot#,Financial Position
1,Normal
2,In Arrear
3,Normal
```

### TOCS Lot Positions Report format

Exported from the TOCS management system. Contains:

- Header rows at the top (company name, address, print date, report title, strata plan name, address, financial period) — typically 8–10 lines
- One or more fund sections (e.g. "Administrative Fund", "Maintenance Fund"), each starting with a row whose first non-empty cell is `Lot#`
- 9 columns per section: `Lot#`, `Unit#`, `Owner Name`, `Opening Balance`, `Levied`, `Special Levy`, `Paid`, `Closing Balance`, `Interest Paid`
- Data rows for each lot
- Summary rows at the end of each section: `Totals`, `Arrears`, `Advances` (may be prefixed with fund name, e.g. "Administrative Fund Totals")
- Blank rows between sections

**Auto-detection:** The first cell of the first line is NOT `lot#` — the file begins with company/report header text.

---

## TOCS Report: Closing Balance Parsing

The key column for determining financial position is `Closing Balance` (column index 7 in standard TOCS layout, dynamically located from the section header row).

### CSV string format

| Cell value | Interpretation | `FinancialPosition` |
|---|---|---|
| `$-` or `$ -` or empty | Zero balance — paid up | `normal` |
| Contains `(` | Bracketed amount — credit/advance (negative) | `normal` |
| Any other value (e.g. `$1,882.06`) | Positive amount — arrears outstanding | `in_arrear` |

### Excel numeric format

xlsx files exported from TOCS store `Closing Balance` as Python `int`/`float`:

| Value | `FinancialPosition` |
|---|---|
| `<= 0` | `normal` (zero = paid up; negative = credit) |
| `> 0` | `in_arrear` |

Mixed representations within the same file are handled: a cell may be a native numeric OR a currency string (e.g. if the xlsx was originally a CSV import).

---

## Multi-Section Worst-Case Logic

For TOCS reports the parser accumulates results across all fund sections using worst-case logic:

1. For each fund section, iterate data rows between the `Lot#` header and the first blank row or summary row.
2. For each lot row, parse `Closing Balance` → `FinancialPosition`.
3. Compare against any previously recorded position for that lot number:
   - If no prior record → store the result.
   - If prior record is `normal` and new result is `in_arrear` → upgrade to `in_arrear`.
   - If prior record is `in_arrear` → keep `in_arrear` regardless of new result.
4. After all sections are processed, emit one `{lot_number, financial_position_raw}` dict per lot.

This means: **a lot in arrears in any single fund is treated as `in_arrear` overall.**

---

## Parsing Pipeline

### CSV path

```
_parse_financial_position_csv_rows(content: bytes)
  ├── first_cell == "lot#"  →  _parse_simple_financial_position_csv_rows(content)
  └── otherwise             →  _parse_tocs_financial_position_csv_rows(content)
```

Both return `list[dict]` where each dict is `{lot_number: str, financial_position_raw: str}`.

### Excel path

```
_parse_financial_position_excel_rows(content: bytes)
  ├── first non-empty cell of row 0 == "lot#"
  │     AND row 0 contains "financial position"  →  simple template logic (inline)
  └── first non-empty cell of row 0 != "lot#"   →  _parse_tocs_financial_position_excel_rows(all_rows)
```

### Common persist step

```
import_financial_positions(building_id, rows, db)
```

1. Validate all `financial_position_raw` values via `_parse_financial_position_import`. Collect errors; raise 422 with all errors listed if any are invalid.
2. Load all `LotOwner` records for the building into a `{lot_number: LotOwner}` map.
3. For each row: if `lot_number` not found → increment `skipped`; else update `lot_owner.financial_position` and increment `updated`.
4. Commit.

`_parse_financial_position_import` accepts `"normal"` → `FinancialPosition.normal` and `"in arrear"` / `"in_arrear"` → `FinancialPosition.in_arrear` (case-insensitive). Returns `None` on empty string; raises `ValueError` on unrecognised value.

---

## Example File

`examples/Lot financial position.csv` — a TOCS Lot Positions Report for "The Vale" (strata plan PS624534G).

- Company header: "Top Owners Corporation Solutions Pty Ltd"
- Report period: 01/03/2026 to 10/03/2026
- One visible fund section starting at line 13: Administrative Fund
- 9 columns: `Lot#`, `Unit#`, `Owner Name`, `Opening Balance`, `Levied`, `Special Levy`, `Paid`, `Closing Balance`, `Interest Paid`
- Closing Balance examples:
  - `$-` → `normal`
  - `$(190.77)` → `normal` (credit/advance)
  - `$1,882.06` → `in_arrear`

Use this file as the primary test fixture for TOCS-format import tests.

---

## Key Design Decisions

### Worst-case across sections
A lot in arrears in the Administrative Fund but paid up in the Maintenance Fund is recorded as `in_arrear`. The body corporate cannot vote weighted by a lot that owes money to any fund.

### Unknown lots are skipped, not errored
If the TOCS report contains a lot number not present in the building (e.g. the report covers a wider strata plan than the AGM building), it is silently skipped and counted in `skipped`. This allows partial imports without blocking on out-of-scope data.

### Validation is all-or-nothing
All rows are validated before any DB write. If any row has an invalid `financial_position_raw` value, the entire import is rejected with a 422 listing all offending rows. This prevents partial updates that could leave the building in an inconsistent state.

### `AGMLotWeight.financial_position_snapshot` is a snapshot
The import updates `LotOwner.financial_position` (live value). The snapshot column on `GeneralMeetingLotWeight` is only set at AGM creation time and is never modified by subsequent imports. An import after an AGM is created does not affect that AGM's vote eligibility calculations.

---

## Files Modified

| File | Change |
|---|---|
| `backend/app/models/lot_owner.py` | Defines `FinancialPosition` enum and `LotOwner.financial_position` column |
| `backend/app/models/general_meeting_lot_weight.py` | Defines `FinancialPositionSnapshot` enum |
| `backend/app/schemas/admin.py` | `FinancialPositionImportResult` response schema |
| `backend/app/services/admin_service.py` | All parse helpers and `import_financial_positions*` service functions |
| `backend/app/routers/admin.py` | `POST /buildings/{building_id}/lot-owners/import-financial-positions` endpoint |
| `examples/Lot financial position.csv` | Example TOCS report used as test fixture |
