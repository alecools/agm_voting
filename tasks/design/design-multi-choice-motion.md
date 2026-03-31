# Technical Design: Multi-Choice Motion Type

**Status:** Implemented

## Overview

This feature adds a new `multi_choice` motion type to the AGM voting app. Unlike existing `general` and `special` motions (which offer For/Against/Abstain), a multi-choice motion presents a set of custom text options (e.g., candidates, sites, proposals). The admin sets the option list and an `option_limit` (maximum selections per voter). Each selected option receives the voter's full UOE — selections are not split. This enables elections and preference votes within the same ballot system.

---

## Database Changes

### New table: `motion_options`

Stores the selectable options for a `multi_choice` motion. Deleted automatically when the parent motion is deleted (CASCADE).

```sql
CREATE TABLE motion_options (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    motion_id   UUID NOT NULL REFERENCES motions(id) ON DELETE CASCADE,
    text        VARCHAR NOT NULL,
    display_order INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_motion_options_motion_display_order
    ON motion_options (motion_id, display_order);
```

### Changes to `motions` table

Add `option_limit` column — NULL for non-multi-choice motions, required (>= 1) for `multi_choice`.

```sql
ALTER TABLE motions ADD COLUMN option_limit INTEGER NULL;
```

Constraint enforced at the application layer: when `motion_type = 'multi_choice'`, `option_limit` must be between 1 and the count of options. The DB column is unconstrained to keep the migration simple; validation lives in the Pydantic schema.

### Changes to `MotionType` enum

Add `multi_choice` value:

```sql
ALTER TYPE motiontype ADD VALUE 'multi_choice';
```

Alembic cannot use `ADD VALUE` inside a transaction on older PostgreSQL versions. The migration must execute this statement outside a transaction block using `op.execute()` with `autocommit` or by splitting into a separate migration step. The established project pattern for enum additions is to use `op.execute("ALTER TYPE motiontype ADD VALUE 'multi_choice'")` in a migration with `connection.execute(text(...))` outside the implicit transaction — see `d1e2f3a4b5c6_add_not_eligible_to_votechoice.py` for the precedent.

### Changes to `VoteChoice` enum

Add `selected` value for multi-choice option votes:

```sql
ALTER TYPE votechoice ADD VALUE 'selected';
```

`selected` is used when a voter picks an option in a multi-choice motion. The existing values (`abstained`, `not_eligible`) continue to apply for the abstain and in-arrear cases.

### Changes to `votes` table — unique constraint strategy

The existing unique constraint `uq_votes_gm_motion_lot_owner` on `(general_meeting_id, motion_id, lot_owner_id)` works for single-answer motions but breaks for multi-choice (one row per selected option, so multiple rows per motion per lot are valid).

**Strategy: drop old constraint, add two partial unique indexes.**

```sql
-- Drop the existing constraint
ALTER TABLE votes DROP CONSTRAINT uq_votes_gm_motion_lot_owner;

-- Add motion_option_id column (nullable — NULL for non-multi-choice)
ALTER TABLE votes ADD COLUMN motion_option_id UUID NULL
    REFERENCES motion_options(id) ON DELETE CASCADE;

-- Partial unique index for non-multi-choice votes (motion_option_id IS NULL)
-- Guarantees one vote row per (meeting, motion, lot) for general/special motions
CREATE UNIQUE INDEX uq_votes_non_multi_choice
    ON votes (general_meeting_id, motion_id, lot_owner_id)
    WHERE motion_option_id IS NULL;

-- Partial unique index for multi-choice votes (motion_option_id IS NOT NULL)
-- Guarantees one vote row per (meeting, motion, lot, option) — prevents duplicate selections
CREATE UNIQUE INDEX uq_votes_multi_choice
    ON votes (general_meeting_id, motion_id, lot_owner_id, motion_option_id)
    WHERE motion_option_id IS NOT NULL;
```

**Why two partial indexes instead of one composite index:** NULL values in a unique index are not compared equal in PostgreSQL, so a standard unique index on `(gm_id, motion_id, lot_owner_id, motion_option_id)` would allow unlimited NULL rows per (meeting, motion, lot) — defeating the constraint for general/special motions. The two partial indexes give exact uniqueness semantics for each motion type.

**Existing Vote rows:** All existing rows have `motion_option_id = NULL`, which satisfies the non-multi-choice partial index. No data migration is required.

### Summary of schema additions

| Object | Change |
|--------|--------|
| `motion_options` | New table |
| `motions.option_limit` | New nullable integer column |
| `motiontype` enum | Add `multi_choice` value |
| `votechoice` enum | Add `selected` value |
| `votes.motion_option_id` | New nullable UUID FK column |
| `uq_votes_gm_motion_lot_owner` | Dropped |
| `uq_votes_non_multi_choice` | New partial unique index (WHERE motion_option_id IS NULL) |
| `uq_votes_multi_choice` | New partial unique index (WHERE motion_option_id IS NOT NULL) |

**Schema migration required: YES.** A single Alembic migration file covers all changes above in the correct order (enums first, then column additions, then index changes).

---

## Backend Changes

### New model: `MotionOption`

Location: `backend/app/models/motion_option.py`

```python
class MotionOption(Base):
    __tablename__ = "motion_options"
    __table_args__ = (
        UniqueConstraint("motion_id", "display_order",
                         name="uq_motion_options_motion_display_order"),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    motion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("motions.id", ondelete="CASCADE"), nullable=False
    )
    text: Mapped[str] = mapped_column(String, nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False)

    motion: Mapped["Motion"] = relationship("Motion", back_populates="options")
```

### Updated model: `Motion`

- Add `option_limit: Mapped[int | None]` column.
- Add `options: Mapped[list[MotionOption]]` relationship with `cascade="all, delete-orphan"`, `order_by=MotionOption.display_order`.

### Updated model: `Vote`

- Add `motion_option_id: Mapped[uuid.UUID | None]` FK column.
- Add `motion_option: Mapped[MotionOption | None]` relationship.
- Remove `UniqueConstraint("general_meeting_id", "motion_id", "lot_owner_id", ...)` from `__table_args__` — replaced by the two partial indexes defined in the migration. The indexes are not expressed as `Index(...)` in the model class because partial indexes with `WHERE` clauses are defined exclusively in the migration (same pattern as the existing motion_number partial index).

### Updated enum: `MotionType`

```python
class MotionType(str, enum.Enum):
    general = "general"
    special = "special"
    multi_choice = "multi_choice"
```

### Updated enum: `VoteChoice`

```python
class VoteChoice(str, enum.Enum):
    yes = "yes"
    no = "no"
    abstained = "abstained"
    not_eligible = "not_eligible"
    selected = "selected"
```

### Updated schemas: `backend/app/schemas/admin.py`

#### New schemas

```python
class MotionOptionCreate(BaseModel):
    text: str
    display_order: int

    @field_validator("text")
    @classmethod
    def text_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("option text must not be empty")
        if len(v) > 200:
            raise ValueError("option text must not exceed 200 characters")
        return v

class MotionOptionOut(BaseModel):
    id: uuid.UUID
    text: str
    display_order: int
    model_config = {"from_attributes": True}
```

#### Modified `MotionCreate`

Add fields:
- `option_limit: int | None = None`
- `options: list[MotionOptionCreate] = []`

Add `model_validator` that enforces:
- When `motion_type == multi_choice`: `option_limit` must be provided and >= 1; `options` must have >= 2 entries; `option_limit` must be <= len(options).
- When `motion_type != multi_choice`: `option_limit` must be None; `options` must be empty.

#### Modified `MotionAddRequest`

Same additions as `MotionCreate` above.

#### Modified `MotionUpdateRequest`

Add `option_limit: int | None = None` and `options: list[MotionOptionCreate] | None = None`.

When `options` is provided on an update, the service replaces all existing options for the motion atomically (delete-then-insert within the transaction). `option_limit` may be updated independently.

#### Modified `MotionOut` (admin schemas)

Add:
- `option_limit: int | None = None`
- `options: list[MotionOptionOut] = []`

#### Modified `MotionDetail` (admin schemas)

Add the same `option_limit` and `options` fields. Also modify `MotionTally` and `MotionVoterLists`:

```python
class OptionTallyEntry(BaseModel):
    option_id: uuid.UUID
    option_text: str
    display_order: int
    voter_count: int
    entitlement_sum: int

class MotionTally(BaseModel):
    # existing fields (yes, no, abstained, absent, not_eligible) unchanged
    yes: TallyCategory
    no: TallyCategory
    abstained: TallyCategory
    absent: TallyCategory
    not_eligible: TallyCategory
    # new field — populated only for multi_choice motions, empty list otherwise
    options: list[OptionTallyEntry] = []

class MotionVoterLists(BaseModel):
    # existing fields unchanged
    yes: list[VoterEntry]
    no: list[VoterEntry]
    abstained: list[VoterEntry]
    absent: list[VoterEntry]
    not_eligible: list[VoterEntry]
    # new field — populated only for multi_choice motions
    options: dict[str, list[VoterEntry]] = {}  # key: option_id str
```

### Updated schemas: `backend/app/schemas/voting.py`

#### Modified `MotionOut` (voter-facing)

Add:
- `option_limit: int | None = None`
- `options: list[MotionOptionOut] = []` — populated for multi_choice motions so the voter UI can render the option list.

#### New `MultiChoiceVoteItem`

```python
class MultiChoiceVoteItem(BaseModel):
    motion_id: uuid.UUID
    option_ids: list[uuid.UUID]  # empty list = abstain
```

#### Modified `SubmitBallotRequest` (in `voting.py` router)

The existing `votes: list[VoteInlineItem]` carries `(motion_id, VoteChoice)` for general/special motions. Multi-choice uses a parallel list:

```python
class SubmitBallotRequest(BaseModel):
    lot_owner_ids: list[uuid.UUID]
    votes: list[VoteInlineItem] = []           # general/special motions
    multi_choice_votes: list[MultiChoiceVoteItem] = []  # multi-choice motions
```

This keeps the existing `votes` field fully backward-compatible. The backend merges both lists when building the per-motion vote.

### Updated service: `admin_service.py`

#### `create_general_meeting`

When creating motions of type `multi_choice`:
1. Validate `option_limit >= 1` and `len(options) >= 2` (already enforced by schema, but the service double-checks before DB insert).
2. Insert `MotionOption` rows after the `Motion` row is flushed (to get `motion.id`).
3. Return `options` list in the motion dict output.

#### `add_motion_to_meeting`

Same multi-choice validation and `MotionOption` creation. The options are passed in `MotionAddRequest.options`.

#### `update_motion`

When `options` is provided in `MotionUpdateRequest`:
1. Validate that the motion is hidden (existing rule — cannot edit visible motions).
2. Delete all existing `MotionOption` rows for this motion.
3. Insert the new option set.
4. Update `option_limit` if provided.

When changing `motion_type` away from `multi_choice` on update: delete all options and null out `option_limit`.

#### `get_general_meeting_detail` — tally calculation for multi_choice

For motions of type `multi_choice`, replace the yes/no/abstained tally logic with per-option tallying:

```
For each motion option:
    option_voter_ids = {
        vote.lot_owner_id
        for vote in submitted_votes
        if vote.motion_id == motion.id
        and vote.motion_option_id == option.id
        and vote.choice == VoteChoice.selected
        and vote.lot_owner_id in submitted_lot_owner_ids
    }
    option_tally = {
        voter_count: len(option_voter_ids),
        entitlement_sum: sum(lot_entitlement[lid] for lid in option_voter_ids)
    }

abstained_ids = {
    lid for lid in submitted_lot_owner_ids
    if not any(
        v.lot_owner_id == lid
        and v.motion_id == motion.id
        and v.choice == VoteChoice.selected
        for v in submitted_votes
    )
    and lid not in not_eligible_ids
}
```

The existing `yes`, `no` tally fields are returned as zero-count for multi-choice motions to avoid API shape changes breaking existing consumers.

#### `close_general_meeting`

No change needed — draft Vote deletion by `general_meeting_id` covers multi-choice drafts because their `general_meeting_id` is set. `motion_option_id` is irrelevant to the delete.

### Updated service: `voting_service.py`

#### `submit_ballot` — multi-choice handling

New parameter: `multi_choice_votes: dict[uuid.UUID, list[uuid.UUID]] | None = None` (motion_id → list of selected option_ids).

Processing for each `lot_owner_id` in the submission loop:

```
for motion in visible_motions:
    if motion.motion_type == MotionType.multi_choice:
        if is_in_arrear:
            # same as general: record not_eligible
            insert Vote(choice=not_eligible, motion_option_id=None)
        else:
            selected_option_ids = multi_choice_votes.get(motion.id, [])
            if not selected_option_ids:
                # Voter answered nothing — record abstained
                insert Vote(choice=abstained, motion_option_id=None)
            else:
                # Validate option_ids belong to this motion
                valid_option_ids = {opt.id for opt in motion.options}
                for opt_id in selected_option_ids:
                    if opt_id not in valid_option_ids:
                        raise HTTPException(400, "Invalid option ID for motion")
                    insert Vote(
                        choice=selected,
                        motion_option_id=opt_id,
                    )
```

**Option loading:** The service needs to load `MotionOption` rows. To avoid N+1 queries, load all options for all visible multi-choice motions in a single query keyed by `motion_id` before the per-lot loop.

**Option limit enforcement:** Validate `len(selected_option_ids) <= motion.option_limit` before inserting. Return 422 if exceeded.

**Re-entry (revote):** Draft deletion already covers multi-choice (deletes by `general_meeting_id + lot_owner_id`). For already-voted detection (`already_voted_by_lot`), a multi-choice motion is considered "already voted" if any Vote row exists for `(motion_id, lot_owner_id, status=submitted)`. Skip re-inserting when already voted (existing pattern preserved).

#### `get_my_ballot` — confirmation screen

`BallotVoteItem` needs to support multi-choice. The confirmation screen shows each motion and the voter's answer(s):

- For non-multi-choice: `choice` field as before.
- For multi-choice: `choice = "selected"` is not human-readable. Extend `BallotVoteItem`:

```python
class BallotVoteItem(BaseModel):
    motion_id: uuid.UUID
    motion_title: str
    display_order: int
    motion_number: Optional[str] = None
    choice: VoteChoice
    eligible: bool = True
    # new fields — populated for multi_choice motions only
    motion_type: MotionType = MotionType.general
    selected_options: list[MotionOptionOut] = []  # options the voter selected
```

The `get_my_ballot` service groups multiple `selected` Vote rows per motion into a single `BallotVoteItem` with `selected_options` populated.

#### `list_motions` (voter router)

Load `MotionOption` rows for multi-choice motions using a single `IN` query on motion IDs. Populate `MotionOut.options`.

For `already_voted` and `submitted_choice` on multi-choice motions:
- `already_voted = True` if any submitted Vote row exists for `(motion_id, lot_owner_id)`.
- `submitted_choice` is not meaningful for multi-choice — set it to `VoteChoice.selected` when `already_voted` is True (signals "you voted" without implying a specific binary choice). The frontend uses this to lock the motion card.

### API endpoint changes

All existing endpoints retain their current paths and methods. The only change is in request/response shapes:

| Endpoint | Change |
|----------|--------|
| `POST /api/admin/general-meetings` | `MotionCreate` gains `option_limit`, `options` |
| `POST /api/admin/general-meetings/{id}/motions` | `MotionAddRequest` gains `option_limit`, `options` |
| `PATCH /api/admin/motions/{id}` | `MotionUpdateRequest` gains `option_limit`, `options` |
| `GET /api/admin/general-meetings/{id}` | `MotionDetail` includes `options`, per-option tally |
| `GET /api/general-meeting/{id}/motions` | `MotionOut` includes `option_limit`, `options` |
| `POST /api/general-meeting/{id}/submit` | Body gains `multi_choice_votes` |
| `GET /api/general-meeting/{id}/my-ballot` | `BallotVoteItem` gains `motion_type`, `selected_options` |

No breaking changes to the shapes of non-multi-choice motions. All new fields are additive with defaults.

---

## Frontend Changes

### Updated types

#### `frontend/src/types.ts`

Add `multi_choice` to `MotionType`:

```typescript
export type MotionType = "general" | "special" | "multi_choice";
```

#### `frontend/src/api/voter.ts`

```typescript
export interface MotionOptionOut {
  id: string;
  text: string;
  display_order: number;
}

// Extend MotionOut
export interface MotionOut {
  // ... existing fields unchanged ...
  option_limit: number | null;
  options: MotionOptionOut[];
}

// Extend BallotVoteItem
export interface BallotVoteItem {
  // ... existing fields unchanged ...
  motion_type: MotionType;
  selected_options: MotionOptionOut[];
}

// New type for multi-choice submission
export interface MultiChoiceVoteItem {
  motion_id: string;
  option_ids: string[];
}

// Extend SubmitBallotRequest
export interface SubmitBallotRequest {
  lot_owner_ids: string[];
  votes: Array<{ motion_id: string; choice: VoteChoice }>;
  multi_choice_votes?: MultiChoiceVoteItem[];
}
```

#### `frontend/src/api/admin.ts`

```typescript
export interface MotionOptionCreate {
  text: string;
  display_order: number;
}

export interface MotionOptionOut {
  id: string;
  text: string;
  display_order: number;
}

// Extend MotionOut (admin)
export interface MotionOut {
  // ... existing fields ...
  option_limit: number | null;
  options: MotionOptionOut[];
}

// Extend MotionDetail
export interface OptionTallyEntry {
  option_id: string;
  option_text: string;
  display_order: number;
  voter_count: number;
  entitlement_sum: number;
}

export interface MotionTally {
  // existing fields unchanged
  yes: TallyCategory;
  no: TallyCategory;
  abstained: TallyCategory;
  absent: TallyCategory;
  not_eligible: TallyCategory;
  options: OptionTallyEntry[];
}

export interface MotionVoterLists {
  // existing fields unchanged
  yes: VoterEntry[];
  no: VoterEntry[];
  abstained: VoterEntry[];
  absent: VoterEntry[];
  not_eligible: VoterEntry[];
  options: Record<string, VoterEntry[]>;
}

// AddMotionRequest / UpdateMotionRequest
export interface AddMotionRequest {
  // ... existing ...
  option_limit?: number | null;
  options?: MotionOptionCreate[];
}

export interface UpdateMotionRequest {
  // ... existing ...
  option_limit?: number | null;
  options?: MotionOptionCreate[];
}
```

### New component: `MultiChoiceOptionList`

Location: `frontend/src/components/vote/MultiChoiceOptionList.tsx`

Renders within `MotionCard` when `motion.motion_type === "multi_choice"`. Replaces the For/Against/Abstain buttons for multi-choice motions.

**Props:**
```typescript
interface MultiChoiceOptionListProps {
  motion: MotionOut;
  selectedOptionIds: string[];
  onSelectionChange: (motionId: string, optionIds: string[]) => void;
  disabled: boolean;
  readOnly?: boolean;
}
```

**Behaviour:**
- Renders each option as a `<label>` containing a `<input type="checkbox">` and the option text.
- Counter label: `"Select up to {option_limit} option(s) — {selected} selected"`
- Once `selectedOptionIds.length >= option_limit`, unchecked checkboxes gain `disabled` attribute and a visual muted state. Already-checked boxes remain interactive (to allow unchecking).
- In `readOnly` mode, all checkboxes are disabled. Selected options are shown with a check-mark style consistent with the existing "Already voted" read-only display.
- `aria-label` on each checkbox: the option text.
- Uses the design system: checkboxes wrapped in `.field` label pattern; counter uses `var(--text-muted)`.

### Updated component: `MotionCard`

`MotionCard` currently always renders `VoteButton` x3 (For/Against/Abstain). New conditional:

```tsx
if (motion.motion_type === "multi_choice") {
  render <MultiChoiceOptionList ... />
} else {
  render existing VoteButton row
}
```

**State integration in `VotingPage`:** The parent `VotingPage` currently holds `choices: Record<string, VoteChoice>` (motion_id → VoteChoice). For multi-choice, the equivalent is `multiChoiceSelections: Record<string, string[]>` (motion_id → selected option_ids). Both state objects live in `VotingPage` and are passed down as props.

A motion is considered "answered" for progress-bar purposes if:
- Non-multi-choice: `choices[motion.id] != null`.
- Multi-choice: `multiChoiceSelections[motion.id] != null` (even if the array is empty — an explicit "no selection" counts as answered since it maps to abstained at submit time). However, an unanswered multi-choice motion (never touched) shows as unanswered. Implementation: treat multi-choice motions as answered once the voter has interacted with them at least once (toggled any checkbox). This mirrors the existing behaviour where `null` means "not answered" and any choice (including deselecting all after an interaction) is tracked.

**Revised approach for simplicity:** Track the multi-choice answered state the same way as binary motions — the motion is answered when `multiChoiceSelections[motion.id]` exists in the state map (whether `[]` or non-empty). Until the voter interacts, the key is absent from the map.

### Updated component: `MotionManagementTable`

In `SortableRow`, the motion type badge currently shows "Special" or "General". Add "Multi-Choice" label and a new `motion-type-badge--multi-choice` CSS modifier (styled with a blue/info tint to distinguish from general/special).

Show option count alongside type badge when `motion.motion_type === "multi_choice"`: `"Multi-Choice (N options)"`.

The localOrder sync check (`motions.some(...)`) must also include `m.options` and `m.option_limit` fields.

### Updated component: admin motion creation/edit modals (`GeneralMeetingDetailPage`)

**Add Motion modal and Edit Motion modal** — when `motion_type === "multi_choice"` is selected:

1. Show a "Option limit" number input (min 1, label "Max selections per voter").
2. Show a dynamic list of option text inputs, each with a remove button.
3. Show an "Add option" button that appends a new empty option input.
4. Options are reorderable via simple up/down buttons (no drag-and-drop required in the modal — the drag-and-drop reorder is for the motion list, not the options list).
5. Validation: at least 2 options required; option limit cannot exceed option count.

The form state type for the add/edit modal is extended:

```typescript
interface MotionFormState {
  title: string;
  description: string;
  motion_type: MotionType;
  motion_number: string;
  option_limit: string;  // string to work with <input type="number">
  options: Array<{ text: string }>;  // display_order derived from array index
}
```

### Updated component: `AGMReportView`

The results report panel (`frontend/src/components/admin/AGMReportView.tsx`) currently renders yes/no/abstained/absent rows per motion. For `multi_choice` motions, replace the binary rows with one row per option showing option text, entitlement sum, and percentage.

Percentage calculation (frontend): `(option_entitlement_sum / total_entitlement * 100).toFixed(1)`.

Absent/not-eligible rows are still shown below the option list for multi-choice motions.

### Updated page: confirmation screen (`ConfirmationPage` / `BallotConfirmView`)

`BallotVoteItem` currently renders `choice` as a text badge (For / Against / Abstained / Not Eligible). For multi-choice motions (`motion_type === "multi_choice"`):
- Show the selected option texts (from `selected_options`) as a comma-separated or bulleted list.
- If `selected_options` is empty and `choice === "abstained"`, show "Abstained".
- If `choice === "not_eligible"`, show "Not eligible".

### sessionStorage changes

`VotingPage` stores lot info under `meeting_lots_info_<meetingId>`. The multi-choice state (`multiChoiceSelections`) lives only in React state — it is not persisted to sessionStorage because draft auto-save is not used (established pattern from FR-13).

The submit request shape is extended with `multi_choice_votes`:

```typescript
// existing
votes: choices entries for non-multi-choice motions
// new
multi_choice_votes: multiChoiceSelections entries for multi-choice motions
```

No sessionStorage key changes required.

---

## Tally Calculation Detail

For multi-choice motions, the `get_general_meeting_detail` service computes the following:

```
total_building_uoe = sum(lot_entitlement.values())

For each option in motion.options (ordered by display_order):
    lots_selected_option = {
        vote.lot_owner_id
        for vote in submitted_votes
        where vote.motion_id == motion.id
          and vote.motion_option_id == option.id
          and vote.choice == VoteChoice.selected
          and vote.lot_owner_id in submitted_lot_owner_ids
    }
    option_tally = OptionTallyEntry(
        option_id = option.id,
        option_text = option.text,
        display_order = option.display_order,
        voter_count = len(lots_selected_option),
        entitlement_sum = sum(lot_entitlement[lid] for lid in lots_selected_option),
    )

abstained_ids = submitted_lot_owner_ids
    - not_eligible_ids
    - {lid for lid with any selected Vote on this motion}

absent_ids = (closed meetings only) set(absent_submissions.keys())
```

Note: a voter can appear in multiple option tallies (if they selected multiple options). The `voter_count` per option is independent — there is no constraint that the sum of all option voter counts equals total submitted. This is by design: multi-choice selections are per-option, not mutually exclusive.

The `yes`, `no`, `abstained` tally keys continue to exist in the API response for multi-choice motions. `yes` and `no` are always zero. `abstained` carries the count of lots that submitted an empty selection. This keeps the API shape consistent for frontend consumers that iterate over tally keys generically.

---

## Security Considerations

1. **Option ID validation on submit:** The `submit_ballot` service validates every `option_id` in `multi_choice_votes` against the actual `MotionOption` rows for that motion. Unknown option IDs (including IDs from a different motion) are rejected with 400. This prevents a voter from injecting votes for options not belonging to the submitted motion.

2. **Option limit enforcement:** Backend enforces `len(selected_option_ids) <= motion.option_limit` even though the frontend also enforces it. A voter who bypasses the frontend cannot exceed their entitlement.

3. **Motion-meeting ownership:** The existing check (`motion.general_meeting_id == general_meeting_id`) already validates that motion IDs belong to the meeting. Multi-choice options inherit this protection since they are fetched only via their parent motion.

4. **In-arrear lots:** Same rule as General motions — multi-choice votes for in-arrear lots are recorded as `not_eligible`. The backend enforces this regardless of what the frontend sends.

5. **Admin auth:** All admin endpoints that create/modify `MotionOption` rows are behind the existing admin authentication middleware. No new auth surface is introduced.

6. **HTML injection in option text:** The `_sanitise_description` function (used for motion description) will also be applied to option text via a new `_sanitise_option_text` helper in `admin_service.py`.

---

## Report / Export Changes

### In-app results report (`AGMReportView`)

Multi-choice motions render a per-option breakdown instead of yes/no rows. The export CSV button (`"Export voter lists (CSV)"`) adds rows for each option under the heading `"Option: {option_text}"`.

CSV format for multi-choice:
```
Motion,Category,Lot Number,Entitlement
Motion 3,Option: Candidate A,101,50
Motion 3,Option: Candidate A,102,75
Motion 3,Option: Candidate B,103,40
Motion 3,Abstained,104,30
Motion 3,Absent,105,25
```

---

## Data Flow — Happy Path (multi-choice voter)

1. Admin creates a meeting with a `multi_choice` motion (e.g., "Board Election" with options "Alice", "Bob", "Carol"; `option_limit=2`). Backend inserts `Motion` row + 3 `MotionOption` rows.

2. Voter authenticates. `GET /api/general-meeting/{id}/motions` returns the motion with `options: [{id, text, display_order}, ...]` and `option_limit: 2`.

3. Voter sees a checkbox list on the `MotionCard`. Selects "Alice" and "Carol". A third checkbox ("Bob") becomes disabled (limit reached). `multiChoiceSelections["motion-id"] = ["alice-id", "carol-id"]` in React state.

4. Voter clicks Submit. `VotingPage` sends:
   ```json
   {
     "lot_owner_ids": ["lot-a-id"],
     "votes": [/* general/special motions */],
     "multi_choice_votes": [
       { "motion_id": "motion-id", "option_ids": ["alice-id", "carol-id"] }
     ]
   }
   ```

5. Backend `submit_ballot`:
   - Validates option IDs belong to the motion.
   - Validates `len([alice, carol]) <= 2` (option_limit).
   - Inserts two `Vote` rows: `(motion_id, lot_owner_id, choice=selected, motion_option_id=alice-id)` and `(motion_id, lot_owner_id, choice=selected, motion_option_id=carol-id)`.
   - Inserts `BallotSubmission` row.

6. Voter sees confirmation screen. `GET /api/general-meeting/{id}/my-ballot` returns `BallotVoteItem` with `motion_type=multi_choice`, `selected_options=[{text:"Alice"}, {text:"Carol"}]`.

7. Admin views results. `GET /api/admin/general-meetings/{id}` returns per-option tallies. Alice and Carol each accumulate the lot's UOE in their `entitlement_sum`.

---

## Vertical Slice Decomposition

This feature is decomposed into four independently testable slices. Each slice has its own branch.

### Slice 1: Schema + Model Layer (no frontend)

**Branch:** `feat-multi-choice-motion-slice1-schema`

**Scope:**
- Alembic migration (all schema changes: `motion_options` table, `motions.option_limit`, enum additions, `votes.motion_option_id`, partial unique indexes).
- `MotionOption` SQLAlchemy model.
- Update `Motion` model (add `option_limit`, `options` relationship).
- Update `Vote` model (add `motion_option_id`, drop old unique constraint from `__table_args__`).
- Update `MotionType` enum to add `multi_choice`.
- Update `VoteChoice` enum to add `selected`.
- Unit tests: model instantiation, FK cascade delete of options when motion deleted.
- Integration tests: migration runs cleanly; existing general/special votes satisfy the new partial index.

**Testable in isolation:** Yes — DB model tests only, no API or frontend.

**Dependency:** None. This is the foundation slice.

---

### Slice 2: Admin API (backend only)

**Branch:** `feat-multi-choice-motion-slice2-admin-api`

**Scope:**
- Pydantic schemas: `MotionOptionCreate`, `MotionOptionOut`, extensions to `MotionCreate`, `MotionAddRequest`, `MotionUpdateRequest`, `MotionOut`, `MotionDetail`, `MotionTally`, `MotionVoterLists`.
- `admin_service.py`: `create_general_meeting`, `add_motion_to_meeting`, `update_motion`, `get_general_meeting_detail` (tally for multi_choice).
- Unit + integration tests for admin endpoints with multi-choice motions.

**Testable in isolation:** Yes — backend-only with test DB.

**Dependency:** Slice 1 must be merged first (requires schema + models).

---

### Slice 3: Voter API (backend only)

**Branch:** `feat-multi-choice-motion-slice3-voter-api`

**Scope:**
- Voting schemas: `MotionOut` additions, `MultiChoiceVoteItem`, `SubmitBallotRequest` extension, `BallotVoteItem` additions.
- `voting_service.py`: `submit_ballot` multi-choice path, `get_my_ballot` multi-choice path, `list_motions` options loading.
- `voting.py` router: parse and pass `multi_choice_votes` from request.
- Unit + integration tests for voter endpoints.

**Testable in isolation:** Yes — backend-only with test DB.

**Dependency:** Slice 1. Can run in parallel with Slice 2.

---

### Slice 4: Frontend (admin + voter UI)

**Branch:** `feat-multi-choice-motion-slice4-frontend`

**Scope:**
- Type additions (`types.ts`, `voter.ts`, `admin.ts`).
- `MultiChoiceOptionList` component.
- `MotionCard` updated (conditional render).
- `VotingPage` updated (multi-choice state, submit payload).
- `MotionManagementTable` updated (badge, option count display).
- Admin motion creation/edit modals updated (option list management UI).
- `AGMReportView` updated (per-option tally rows, CSV export).
- Confirmation page updated (selected options display).
- CSS: `motion-type-badge--multi-choice` modifier.
- Unit + integration tests (Vitest + RTL + MSW).
- E2E tests.

**Testable in isolation:** Yes — can use MSW to mock the backend responses. E2E requires both Slice 2 and Slice 3 to be deployed.

**Dependency:** Slices 2 and 3 must be deployed to the branch preview before E2E can run. UI unit tests can run immediately (MSW).

### Dependency graph

```
Slice 1 (schema)
    |
    +---> Slice 2 (admin API) -+
    |                          |
    +---> Slice 3 (voter API) -+---> Slice 4 (frontend)
```

Slices 2 and 3 are parallelisable after Slice 1. Slice 4 depends on 2 and 3 for E2E but can be implemented and unit-tested in parallel.

---

## E2E Test Scenarios

These scenarios form the spec for Playwright tests. They should be added to (or replace relevant sections of) the existing E2E spec files for the affected journeys: **Voter journey**, **Admin journey**, and **In-arrear lot journey**.

### Admin journey — multi-choice motion management (update existing admin E2E spec)

**Scenario A-MC-01: Create meeting with multi-choice motion**
- Admin creates a meeting, selects motion type "Multi-Choice".
- Fields for option_limit and option list appear.
- Admin enters 3 options and sets limit to 2.
- Saves — meeting created, motion table shows "Multi-Choice (3 options)" badge.
- Verify in browser using dev-browser skill.

**Scenario A-MC-02: Add motion to existing meeting (multi-choice)**
- Admin clicks "Add Motion", selects "Multi-Choice".
- Adds 2 options, sets option_limit=1.
- Saves — motion appears in table with badge.

**Scenario A-MC-03: Edit multi-choice motion (update options)**
- Admin hides a multi-choice motion, clicks Edit.
- Removes one option, adds two new ones, changes option_limit.
- Saves — motion detail shows updated options.

**Scenario A-MC-04: Results tally for multi-choice motion (closed meeting)**
- After voters submit, admin views closed meeting results.
- Multi-choice motion shows per-option UOE totals, not yes/no.
- Absent and abstained rows still appear.
- Export CSV includes option rows.

**Scenario A-MC-05: Attempt to create multi-choice motion with < 2 options**
- Admin tries to save with only 1 option — inline error shown; save blocked.

**Scenario A-MC-06: Attempt to set option_limit > option count**
- Admin sets option_limit = 4 but only 3 options — inline error; save blocked.

### Voter journey — multi-choice motion voting (update existing voter E2E spec)

**Scenario V-MC-01: Happy path — voter selects options and submits**
- Voter sees multi-choice motion with checkboxes.
- Counter shows "Select up to 2 options (0 selected)".
- Voter checks two options — counter updates to "(2 selected)".
- Third checkbox is disabled.
- Voter unchecks one — third checkbox re-enabled.
- Voter submits. Confirmation page shows selected option names.

**Scenario V-MC-02: Voter submits with no option selected (abstain)**
- Voter leaves multi-choice motion unchecked.
- Submits — confirmation dialog notes motion will be abstained.
- Confirmation page shows "Abstained" for that motion.

**Scenario V-MC-03: Voter partially fills other motions + multi-choice**
- Meeting has mixed motion types.
- Voter answers a general motion (For) and a multi-choice motion (2 options).
- Progress bar correctly counts answered motions.
- Submission succeeds; confirmation shows correct choices for all motions.

**Scenario V-MC-04: Multi-choice motion with option_limit = 1 (single-select)**
- Voter selects one option; others become disabled immediately.
- Unchecking re-enables others.

**Scenario V-MC-05: Already-voted multi-choice motion appears read-only on re-entry**
- Voter submits ballot.
- Admin makes another motion visible.
- Voter re-authenticates — existing multi-choice motion shows "Already voted" badge with selected options displayed read-only.
- New motion is interactive.

### In-arrear lot journey — multi-choice motion (update existing in-arrear E2E spec)

**Scenario IA-MC-01: In-arrear lot sees multi-choice motion as not-eligible**
- Meeting has a multi-choice motion.
- In-arrear lot authenticates.
- Multi-choice motion checkboxes are disabled with "Not eligible" indicator.
- Ballot submission records `not_eligible` for the multi-choice motion.
- Confirmation page shows "Not eligible" for the multi-choice motion.

### Edge cases

**Scenario E-MC-01: Concurrent submission — duplicate option selection rejected**
- Two simultaneous submit requests for the same lot and multi-choice motion.
- One succeeds; the other receives 409.

**Scenario E-MC-02: Submit with invalid option_id**
- Manipulated request sends option_id from a different motion.
- Backend returns 400.

**Scenario E-MC-03: Submit exceeding option_limit**
- Manipulated request sends more option_ids than option_limit allows.
- Backend returns 422.

---

## Notes for Implementation Agent

- The Alembic migration must handle the `ALTER TYPE ... ADD VALUE` statements outside a transaction. Use the `connection.execute(text(...))` pattern after calling `op.get_bind()`. See the existing `d1e2f3a4b5c6` migration for the precedent on enum value additions.
- When `MotionType.multi_choice` is added to the enum, the SQLAlchemy `Enum(MotionType, name="motiontype")` column definition in `motion.py` will automatically include it — no ORM-level change needed beyond adding the Python enum value.
- The `votes` unique constraint removal must be done before adding the two partial indexes in the same migration to avoid a transient state where both old and new constraints exist.
- Frontend CSS for `motion-type-badge--multi-choice`: use `var(--navy)` text on a light blue background (e.g., `#E8F4FD`) to distinguish from general (grey) and special (amber). Add this to `frontend/src/styles/index.css`.
- The `MultiChoiceOptionList` checkboxes must not use `.field__input` (which is styled for text inputs). Use a custom `multi-choice-option` CSS class with `.field__label`-style label text and a standard browser checkbox or custom checkbox styled with CSS variables.
