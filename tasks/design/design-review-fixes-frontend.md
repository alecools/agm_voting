# Technical Design — Frontend Review Fixes

**Status:** Draft

PRD reference: `tasks/prd/prd-review-recommendations.md`

---

## Overview

This document covers the design for fixing all frontend, accessibility, and platform findings from the engineering review. There are no backend or database changes — all changes are confined to the React frontend.

**Schema migration required: No**

---

## Findings and Design

### FRONTEND-1 + QA-1: `useAutoSave` first-mount bug and eslint suppression

**File:** `frontend/src/hooks/useAutoSave.ts`

**Root cause:** The `useEffect` that depends on `[choice]` runs on the initial mount. The existing guard `if (debounceRef.current !== null)` only conditionally clears an existing timer — it does not prevent starting a new 400ms timer. 400ms after mount, `doSave()` is called with whatever `choice` was at mount time (often `null`), which overwrites the stored draft with `null`.

The `eslint-disable` on line 48 suppresses a real warning: `doSave` is used inside the effect but absent from the deps array.

**Fix:**

Add an `isFirstMount` ref initialised to `true`. At the top of the `useEffect`, if `isFirstMount.current` is `true`, set it to `false` and return early — this skips the timer entirely on the initial mount cycle.

Remove the `eslint-disable` comment and add `doSave` to the dependency array. `doSave` is already a `useCallback` with `[meetingId, motionId]` as deps, so its reference is stable and adding it to the effect deps is safe — the effect will only re-run when `choice`, `meetingId`, or `motionId` change, which is correct.

Correct implementation sketch (design reference only):
```
const isFirstMount = useRef(true);

useEffect(() => {
  if (isFirstMount.current) {
    isFirstMount.current = false;
    return;
  }
  if (debounceRef.current !== null) {
    clearTimeout(debounceRef.current);
  }
  debounceRef.current = setTimeout(() => {
    doSave();
  }, 400);
  return () => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
  };
}, [choice, doSave]); // doSave added — safe because it is a stable useCallback
```

**Test plan:**
- Unit test: render hook with `choice: null`; assert `saveDraft` is NOT called within 500ms
- Unit test: render hook then change `choice` to `"yes"`; assert `saveDraft` IS called after debounce
- Unit test: change `choice` twice rapidly; assert `saveDraft` is called exactly once (debounce cancels prior timer)
- Unit test: `saveNow()` called directly; assert `saveDraft` is called immediately, debounce timer cleared

---

### PLATFORM-1: Vite 5→8, vitest 1→4, @vitejs/plugin-react v4→v6

**File:** `frontend/package.json`, `frontend/vite.config.ts`

**Current installed versions (per package.json):**
- `vite`: `^8.0.0`
- `vitest`: `^4.1.2`
- `@vitejs/plugin-react`: `^6.0.1`
- `react`: `^19.2.4`
- `react-router-dom`: `^7.14.0`
- `typescript`: `^6.0.2`
- `jsdom`: `^29.0.1`

The `package.json` already declares Vite 8, vitest 4, and @vitejs/plugin-react 6. PLATFORM-1 and PLATFORM-3 are therefore already resolved at the package.json level. The implement agent must verify `node_modules` contains the correct versions by running `npm ls vite vitest @vitejs/plugin-react jsdom` in the frontend directory and run `npm install` if the lock file is stale.

**Breaking changes to verify for this stack:**

Vite 8 (from Vite 5):
- `vite.config.ts` `test` block: `environment: "jsdom"` — still valid.
- `build.rollupOptions.output.manualChunks` function form — still supported.
- `server.proxy` — unchanged API.
- `vite-plugin-compression2` must be compatible with Vite 8; check peer deps.

vitest 4 (from vitest 1):
- `globals: true` — still valid.
- `coverage.provider: "v8"` — still valid.
- `coverage.thresholds` per-file key syntax — unchanged in vitest 4.
- `setupFiles` and `exclude` patterns — unchanged.

@vitejs/plugin-react v6 (from v4):
- No API change to `react()` default import with no options.
- Requires `react >= 18`; project uses React 19 — compatible.

React 19 + react-router-dom v7:
- Both declared in `package.json`. No config-file changes needed.
- The implement agent must run the full test suite and confirm it passes.

**Action:** Run `npm install` in `frontend/` to ensure `node_modules` matches `package.json`. Then run `npm run test:coverage`. If any test fails due to an API change, record the specific error and report to the orchestrator — do not speculatively fix. No `vite.config.ts` changes are expected.

**Test plan:**
- `npm run test:coverage` passes with 100% coverage
- `npm run build` completes without error
- `npm run lint` passes

---

### PLATFORM-3: jsdom@25 → jsdom@29

`package.json` already declares `"jsdom": "^29.0.1"`. This finding is resolved at the package.json level. The implement agent must verify with `npm ls jsdom`.

---

### ACCESSIBILITY-2: Vote buttons lack motion-title context in `aria-label`

**File:** `frontend/src/components/vote/MotionCard.tsx` and `frontend/src/components/vote/VoteButton.tsx`

**Problem:** `VoteButton` renders with only `aria-pressed` to convey selection state. A screen reader announces "For, toggle button, pressed" with no context about which motion the button belongs to.

**Fix:** Add an optional `ariaLabel?: string` prop to `VoteButton`. When provided, set `aria-label={ariaLabel}` on the `<button>`. When absent, no `aria-label` attribute is set (backward-compatible).

In `MotionCard`, compute the motion display label once before the choices map:
```
const motionLabel = `Motion ${motion.motion_number?.trim() || position}`;
```

Pass `ariaLabel` to each `VoteButton` using the display label from `LABELS` in `VoteButton` (which maps `VoteChoice` to "For", "Against", "Abstain"). To avoid importing `LABELS` from `VoteButton` into `MotionCard`, define a small inline map in `MotionCard` for aria-label generation:
```
const ARIA_ACTION_LABELS: Record<VoteChoice, string> = {
  yes: "For",
  no: "Against",
  abstained: "Abstain",
  not_eligible: "Not Eligible",
  selected: "Selected",
};
```

Then pass: `ariaLabel={`Vote ${ARIA_ACTION_LABELS[c]} for ${motionLabel}`}`

This produces labels like "Vote For for Motion 1", "Vote Against for Motion 1A".

**Test plan:**
- Unit test: render `MotionCard` with a motion; assert each VoteButton has `aria-label` matching `"Vote For for Motion 1"`, `"Vote Against for Motion 1"`, `"Vote Abstain for Motion 1"`
- Unit test: when `motion.motion_number` is set (e.g. `"1A"`), aria-label uses the trimmed number: `"Vote For for Motion 1A"`
- Unit test: `VoteButton` with no `ariaLabel` prop does not set `aria-label` attribute

---

### ACCESSIBILITY-3: Focus not returned to trigger element when ChannelModal closes

**File:** `frontend/src/pages/vote/AuthPage.tsx` and `frontend/src/components/vote/AuthForm.tsx`

**Problem:** When `ChannelModal` closes (via Cancel or Send code confirm), focus is left at the document body. Screen reader users lose their position in the page.

**Fix:** Add a `triggerRef?: React.RefObject<HTMLButtonElement>` prop to `AuthForm`. Inside `AuthForm`, attach this ref to the "Send Verification Code" submit button. In `AuthPage`:

```
const sendCodeButtonRef = useRef<HTMLButtonElement>(null);
```

Pass `triggerRef={sendCodeButtonRef}` to `AuthForm`.

Use a `useEffect` in `AuthPage` to detect when the modal transitions from open to closed and return focus:

```
const prevShowModalRef = useRef(false);
useEffect(() => {
  if (prevShowModalRef.current && !showChannelModal) {
    sendCodeButtonRef.current?.focus();
  }
  prevShowModalRef.current = showChannelModal;
}, [showChannelModal]);
```

This fires only on the open→closed transition, not on the initial mount or when the modal opens.

**Test plan:**
- Unit test: after modal closes via cancel, `sendCodeButtonRef.current.focus` is called
- Unit test: after modal closes via confirm (channel send succeeds), focus is returned
- Unit test: modal opening does not incorrectly trigger focus restoration
- Existing AuthPage and AuthForm tests must still pass

---

### ACCESSIBILITY-4: CountdownTimer milestone announcements

**File:** `frontend/src/components/vote/CountdownTimer.tsx`

**Current state:** The running timer already uses `aria-live="polite"` (line 37 in current file) and the expired state uses `aria-live="assertive"` (line 27). The running timer still announces on every second update via the polite region.

**Fix:** Change the running timer's `aria-live` to `"off"` to eliminate per-second screen reader interruptions. Add a separate hidden `aria-live="assertive"` region for milestone announcements at 5 minutes and 1 minute remaining.

Track announced milestones with refs to prevent repeated announcements:
```
const announced5min = useRef(false);
const announced1min = useRef(false);
```

Compute `milestoneMessage`:
- When `secondsRemaining <= 300 && secondsRemaining > 295` and `announced5min.current` is false: message is "5 minutes remaining", set `announced5min.current = true`
- When `secondsRemaining <= 60 && secondsRemaining > 55` and `announced1min.current` is false: message is "1 minute remaining", set `announced1min.current = true`
- Otherwise: empty string `""`

Add a visually-hidden milestone announcement region (using `className="sr-only"` — the CSS class already exists in the project for screen-reader-only content):
```
<span
  className="sr-only"
  aria-live="assertive"
  aria-atomic="true"
>
  {milestoneMessage}
</span>
```

The screen reader only announces when this region's text content changes from empty to a non-empty string.

**Test plan:**
- Unit test: at exactly 300 seconds remaining, `milestoneMessage` is "5 minutes remaining"
- Unit test: at 299 seconds remaining (second tick), `milestoneMessage` is `""` (announced5min already true)
- Unit test: at exactly 60 seconds remaining, `milestoneMessage` is "1 minute remaining"
- Unit test: expired state renders `aria-live="assertive"` div with "Voting has closed"
- Unit test: running timer div has `aria-live="off"` after the fix
- Existing CountdownTimer tests must still pass

---

### FRONTEND-2: `VotingPage.tsx` god component extraction

**File:** `frontend/src/pages/vote/VotingPage.tsx`

**Problem:** The file is ~817 lines mixing state management, submission logic, and JSX.

**Fix:** Extract two custom hooks.

**`useVotingState` hook** — new file `frontend/src/hooks/useVotingState.ts`:

Parameters: `meetingId: string | undefined`, `motions: MotionOut[] | undefined`, `isMotionReadOnly: (m: { id: string }) => boolean`

Returns:
- `choices: Record<string, VoteChoice | null>`
- `multiChoiceSelections: Record<string, OptionChoiceMap>`
- `highlightUnanswered: boolean`
- `setHighlightUnanswered: (v: boolean) => void`
- `handleChoiceChange: (motionId: string, choice: VoteChoice | null) => void`
- `handleMultiChoiceChange: (motionId: string, newChoices: OptionChoiceMap) => void`
- `answeredCount: number`
- `unansweredMotions: MotionOut[]`

The `useEffect` that seeds `choices` and `multiChoiceSelections` from motions (currently lines 183–218) moves into this hook. The sessionStorage persistence for `multiChoiceSelections` (in `handleMultiChoiceChange`) also moves here.

The `answeredCount` and `unansweredMotions` derived values (currently lines 481–491) also move here. They depend on `unvotedMotions` (motions that are neither read-only nor individually closed), which requires `isMotionIndividuallyClosed` — this predicate should be passed in or computed from parameters. The cleanest approach: the hook accepts the already-filtered `unvotedMotions: MotionOut[]` array as a parameter rather than re-deriving it, keeping the hook's scope narrow.

**`useMotionSubmission` hook** — new file `frontend/src/hooks/useMotionSubmission.ts`:

Parameters: `meetingId: string | undefined`, `motions: MotionOut[] | undefined`, `isMultiLot: boolean`, `selectedIds: Set<string>`, `allLots: LotInfo[]`, `isMotionReadOnly: (m: { id: string }) => boolean`

Returns:
- `isPending: boolean`
- `handleConfirm: (params: { choices: Record<string, VoteChoice | null>; multiChoiceSelections: Record<string, OptionChoiceMap> }) => void`
- `handleCancel: () => void`

The hook takes callbacks for side effects it needs to trigger: `onSuccess`, `onError` callbacks passed as parameters, or it returns state setters. The simplest approach: the hook calls `navigate` and returns `isPending`. The `setAllLots`, `setSelectedIds`, `setMultiChoiceSelections`, `setIsClosed`, `setShowDialog` calls happen via callbacks passed in as parameters.

Alternatively — and cleaner — `useMotionSubmission` accepts a single `callbacks` object with the required setters and returns only `{ isPending, handleConfirm, handleCancel }`. VotingPage passes its state setters directly.

**VotingPage after extraction:** Retains all `useEffect` blocks (session restore, lot loading, polling — page-lifecycle concerns), all lot-selection handlers, and the JSX. The page orchestrates hook outputs into the render.

**Coverage requirement:** Both new hook files must achieve 100% line coverage. Add them to `vite.config.ts` coverage `include`:
```
"src/hooks/useVotingState.ts",
"src/hooks/useMotionSubmission.ts",
```

**Test plan:**
- `useVotingState`: unit tests for choice change, multi-choice change (verify sessionStorage write), seeding read-only motions on motions load, not seeding interactive motions, `answeredCount` and `unansweredMotions` derivations
- `useMotionSubmission`: unit tests for `handleConfirm` payload (excludes read-only motions, excludes `"selected"` sentinel), `onSuccess` sessionStorage update and state mutations, `onError` 409 → navigate to confirmation, 403 → `setIsClosed`
- VotingPage: existing coverage must not regress; the page's tests verify integration of the extracted hooks

---

### CODE-2: `any` casts in `GeneralMeetingDetailPage.tsx`

**File:** `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`, lines ~442 and ~453

**Line 442 — `setQueryData` updater `(old: any)`:**

`setQueryData`'s updater receives `TData | undefined` where `TData` is the query's data type. The query at key `["admin", "general-meetings", meetingId]` returns `GeneralMeetingDetail`. Replace:
```
(old: any) => {
  ...
  motions: old.motions.map((m: any) => ...)
```
with:
```
(old: GeneralMeetingDetail | undefined): GeneralMeetingDetail | undefined => {
  if (!old) return old;
  return {
    ...old,
    motions: old.motions.map((m: MotionDetail) =>
      m.id === motionId ? { ...m, is_visible: isVisible } : m
    ),
  };
}
```

`GeneralMeetingDetail` and `MotionDetail` are already imported at line 15.

**Line 453 — `onError` context parameter `context: any`:**

The `context` type in `useMutation`'s `onError` is the resolved return type of `onMutate`. The `onMutate` callback returns `{ previous }` where `previous = queryClient.getQueryData(["admin", "general-meetings", meetingId])` typed as `GeneralMeetingDetail | undefined`. So `context` is `{ previous: GeneralMeetingDetail | undefined } | undefined`. Replace:
```
onError: (error: Error, variables, context: any) => {
```
with:
```
onError: (error: Error, variables, context: { previous: GeneralMeetingDetail | undefined } | undefined) => {
```

No new imports required.

**Test plan:**
- `npm run lint` (TypeScript strict) passes with no `any` errors in this file
- Existing `GeneralMeetingDetailPage` unit tests pass

---

### ACCESSIBILITY-1: ChannelModal inline styles bypassing design system

**File:** `frontend/src/pages/vote/AuthPage.tsx` (the `ChannelModal` component, lines ~47–147) and `frontend/src/styles/index.css`

**Problem:** All interior content of `ChannelModal` uses inline `style` props. Per design system section 8, only the modal backdrop div and panel shell may use inline styles; interior content must use CSS classes.

**What stays as inline styles (per design system section 8 exception):**
- Backdrop div: `position: "fixed"`, `inset: 0`, `background: "rgba(0,0,0,0.4)"`, `display: "flex"`, `alignItems: "center"`, `justifyContent: "center"`, `zIndex: 1000`
- Panel div: `background: "#fff"`, `borderRadius: "var(--r-md)"`, `padding: 32`, `minWidth: 320`, `maxWidth: 440`, `width: "100%"`, `boxShadow: "var(--shadow-lg)"`

**What must move to CSS classes:**

| Element | Current inline style | New class |
|---|---|---|
| `<h2>` | `marginTop: 0, marginBottom: 20, fontSize: "1.2rem"` | `.channel-modal__heading` |
| `<div role="radiogroup">` | `marginBottom: 16` | `.channel-modal__radiogroup` |
| `<label>` (email radio) | `display: flex, alignItems: center, gap: 10, marginBottom: 12, cursor: pointer` | `.channel-modal__radio-label` |
| `<label>` (sms radio) | `display: flex, alignItems: center, gap: 10, cursor: pointer` | `.channel-modal__radio-label` (last-child variant for no bottom margin) |
| `<p className="field__error">` | `marginBottom: 16` | Remove inline style; add margin to `.field__error` scoped inside `.channel-modal` or to a `.channel-modal__error` modifier |
| `<div>` (action buttons) | `display: flex, gap: 8, justifyContent: flex-end` | `.channel-modal__actions` |

**New CSS rules to add to `frontend/src/styles/index.css`:**
```
.channel-modal__heading {
  margin-top: 0;
  margin-bottom: 20px;
  font-size: 1.2rem;
}
.channel-modal__radiogroup {
  margin-bottom: 16px;
}
.channel-modal__radio-label {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  margin-bottom: 12px;
}
.channel-modal__radio-label:last-child {
  margin-bottom: 0;
}
.channel-modal__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.channel-modal .field__error {
  margin-bottom: 16px;
}
```

Add `className="channel-modal"` to the panel `<div>` to scope the `.field__error` override.

**Test plan:**
- `grep -n 'style=' frontend/src/pages/vote/AuthPage.tsx` — only the backdrop and panel shell divs should match (2 elements)
- Existing AuthPage tests pass
- No visual regression in the modal layout

---

### FRONTEND-3: `handleAuthSuccess` convoluted type expression

**File:** `frontend/src/pages/vote/AuthPage.tsx`, line ~166

**Problem:** The `data` parameter type is:
```ts
Parameters<typeof verifyAuth>[0] extends infer _R ? Awaited<ReturnType<typeof verifyAuth>> : never
```
This is an unnecessarily complex conditional type. It evaluates to `AuthVerifyResponse`, which is already exported from `../../api/voter`.

**Fix:** Replace with:
```ts
const handleAuthSuccess = useCallback((data: AuthVerifyResponse) => {
```
Add `AuthVerifyResponse` to the existing import from `../../api/voter`.

**Test plan:**
- `npm run lint` passes
- Existing AuthPage tests pass without modification (no runtime behaviour change)

---

## Files to Change

| File | Change |
|---|---|
| `frontend/src/hooks/useAutoSave.ts` | Add `isFirstMount` ref; add `doSave` to deps array; remove eslint-disable comment |
| `frontend/src/hooks/useVotingState.ts` | New file — choice and multi-choice state management extracted from VotingPage |
| `frontend/src/hooks/useMotionSubmission.ts` | New file — submit mutation and handlers extracted from VotingPage |
| `frontend/src/pages/vote/VotingPage.tsx` | Remove extracted state/logic; wire the two new hooks |
| `frontend/src/components/vote/VoteButton.tsx` | Add optional `ariaLabel?: string` prop |
| `frontend/src/components/vote/MotionCard.tsx` | Compute motion label; pass `ariaLabel` to each `VoteButton` |
| `frontend/src/components/vote/CountdownTimer.tsx` | Change running timer to `aria-live="off"`; add milestone announcement region |
| `frontend/src/pages/vote/AuthPage.tsx` | ACCESSIBILITY-1: replace interior modal inline styles with CSS classes; ACCESSIBILITY-3: add `sendCodeButtonRef` and focus restoration effect; FRONTEND-3: replace complex type with `AuthVerifyResponse` |
| `frontend/src/components/vote/AuthForm.tsx` | Add optional `triggerRef` prop; attach to send button |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Replace `any` casts with `GeneralMeetingDetail | undefined` and `MotionDetail` |
| `frontend/src/styles/index.css` | Add `.channel-modal__*` CSS classes |
| `frontend/vite.config.ts` | Add new hook files to coverage `include` array |
| `frontend/tests/` (existing test files) | Update unit tests for all changed files to maintain 100% coverage |

---

## Security Considerations

No security implications. All changes are accessibility improvements, type safety fixes, and component refactoring. No new endpoints, no user-input validation changes, no session or cookie modifications.

---

## E2E Test Scenarios

### Affected persona journeys

- **Voter** (auth → lot selection → voting → confirmation): affected by `useAutoSave` fix, `CountdownTimer` change, `VotingPage` extraction, `MotionCard` aria-label
- **Proxy voter**: same voting flow as voter

Existing E2E specs for the voter workflow must be re-run after all changes and must pass. No entirely new E2E flows are introduced.

### Scenarios to verify (existing specs)

1. **Happy path voter flow** — auth → vote all motions → submit → confirmation. Ensures the VotingPage refactor and useAutoSave fix do not break the golden path.
2. **Re-vote (already submitted)** — returning voter sees previously submitted choices as read-only. Ensures choice seeding in `useVotingState` works correctly post-extraction.
3. **Multi-lot voter** — select/deselect lots, submit on behalf of selected lots. Ensures `useMotionSubmission` extraction does not break lot-scoped submission.
4. **Channel selector modal — focus restoration** (new assertion in existing auth spec): after the channel modal appears and user presses Cancel, assert the "Send Verification Code" button has browser focus.

### Multi-step sequence

Auth → channel modal → cancel → re-submit with email OTP → vote → submit. This sequence verifies that the focus restoration (ACCESSIBILITY-3) and the modal close flow do not leave the form in a broken state for subsequent attempts.
