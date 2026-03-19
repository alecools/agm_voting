# AGM Voting App — Frontend Design System

This document is the authoritative reference for all frontend styling. Every new component and edit to an existing component must use the patterns documented here. Do not introduce new CSS frameworks, utility class libraries (Bootstrap, Tailwind), or inline style props for colors/spacing that have CSS variable equivalents.

Source of truth: `frontend/src/styles/index.css`

---

## 1. Color Tokens

All colors are CSS custom properties defined in `:root`. Never use hex literals directly — always reference the variable.

| Token | Value | Usage intent |
|---|---|---|
| `--navy` | `#0C1B2E` | Primary brand dark; backgrounds for primary buttons, header |
| `--navy-700` | `#152438` | Slightly lighter navy for hover states |
| `--navy-600` | `#1E3354` | Admin sidebar background |
| `--gold` | `#B8861F` | Accent gold for decorative elements |
| `--gold-light` | `#EDD98A` | Text on dark navy backgrounds (button labels, brand name) |
| `--linen` | `#F5F0E8` | Page background, card sections on hover |
| `--linen-200` | `#EBE4D6` | Admin button background, input bg in `.admin-form` |
| `--linen-300` | `#DDD5C2` | Hover state for linen elements |
| `--white` | `#FFFFFF` | Card backgrounds, input backgrounds |
| `--text-primary` | `#0C1B2E` | Default body text |
| `--text-secondary` | `#4A5568` | Subtitles, secondary labels |
| `--text-muted` | `#718096` | Placeholder text, muted metadata |
| `--green` | `#1B7A40` | Success / "For" vote |
| `--green-bg` | `#EBF5EF` | Light background for success states |
| `--red` | `#A3220E` | Error text, "Against" vote, danger actions |
| `--red-bg` | `#FDF0EE` | Light background for error/danger states |
| `--amber` | `#C05621` | Warning text |
| `--amber-bg` | `#FFF8F0` | Light background for warning states |
| `--border` | `#D5CCB8` | Default border color for cards, inputs, table rows |
| `--border-subtle` | `#E8E2D5` | Subtler dividers (e.g. table row separators) |
| `--shadow-sm` | `0 1px 3px rgba(12,27,46,.08)` | Card resting shadow |
| `--shadow-md` | `0 4px 16px rgba(12,27,46,.12)` | Elevated card or dropdown shadow |
| `--shadow-lg` | `0 12px 40px rgba(12,27,46,.18)` | Modal / sheet overlay shadow |

### Border radius tokens

| Token | Value | Usage |
|---|---|---|
| `--r-sm` | `4px` | Chips, small badges |
| `--r-md` | `8px` | Inputs, buttons, motion entry cards |
| `--r-lg` | `12px` | Admin cards, voter cards |
| `--r-xl` | `16px` | Large panels |

---

## 2. Typography

Three font families are loaded globally. Do not hardcode `font-family` in component styles — rely on the cascade.

| Role | Family | Applied to |
|---|---|---|
| **Headings** | `'Cormorant Garamond', Georgia, serif` | `h1`–`h5`, brand logo, hero title |
| **Body / UI** | `'Outfit', system-ui, sans-serif` | `body`, buttons, inputs, form labels — everything else |
| **Numbers / monospace** | `'Overpass Mono', monospace` | `.admin-stats__value`, numeric data that must be tabular |

### Type scale (key sizes)

| Context | Size |
|---|---|
| Hero title (`.hero__title`) | `2.75rem` |
| Page heading (`h1` in `.admin-page-header`) | `1.75rem` |
| Body default | `1rem` |
| Table / secondary content | `0.875rem` |
| Labels (`.field__label`, `.admin-card__title`) | `0.75rem` uppercase |
| Micro labels (`.section-label`, `.motion-entry__header`) | `0.7rem` uppercase |
| Badge / motion-type | `0.65rem` uppercase |

---

## 3. Buttons

All buttons use the base `.btn` class plus exactly one modifier. Never compose multiple modifiers (e.g. no `.btn--primary.btn--secondary`). The `.btn--full` width modifier is the only exception and may be combined with any variant.

### Base class

```tsx
<button type="button" className="btn btn--primary">Label</button>
```

`.btn` provides: `inline-flex`, uppercase, `0.8rem` bold text, `11px 28px` padding, `var(--r-md)` border-radius, disabled opacity `0.45`.

### Variants

| Class | Appearance | When to use |
|---|---|---|
| `.btn--primary` | Navy fill, gold-light text, shimmer on hover | The single main action on a page or form (e.g. "Submit", "Create") |
| `.btn--secondary` | Transparent with navy border, inverts to navy on hover | Cancel, back, or secondary actions alongside a primary button |
| `.btn--ghost` | No border, muted text, animated underline on hover | Tertiary nav actions (e.g. "← Back" navigation) |
| `.btn--admin` | Linen-200 fill, muted text | Admin-specific utility actions in dense table rows |
| `.btn--danger` | Red-tinted fill, red text, fills red on hover | Destructive actions (delete, remove) — always requires confirmation |
| `.btn--full` | `width: 100%` | Stretch any variant to full container width |

### Examples

```tsx
{/* Main form action */}
<button type="submit" className="btn btn--primary" disabled={isPending}>
  {isPending ? "Saving…" : "Save Changes"}
</button>

{/* Cancel beside primary */}
<button type="button" className="btn btn--secondary" onClick={onCancel}>
  Cancel
</button>

{/* Back navigation */}
<button type="button" className="btn btn--ghost" onClick={() => navigate(-1)}>
  ← Back
</button>

{/* Destructive */}
<button type="button" className="btn btn--danger" onClick={handleDelete}>
  Remove
</button>
```

---

## 4. Form Fields

All form inputs follow the `.field` / `.field__label` / `.field__input` (or `.field__select`) / `.field__error` pattern. Do not use bare `<input>` without `.field__input`.

### Structure

```tsx
<div className="field">
  <label className="field__label" htmlFor="field-id">Field Name</label>
  <input
    id="field-id"
    className="field__input"
    type="text"
    value={value}
    onChange={(e) => setValue(e.target.value)}
    aria-invalid={!!error}
  />
  {error && <span className="field__error">{error}</span>}
</div>
```

### Select

```tsx
<div className="field">
  <label className="field__label" htmlFor="status-select">Status</label>
  <select
    id="status-select"
    className="field__select"
    value={status}
    onChange={(e) => setStatus(e.target.value)}
    aria-invalid={!!error}
  >
    <option value="">-- Select --</option>
    <option value="open">Open</option>
    <option value="closed">Closed</option>
  </select>
  {error && <span className="field__error">{error}</span>}
</div>
```

### Textarea

Use `.field__input` on `<textarea>` exactly as on `<input>`.

### Token reference

| Class | Purpose |
|---|---|
| `.field` | Container; provides `margin-bottom: 18px` |
| `.field__label` | `0.75rem` uppercase bold label; always use `htmlFor` |
| `.field__input` | Full-width input with `var(--r-md)` border, navy focus ring |
| `.field__select` | Same as input plus custom chevron; use on `<select>` |
| `.field__error` | `0.8125rem` red error text rendered below the input |

### Admin form variant

Wrap a form in `.admin-form` to get the `max-width: 560px` constraint and linen input backgrounds:

```tsx
<form onSubmit={handleSubmit} className="admin-form">
  {/* fields */}
</form>
```

---

## 5. Cards and Sections

### Voter card

```tsx
<div className="card">
  {/* content */}
</div>
```

`.card`: white background, `var(--r-lg)` border-radius, `var(--border)` border, `32px` padding, `var(--shadow-sm)`.

### Admin card

Used to wrap tables, upload sections, and grouped content in admin pages.

```tsx
<div className="admin-card">
  <div className="admin-card__header">
    <p className="admin-card__title">Section Title</p>
    {/* optional header actions */}
  </div>
  <div className="admin-card__body">
    {/* content */}
  </div>
</div>
```

| Class | Purpose |
|---|---|
| `.admin-card` | White card with `var(--r-lg)` border, `margin-bottom: 24px` |
| `.admin-card__header` | Linen-bg header row with flex layout; use for title + actions |
| `.admin-card__title` | `0.7rem` uppercase muted label |
| `.admin-card__body` | `20px 24px` padding for card body content |

### Admin page header

Use at the top of every admin detail/list page for the page title + action buttons row:

```tsx
<div className="admin-page-header">
  <div>
    <h1>Page Title</h1>
  </div>
  <div style={{ display: "flex", gap: 8 }}>
    <button className="btn btn--secondary">Secondary Action</button>
    <button className="btn btn--primary">Primary Action</button>
  </div>
</div>
```

`.admin-page-header`: flex row, space-between, `margin-bottom: 24px`, bottom border.

### Section label

A standalone uppercase micro-label above a group of elements (not inside `.field`):

```tsx
<p className="section-label">Motions</p>
```

---

## 6. Tables

Always wrap admin tables in `.admin-table-wrapper` for horizontal scroll on narrow viewports.

```tsx
<div className="admin-table-wrapper">
  <table className="admin-table">
    <thead>
      <tr>
        <th>Lot #</th>
        <th>Owner</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>101</td>
        <td>Jane Smith</td>
        <td>
          <button className="admin-table__link" onClick={handleEdit}>Edit</button>
        </td>
      </tr>
      {/* Muted row for archived/inactive records */}
      <tr className="admin-table__row--muted">
        <td>102</td>
        <td>Archived Owner</td>
        <td />
      </tr>
    </tbody>
  </table>
</div>
```

| Class | Purpose |
|---|---|
| `.admin-table-wrapper` | `overflow-x: auto` scroll container |
| `.admin-table` | Full-width collapsed table, `0.875rem` font |
| `.admin-table th` | Left-aligned, bottom border, uppercase muted label style |
| `.admin-table td` | `12px 14px` padding, subtle row divider, middle-aligned |
| `.admin-table__link` | Borderless button that looks like an underline link |
| `.admin-table__row--muted` | 60% opacity for archived/inactive rows |
| `.admin-table__cell--muted` | 45% opacity on individual cells only — use when some cells in the row must remain at full opacity |

### Cell-level vs row-level muting

Use `.admin-table__cell--muted` on individual `<td>` elements when only some columns in a row should be greyed out. A common case is a row where data cells are muted but action buttons must remain at full opacity and saturation (e.g. hidden-motion rows in the motion list).

Do **not** use `.admin-table__row--muted` in this case — row-level opacity affects all cells equally, including the actions cell, which prevents action buttons from standing out visually.

---

## 7. Badges

### Motion type badge

Displayed next to motion titles to indicate their classification.

```tsx
<span className="motion-type-badge motion-type-badge--general">General</span>
<span className="motion-type-badge motion-type-badge--special">Special</span>
<span className="motion-type-badge motion-type-badge--hidden">Hidden</span>
```

| Modifier | Appearance | When to use |
|---|---|---|
| `--general` | Neutral/grey tint | Standard motions |
| `--special` | Amber/yellow tint | Special resolutions requiring higher threshold |
| `--hidden` | Muted fill, white text | Motions not yet visible to voters |

All three: `0.65rem` uppercase bold, `999px` border-radius pill shape.

### In-arrear badge (voter-facing)

```tsx
<span className="arrear-badge">In Arrears</span>
```

Uses `var(--amber)` text on `var(--amber-bg)`.

### Status/archived pill (ad-hoc)

For one-off status indicators without a dedicated class, use inline styles with the CSS variables:

```tsx
<span style={{
  fontSize: "0.75rem",
  padding: "2px 8px",
  borderRadius: "12px",
  background: "var(--text-muted)",
  color: "#fff",
}}>
  Archived
</span>
```

---

## 8. Modals

There is no dedicated `.modal` CSS class. Modals are implemented with a fixed-position backdrop div and a white content panel, using inline styles. Use the established pattern from `BuildingEditModal` in `frontend/src/pages/admin/BuildingDetailPage.tsx`:

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-label="Dialog Title"
  style={{
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  }}
>
  <div
    style={{
      background: "#fff",
      borderRadius: 8,
      padding: 32,
      minWidth: 360,
      maxWidth: 480,
      width: "100%",
      boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
    }}
  >
    <h2 style={{ marginTop: 0, marginBottom: 20 }}>Dialog Title</h2>
    {/* form content using .field / .field__label / .field__input */}
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
      <button type="submit" className="btn btn--primary">Confirm</button>
    </div>
  </div>
</div>
```

Note: The inline styles used here (fixed position, backdrop color, border-radius, box-shadow) are acceptable because there is no CSS class for modals. All field internals inside the modal must still use `.field`, `.field__label`, `.field__input`, etc.

---

## 9. State Messages

For full-page loading, error, or empty states:

```tsx
{/* Loading / empty */}
<p className="state-message">No meetings found.</p>

{/* Error */}
<p className="state-message state-message--error">Failed to load data.</p>
```

`.state-message`: centered, `80px 24px` padding, muted text.
`.state-message--error`: overrides color to `var(--red)`.

---

## 10. Common Anti-patterns to Avoid

| Anti-pattern | Correct alternative |
|---|---|
| `className="form-group"` | `className="field"` |
| `className="form-control"` | `className="field__input"` or `className="field__select"` |
| `className="form-label"` | `className="field__label"` |
| Bootstrap class names (`col-`, `row`, `d-flex`, `text-muted`, etc.) | Use the established CSS tokens and classes above |
| Tailwind utility classes | Not used in this project; do not introduce |
| `style={{ color: "#718096" }}` | `style={{ color: "var(--text-muted)" }}` |
| `style={{ borderRadius: 8 }}` | `style={{ borderRadius: "var(--r-md)" }}` |
| `style={{ color: "red" }}` for errors | `className="field__error"` or `style={{ color: "var(--red)" }}` |
| Hardcoded font sizes for labels | Use `.field__label` or `.admin-card__title` which set the correct scale |
| Omitting `htmlFor` on `<label>` | Always pair `htmlFor` with `id` on every label/input pair |
| Using `<input>` or `<select>` without the field wrapper | Always wrap in `<div className="field">` |
| Inline `style` for layout inside modals that should use CSS classes | Only inline styles for the backdrop/panel shell; use CSS classes for interior content |
