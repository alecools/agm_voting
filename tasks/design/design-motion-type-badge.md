# Design: Motion Type Badge

## Overview

A small pill badge is displayed alongside each motion to indicate whether it is a General or Special resolution. The badge appears in three places: the voter `MotionCard` component, the admin meeting detail page (motions table), and the admin AGM report view (per-motion result cards). An additional "Hidden" badge is shown in the admin report whenever a motion's `is_visible` flag is false.

No database schema changes. The `motion_type` field already exists on the `Motion` model (`"general"` | `"special"`). No new backend endpoints.

---

## Motion types

`MotionType` is defined in `frontend/src/types/index.ts`:

```ts
export type MotionType = "general" | "special";
```

Values correspond to the backend Python enum. The frontend uses the string values directly.

---

## Badge CSS classes

```css
.motion-type-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 999px;
}

.motion-type-badge--general {
  background: var(--neutral-100, #f1f5f9);
  color: var(--text-muted, #64748b);
  border: 1px solid var(--border, #e2e8f0);
}

.motion-type-badge--special {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
}

.motion-type-badge--hidden {
  background: var(--text-muted, #888);
  color: #fff;
  padding: 2px 8px;
}
```

- **General**: neutral grey pill (light grey background, muted text, subtle border)
- **Special**: amber/yellow pill (light yellow background, dark amber text, yellow border) — visually distinct to signal the higher voting threshold
- **Hidden**: solid grey pill with white text — only shown in admin views

---

## Where badges appear

### 1. Voter `MotionCard` (`frontend/src/components/vote/MotionCard.tsx`)

Each motion card renders a type badge in its top row, next to the "Motion N" label:

```tsx
const isSpecial = motion.motion_type === "special";

<span
  className={`motion-type-badge${isSpecial ? " motion-type-badge--special" : " motion-type-badge--general"}`}
  aria-label={`Motion type: ${isSpecial ? "Special" : "General"}`}
>
  {isSpecial ? "Special" : "General"}
</span>
```

No "Hidden" badge here — hidden motions are excluded from the voter API response by the backend.

### 2. Admin meeting detail page (`frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`)

The motions table has a "Motion Type" column. Each row renders:

```tsx
<span
  className={`motion-type-badge motion-type-badge--${motion.motion_type}`}
  aria-label={`Motion type: ${motion.motion_type === "special" ? "Special" : "General"}`}
>
  {motion.motion_type === "special" ? "Special" : "General"}
</span>
```

The CSS modifier is applied directly from the `motion_type` string value (`motion-type-badge--general` or `motion-type-badge--special`).

The admin can also set motion type via a `<select>` in the add-motion and edit-motion inline forms. Options are `"general"` and `"special"`.

### 3. Admin AGM report view (`frontend/src/components/admin/AGMReportView.tsx`)

Each per-motion result card header shows both the type badge and an optional "Hidden" badge:

```tsx
<span
  className={`motion-type-badge${motion.motion_type === "special" ? " motion-type-badge--special" : " motion-type-badge--general"}`}
  aria-label={`Motion type: ${motion.motion_type === "special" ? "Special" : "General"}`}
>
  {motion.motion_type === "special" ? "Special" : "General"}
</span>
{!motion.is_visible && (
  <span className="motion-type-badge motion-type-badge--hidden" aria-label="Motion is hidden from voters">
    Hidden
  </span>
)}
```

The "Hidden" badge only appears in the admin report view — it signals to the admin that this motion is currently not visible to voters.

---

## Data flow

`motion_type` flows from the backend through these response types:

| Type | File | Usage |
|---|---|---|
| `MotionOut` | `frontend/src/api/voter.ts` | Voter-facing motion in `fetchMotions` response |
| `MotionDetail` | `frontend/src/api/admin.ts` | Admin report view; includes `tally` and `voter_lists` |
| `MotionSummary` | `frontend/src/api/admin.ts` | Admin meeting detail motions table |
| `PublicMotionOut` | `frontend/src/api/public.ts` | Public summary page |

All four types carry `motion_type: MotionType`.

---

## Files changed

| File | Change |
|---|---|
| `frontend/src/styles/index.css` | Added `.motion-type-badge`, `.motion-type-badge--general`, `.motion-type-badge--special`, `.motion-type-badge--hidden` |
| `frontend/src/components/vote/MotionCard.tsx` | Added type badge in `.motion-card__top-row` |
| `frontend/src/components/admin/AGMReportView.tsx` | Added type badge and "Hidden" badge in `admin-card__header` |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Added "Motion Type" column with badge in motions table; added `motion_type` field to add/edit motion forms |

---

## No backend changes

`motion_type` was already stored in the database and returned by all existing motion API responses. No migrations or endpoint changes are needed.
