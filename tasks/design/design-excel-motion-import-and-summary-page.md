# Technical Design: CSV/Excel Motion Import and General Meeting Summary Page

## Overview

This document describes the as-built implementation of two features added to the AGM Voting App:

1. **CSV/Excel motion import** — during AGM creation, the admin can upload a CSV or Excel file to pre-fill the motion list. Parsing happens entirely client-side with no server round-trip. The host can review and edit pre-filled motions before submitting the creation form.
2. **Public General Meeting summary page** — a publicly accessible, print-friendly page at `/general-meeting/:meetingId/summary` showing meeting metadata and the ordered list of motions. No authentication required.

The "Share voting link" control in the admin portal (US-017) was also implemented as part of this feature set.

---

## Motion Import

### Backend

No backend changes were made for motion import. Parsing is performed entirely in the browser. Motions are submitted to the existing `POST /api/admin/general-meetings` endpoint as part of the standard AGM creation payload — the same as if the host had entered them manually. Each motion in the payload carries `title`, `description` (nullable), `order_index` (0-based integer assigned by the form), and `motion_type` (`"general"` or `"special"`).

### Frontend — Parsing utility

**File:** `frontend/src/utils/parseMotionsExcel.ts`

Uses the `xlsx` (SheetJS) npm package. `XLSX.read` auto-detects whether the buffer is CSV or a binary Excel format, so the same code path handles `.csv`, `.xlsx`, and `.xls`.

Only the first sheet of a workbook is read.

**Column mapping (all names case-insensitive):**

| File column | Maps to | Notes |
|---|---|---|
| `Motion` (required) | `order_index` (sort key) | Must be a non-empty number; non-numeric is a row error |
| `Description` (required) | `title` or `description` | Role depends on whether a title column is present — see below |
| `Title` or `Agenda Item` (optional) | `title` | When present, `Description` becomes the full description text; when absent, `Description` is used as the title (2-column backwards-compatible mode) |
| `Motion Type` (optional) | `motion_type` | Case-insensitive `"special"` → `special`; anything else (including absent) → `"general"` |

**2-column backwards-compatible mode:** When neither `Title` nor `Agenda Item` appears in the header, the file is treated as the old format: `Description` is used as the motion title and `description` is set to empty string `""`.

**4-column mode:** When `Title` or `Agenda Item` is present, the title is resolved as: Title cell if non-blank, otherwise Description cell if non-blank, otherwise a row error is raised.

**Blank rows:** Rows where every cell is null/empty are silently skipped.

**Validation errors (all collected before returning):**

- Missing required column headers (`Motion`, `Description`) — returned immediately without processing rows
- Non-numeric or empty `Motion` cell on a non-blank row
- Empty description on a non-blank row (both format modes)
- Duplicate `Motion` numbers — reported after per-row validation

On any error the function returns `{ errors: string[] }` and no motions are produced. On success it returns `{ motions: MotionFormEntry[] }` sorted ascending by the `Motion` column value. The returned `MotionFormEntry[]` objects contain `title`, `description`, and `motion_type` — `order_index` is not included because the form assigns sequential 0-based indices at submission time.

**Return types:**

```typescript
export type ParseSuccess = { motions: MotionFormEntry[] };
export type ParseError  = { errors: string[] };
export type ParseResult = ParseSuccess | ParseError;
```

### Frontend — Upload component

**File:** `frontend/src/components/admin/MotionExcelUpload.tsx`

A single-prop component:

```typescript
interface MotionExcelUploadProps {
  onMotionsLoaded: (motions: MotionFormEntry[]) => void;
}
```

Renders a hidden `<input type="file" accept=".csv,text/csv,.xlsx,.xls">` triggered by a visible button labelled "Import motions from CSV or Excel". While parsing is in progress the button label changes to "Parsing..." and the input is disabled.

On a valid parse result, `onMotionsLoaded` is called with the parsed motions, which replaces (not appends to) the existing motion list in the parent form.

On a parse error, an `role="alert"` error div is rendered beneath the button containing a `<ul>` with one `<li>` per error message. The motions list is not modified.

The component also renders a "Download template" `<a href="/agm_motions_template.csv" download>` link aligned to the right of the button row.

### Frontend — Integration in AGM creation form

**File:** `frontend/src/components/admin/CreateGeneralMeetingForm.tsx`

`MotionExcelUpload` is rendered between the date/time fields and `MotionEditor`. The `onMotionsLoaded` callback calls `setMotions(loaded)`, replacing the entire motion array. The host can then use `MotionEditor` to add, edit, or remove any of the pre-filled motions before submitting.

No data is written to the database until the host clicks "Create General Meeting".

### Template download

**File:** `frontend/public/agm_motions_template.csv`

A static CSV file committed to the repository and served directly by Vite/the frontend host from the `public/` directory (no build step). The file uses the 4-column format:

```
Motion,Agenda Item,Motion Type,Description
1,Appointment of AGM Chairperson,general,Resolve to appoint a chairperson for the meeting
2,Confirmation of Previous AGM Minutes,general,Confirm the minutes of the Annual General Meeting held 20 November 2024
3,Special Resolution — Rule Amendment,special,Resolve to amend Rule 5.2 of the Owners Corporation rules
```

Note: the PRD specified `agm_motions_template.xlsx` (Excel); the implementation uses a CSV file (`agm_motions_template.csv`). The file input and parser both accept CSV, so the template is fully functional.

---

## Public Summary Page

### Backend

**File:** `backend/app/routers/public.py`

**Endpoint:** `GET /api/general-meeting/{general_meeting_id}/summary`

No authentication required. Performs three sequential queries:

1. Fetch `GeneralMeeting` by UUID — 404 if not found.
2. Fetch `Building` by `meeting.building_id`.
3. Fetch all `Motion` rows for the meeting, ordered by `order_index` ascending.

Returns `GeneralMeetingSummaryOut`:

```python
class MotionSummaryOut(BaseModel):
    order_index: int
    title: str
    description: str | None
    motion_type: MotionType   # "general" | "special"

class GeneralMeetingSummaryOut(BaseModel):
    general_meeting_id: uuid.UUID
    building_id: uuid.UUID
    title: str
    status: str               # effective status string
    meeting_at: datetime
    voting_closes_at: datetime
    building_name: str
    motions: list[MotionSummaryOut]
```

`status` is derived via `get_effective_status(meeting)` — the same helper used elsewhere — so a meeting whose `voting_closes_at` has passed but has not been explicitly closed still returns `"closed"`. Returns data for both open and closed meetings.

The URL path uses `general-meeting` (singular) to match the rest of the public router. The PRD specified `/api/agm/:agmId/summary`; the implementation uses `/api/general-meeting/:agmId/summary`.

### Frontend — API client

**File:** `frontend/src/api/public.ts`

```typescript
export function getGeneralMeetingSummary(meetingId: string): Promise<GeneralMeetingSummaryData>
// calls GET /api/general-meeting/{meetingId}/summary
```

`GeneralMeetingSummaryData` mirrors `GeneralMeetingSummaryOut` with `general_meeting_id: string` and `building_id: string` (UUIDs as strings), and `motions: GeneralMeetingSummaryMotion[]` where `description` is `string | null`.

### Frontend — Summary page component

**File:** `frontend/src/pages/GeneralMeetingSummaryPage.tsx`

**Route:** `/general-meeting/:meetingId/summary` (registered in `App.tsx`, outside all auth guards — fully public)

Fetches summary data via React Query (`queryKey: ["general-meeting-summary", meetingId]`).

**Rendered content:**

- Meeting title as `<h1>`
- Building name
- Meeting date/time — `new Date(meeting.meeting_at).toLocaleString()`
- Voting closes date/time — `new Date(meeting.voting_closes_at).toLocaleString()`
- Status — plain text "Open" or "Closed" (not a badge)
- Ordered `<ol>` of motions; each item shows `order_index + 1` and `title` in bold, with `description` as a `<p>` beneath if non-empty. If no motions exist, renders "No motions listed."

**Browser tab title:** `${meeting.title} — General Meeting Summary` (set via `document.title` in a `useEffect`).

**Print styles:** An inline `<style>` block applies `@media print { .no-print { display: none !important; } }`. Elements the host wants hidden on print must carry the class `no-print`. The summary page itself has no nav or action buttons, so all its content prints.

**Error states:**

- 404 response → renders "Meeting not found"
- Other errors → renders "Failed to load meeting."
- Loading → renders "Loading..."

---

## Voting Link in Admin

**File:** `frontend/src/components/admin/ShareSummaryLink.tsx`

Rendered in `GeneralMeetingDetailPage` under the "Voting link" label in the meta section. Shown for all meeting statuses.

Constructs the URL as `window.location.origin + "/vote/" + meetingId + "/auth"` — this is the voter authentication page, not the public summary page. The component name `ShareSummaryLink` is a misnomer relative to its actual behaviour (it shares the voting link, not the summary link).

Clipboard write uses `navigator.clipboard?.writeText(url)` with a silent catch if the Clipboard API is unavailable. After the click, a toast "Link copied" is shown and dismissed via an `onAnimationEnd` callback. The URL is also rendered as a visible `<a>` that opens in a new tab.

---

## Key Design Decisions

**Client-side parsing only.** Excel/CSV parsing runs entirely in the browser using SheetJS. No server endpoint for file upload was added. This keeps the backend unchanged and avoids multipart form handling, file size limits, and server-side dependency on an Excel library. The trade-off is that the SheetJS bundle is included in the frontend build.

**Template is a static CSV, not Excel.** The PRD specified an `.xlsx` template; the implementation uses a `.csv` file. Both are accepted by the file input and the parser, and the CSV is simpler to commit and diff.

**No partial pre-fill on error.** If any validation error is found, the motions list is not modified. All errors must be resolved in the file before re-uploading.

**Import replaces, not appends.** Calling `onMotionsLoaded` sets the entire motion array. Any motions entered manually before the upload are discarded.

**Summary endpoint uses separate queries, not a JOIN.** The backend fetches `GeneralMeeting`, `Building`, and `Motion` in three sequential `await db.execute(...)` calls rather than a single JOIN. This is consistent with the rest of the codebase's style.

**`motion_type` included in summary response.** The PRD's `MotionSummaryOut` shape did not mention `motion_type`, but the implementation includes it in both the backend schema and the API client interface. It is not displayed on the public summary page.

**Summary page does not display AGM status as a badge.** The PRD open question asked whether to show status; the implementation does show it but as plain text ("Open" / "Closed"), not as a styled badge component.

---

## Data Flow

```
Admin uploads CSV/Excel file
  → MotionExcelUpload triggers parseMotionsExcel (client-side, SheetJS)
  → On success: motions array in CreateGeneralMeetingForm replaced
  → On error: errors displayed; form unchanged
  → Host edits motions via MotionEditor if needed
  → Host submits form → POST /api/admin/general-meetings (existing endpoint)
  → Motions stored in `motions` table linked to the new GeneralMeeting

Admin views meeting detail
  → ShareSummaryLink renders voter auth URL (/vote/:meetingId/auth)
  → Admin copies and shares URL with lot owners

Lot owner opens voter auth URL, authenticates, and votes

Meeting closes (manually or automatically)

Anyone opens public summary URL (/general-meeting/:meetingId/summary)
  → GET /api/general-meeting/:meetingId/summary (no auth)
  → GeneralMeetingSummaryPage renders title, building, dates, status, motions
```
