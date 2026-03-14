# PRD: Excel Motion Import and Public AGM Summary Page

## Introduction

Meeting hosts currently enter AGM motions manually one by one during AGM creation. This feature adds two capabilities:

1. **Excel motion import:** At AGM creation time, the host can upload an Excel file to pre-fill the motion list. The host can review and edit the pre-filled motions before saving the AGM.
2. **Public AGM summary page:** Each AGM has a dedicated, publicly accessible page showing the meeting title, date, and list of motions. This page is printable and shareable — no login required, no voting functionality.

---

## Goals

- Reduce data-entry effort for hosts creating AGMs with many motions
- Provide a standard Excel template so hosts know the expected format
- Show all import errors upfront so the host can fix the file before retrying
- Give lot owners (and the general public) a clean, printable page summarising what will be voted on

---

## User Stories

### US-013: Download CSV/Excel template for motion import
**Description:** As a meeting host, I want to download a pre-formatted template so I know exactly how to structure my motions file before uploading.

**Acceptance Criteria:**
- [ ] A "Download template" link is visible on the AGM creation form
- [ ] Clicking the link downloads a file named `agm_motions_template.csv`
- [ ] The downloaded file contains one header row with columns: `Motion`, `Title`, `Motion Type`, `Description`
- [ ] The file contains two example data rows (one general, one special) to illustrate the expected format
- [ ] Typecheck/lint passes

### US-014: Upload CSV/Excel file to pre-fill motions on AGM creation form
**Description:** As a meeting host, I want to upload a CSV or Excel file during AGM creation so that the motions list is pre-filled without manual entry.

**Acceptance Criteria:**
- [ ] The AGM creation form includes a file input labelled "Upload motions (CSV or Excel)"
- [ ] The file input accepts `.csv`, `.xlsx`, and `.xls` files
- [ ] After a valid file is selected, the motions list on the form is populated with rows parsed from the file
- [ ] Each row in the file becomes one motion entry using the following column mapping (all column names are case-insensitive):
  - `Motion` (required) → motion order index
  - `Description` (required) → motion description when `Title` column is present; used as the motion title when `Title` column is absent (backwards-compatible 2-column format)
  - `Title` (optional) → motion title; if blank, falls back to `Description` as title
  - `Motion Type` (optional) → `"general"` or `"special"` (case-insensitive); defaults to `"general"` when absent or unrecognised
- [ ] Files with only `Motion` + `Description` columns (old 2-column format) continue to work without errors
- [ ] Motions are displayed in ascending `Motion` order
- [ ] The host can edit, reorder, add, or delete any pre-filled motion before saving
- [ ] No data is saved to the database until the host submits the form
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-015: Display all Excel validation errors before import
**Description:** As a meeting host, I want to see every error in my uploaded Excel file at once so I can fix them all before re-uploading.

**Acceptance Criteria:**
- [ ] If the uploaded file has any validation errors, the motions list is NOT pre-filled
- [ ] All errors are displayed in a visible error summary before the form fields
- [ ] Each error message identifies the row number and the specific problem (e.g. "Row 3: order_number is missing", "Row 5: motion_description is empty")
- [ ] The following conditions are treated as errors:
  - Missing `order_number` or `motion_description` column headers
  - Empty `motion_description` on any row
  - Missing or non-numeric `order_number` on any row
  - Duplicate `order_number` values within the file
- [ ] The host can fix the file and re-upload without reloading the page
- [ ] Rows with no data (completely blank rows) are silently skipped — not treated as errors
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-016: Public AGM summary page
**Description:** As a lot owner or interested party, I want to view a public summary page for an AGM so I can review the motions before or during the meeting without logging in.

**Acceptance Criteria:**
- [ ] A new public route exists at `/agm/:agmId/summary`
- [ ] The page displays: AGM title, building name, meeting date/time (formatted in local timezone), and the ordered list of motions (order number + description)
- [ ] The page requires no authentication — accessible by anyone with the URL
- [ ] If the AGM ID does not exist, the page shows a "Meeting not found" message
- [ ] The page has a print-friendly layout: when printed, navigation and action buttons are hidden
- [ ] The page title in the browser tab is `[AGM title] — AGM Summary`
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-017: Share AGM summary page link from admin portal
**Description:** As a meeting host, I want to easily copy the shareable link for an AGM's summary page so I can distribute it to lot owners.

**Acceptance Criteria:**
- [ ] The AGM detail view in the admin portal shows a "Share summary page" button or link
- [ ] Clicking it copies the full URL of the `/agm/:agmId/summary` page to the clipboard
- [ ] A brief confirmation message ("Link copied!") is shown after copying
- [ ] The link is also displayed as a clickable URL so the host can open or inspect it
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

### US-018: Backend endpoint for AGM public summary
**Description:** As a developer, I need a public API endpoint returning AGM summary data so the frontend summary page can fetch it without authentication.

**Acceptance Criteria:**
- [ ] `GET /api/agm/:agmId/summary` returns: `agm_id`, `title`, `status`, `meeting_at`, `voting_closes_at`, `building_name`, and an ordered array of motions (each with `order_index`, `title`, `description`)
- [ ] The endpoint requires no authentication token
- [ ] Returns 404 if the AGM does not exist
- [ ] Returns data for both `open` and `closed` AGMs
- [ ] Unit tests cover: valid AGM, non-existent AGM, AGM with zero motions, AGM with multiple motions in correct order
- [ ] Typecheck/lint passes

---

## Functional Requirements

- **FR-16:** The AGM creation form must include a file input that accepts `.xlsx` and `.xls` files only.
- **FR-17:** When a valid Excel file is uploaded, the frontend parses it client-side (no server round-trip for parsing) and pre-fills the motion rows on the form.
- **FR-18:** The import file must contain at minimum two columns: `Motion` (integer) and `Description` (non-empty string). Column names are case-insensitive. Two additional optional columns are supported: `Title` (string) and `Motion Type` (`"general"` or `"special"`). When `Title` is present it is used as the motion title and `Description` becomes the full description text. When `Title` is absent the file is treated as the old 2-column format: `Description` is used as the motion title and `description` is set to an empty string. `Motion Type` defaults to `"general"` when absent or unrecognised.
- **FR-19:** If any validation error is found in the uploaded file, display all errors in a summary at the top of the upload section. Do not partially pre-fill the form.
- **FR-20:** Completely blank rows in the Excel file are silently skipped during parsing.
- **FR-21:** After pre-filling, the host retains full ability to edit, add, or remove motions before saving the AGM.
- **FR-22:** A downloadable Excel template (`agm_motions_template.xlsx`) must be available from the AGM creation form.
- **FR-23:** A new public endpoint `GET /api/agm/:agmId/summary` returns AGM title, building name, meeting datetime, voting close datetime, and ordered motions list. No auth required.
- **FR-24:** A new public frontend route `/agm/:agmId/summary` renders the AGM summary page using data from FR-23.
- **FR-25:** The summary page must be print-friendly: non-content elements (nav bars, buttons) hidden via CSS `@media print`.
- **FR-26:** The admin portal AGM detail view must show a "Share summary page" control that copies the summary URL to the clipboard.

---

## Non-Goals

- No server-side Excel parsing — parsing is performed entirely in the browser
- No Excel export of existing motions from the database
- No support for file formats other than `.xlsx` and `.xls`
- No voting or vote submission on the public summary page
- No authentication or access control on the public summary page
- No editing of motions after the AGM has been saved (AGM immutability rule, FR-11, still applies)
- No support for uploading Excel at AGM edit time (upload is available at creation time only)
- No multi-sheet Excel support — only the first sheet is read

---

## Design Considerations

- The Excel upload UI sits within the existing AGM creation form, below the AGM title/date fields and above the manual motion entry rows
- Pre-filled motion rows replace (not append to) any motions already entered manually
- The error summary uses the existing error alert style (role="alert") used elsewhere in the app
- The public summary page uses a minimal layout — no sidebar, no navigation bar — suitable for printing on a single page
- Motion list on the summary page is a numbered list matching `order_index`

---

## Technical Considerations

- Use the `xlsx` (SheetJS) npm package for client-side Excel parsing — it is MIT-licensed and handles both `.xlsx` and `.xls`
- The downloadable template is a static file served from the frontend's `public/` directory, generated once with SheetJS during build or committed as a binary
- `GET /api/agm/:agmId/summary` is added to `backend/app/routers/public.py` alongside the existing public endpoints
- The endpoint performs a JOIN between `AGM`, `Building`, and `Motion` tables to return all required fields in one query
- Print styles are scoped to the summary page component via a `<style>` block or a dedicated CSS module with `@media print`
- Clipboard copy uses the `navigator.clipboard.writeText` API with a fallback to `document.execCommand('copy')` for older browsers

---

## Success Metrics

- Host can go from Excel file to saved AGM with motions in under 2 minutes
- Zero manual motion re-entry required when the Excel file is valid
- Summary page URL can be opened in an incognito window (no session) and renders correctly
- Print preview of summary page shows only title, date, and motions — no nav elements

---

## Open Questions

- Should the summary page show the AGM status (open/closed)? Recommended: yes, as a badge, so voters know whether voting is still active.
- Should the motion `title` field be separate from `description` in the Excel, or are they the same column? Currently the PRD treats `motion_description` as filling both — clarify before implementation.
