import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DragEndEvent } from "@dnd-kit/core";
import MotionReorderPanel from "../MotionReorderPanel";
import type { MotionDetail } from "../../../api/admin";

// ---------------------------------------------------------------------------
// Capture DndContext's onDragEnd so we can fire synthetic drag events
// ---------------------------------------------------------------------------

let capturedOnDragEnd: ((event: DragEndEvent) => void) | null = null;

vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd?: (e: DragEndEvent) => void }) => {
      capturedOnDragEnd = onDragEnd ?? null;
      return <>{children}</>;
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMotion(id: string, title: string, order: number, motionNumber: string | null = null): MotionDetail {
  return {
    id,
    title,
    description: null,
    display_order: order,
    motion_number: motionNumber,
    motion_type: "general",
    tally: {
      yes: { voter_count: 0, entitlement_sum: 0 },
      no: { voter_count: 0, entitlement_sum: 0 },
      abstained: { voter_count: 0, entitlement_sum: 0 },
      absent: { voter_count: 0, entitlement_sum: 0 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
    },
    voter_lists: {
      yes: [],
      no: [],
      abstained: [],
      absent: [],
      not_eligible: [],
    },
  };
}

const MOTION_A = makeMotion("m1", "Alpha Motion", 1, "1");
const MOTION_B = makeMotion("m2", "Beta Motion", 2, null);
const MOTION_C = makeMotion("m3", "Gamma Motion", 3, null);

function renderPanel(
  motions: MotionDetail[],
  status: string,
  onReorder = vi.fn(),
  isPending = false,
  error: string | null = null
) {
  return render(
    <MotionReorderPanel
      motions={motions}
      meetingStatus={status}
      onReorder={onReorder}
      isPending={isPending}
      error={error}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MotionReorderPanel", () => {
  // --- Happy path ---

  it("renders all motions in order", () => {
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open");
    expect(screen.getByText("Alpha Motion")).toBeInTheDocument();
    expect(screen.getByText("Beta Motion")).toBeInTheDocument();
    expect(screen.getByText("Gamma Motion")).toBeInTheDocument();
  });

  it("renders motion_number label when set", () => {
    renderPanel([MOTION_A], "open");
    // MOTION_A has motion_number "1"
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("falls back to display_order when motion_number is null", () => {
    const motion = makeMotion("mx", "Test Motion", 5, null);
    renderPanel([motion], "open");
    // display_order is 5, motion_number is null — should show "5"
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders table column headers for open meeting", () => {
    renderPanel([MOTION_A], "open");
    expect(screen.getByText("#")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });

  it("renders table column headers for closed meeting without Actions", () => {
    renderPanel([MOTION_A], "closed");
    expect(screen.getByText("#")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  // --- Editable (open/pending) state ---

  it("shows drag handles on open meeting with multiple motions", () => {
    renderPanel([MOTION_A, MOTION_B], "open");
    expect(screen.getByTestId(`drag-handle-${MOTION_A.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`drag-handle-${MOTION_B.id}`)).toBeInTheDocument();
  });

  it("shows drag handles on pending meeting", () => {
    renderPanel([MOTION_A, MOTION_B], "pending");
    expect(screen.getByTestId(`drag-handle-${MOTION_A.id}`)).toBeInTheDocument();
  });

  it("does not show drag handles on closed meeting", () => {
    renderPanel([MOTION_A, MOTION_B], "closed");
    expect(screen.queryByTestId(`drag-handle-${MOTION_A.id}`)).not.toBeInTheDocument();
  });

  it("does not show drag handles when only one motion", () => {
    renderPanel([MOTION_A], "open");
    expect(screen.queryByTestId(`drag-handle-${MOTION_A.id}`)).not.toBeInTheDocument();
  });

  // --- Move buttons: disabled states ---

  it("'Move to top' and 'Move up' disabled for first motion", () => {
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open");
    expect(screen.getByRole("button", { name: `Move ${MOTION_A.title} to top` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_A.title} up` })).toBeDisabled();
  });

  it("'Move down' and 'Move to bottom' disabled for last motion", () => {
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open");
    expect(screen.getByRole("button", { name: `Move ${MOTION_C.title} down` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_C.title} to bottom` })).toBeDisabled();
  });

  it("middle motion's all four buttons are enabled", () => {
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open");
    expect(screen.getByRole("button", { name: `Move ${MOTION_B.title} to top` })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_B.title} up` })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_B.title} down` })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_B.title} to bottom` })).not.toBeDisabled();
  });

  it("no move buttons rendered on closed meeting", () => {
    renderPanel([MOTION_A, MOTION_B], "closed");
    expect(screen.queryByRole("button", { name: /Move .* up/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move .* down/ })).not.toBeInTheDocument();
  });

  it("all buttons disabled when isPending is true", () => {
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open", vi.fn(), true);
    // Middle motion's buttons would otherwise be enabled — confirm they're disabled
    const upBtn = screen.getByRole("button", { name: `Move ${MOTION_B.title} up` });
    const downBtn = screen.getByRole("button", { name: `Move ${MOTION_B.title} down` });
    expect(upBtn).toBeDisabled();
    expect(downBtn).toBeDisabled();
  });

  // --- Move button interactions ---

  it("clicking 'Move up' calls onReorder with correct order", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open", onReorder);
    await user.click(screen.getByRole("button", { name: `Move ${MOTION_B.title} up` }));
    expect(onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = onReorder.mock.calls[0][0];
    expect(newOrder[0].id).toBe(MOTION_B.id);
    expect(newOrder[1].id).toBe(MOTION_A.id);
    expect(newOrder[2].id).toBe(MOTION_C.id);
  });

  it("clicking 'Move down' calls onReorder with correct order", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open", onReorder);
    await user.click(screen.getByRole("button", { name: `Move ${MOTION_B.title} down` }));
    expect(onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = onReorder.mock.calls[0][0];
    expect(newOrder[0].id).toBe(MOTION_A.id);
    expect(newOrder[1].id).toBe(MOTION_C.id);
    expect(newOrder[2].id).toBe(MOTION_B.id);
  });

  it("clicking 'Move to top' calls onReorder placing item first", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open", onReorder);
    await user.click(screen.getByRole("button", { name: `Move ${MOTION_C.title} to top` }));
    expect(onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = onReorder.mock.calls[0][0];
    expect(newOrder[0].id).toBe(MOTION_C.id);
    expect(newOrder[1].id).toBe(MOTION_A.id);
    expect(newOrder[2].id).toBe(MOTION_B.id);
  });

  it("clicking 'Move to bottom' calls onReorder placing item last", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open", onReorder);
    await user.click(screen.getByRole("button", { name: `Move ${MOTION_A.title} to bottom` }));
    expect(onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = onReorder.mock.calls[0][0];
    expect(newOrder[0].id).toBe(MOTION_B.id);
    expect(newOrder[1].id).toBe(MOTION_C.id);
    expect(newOrder[2].id).toBe(MOTION_A.id);
  });

  // --- Error state ---

  it("shows error message when error prop is set", () => {
    renderPanel([MOTION_A, MOTION_B], "open", vi.fn(), false, "Failed to reorder");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Failed to reorder")).toBeInTheDocument();
  });

  it("does not show error alert when error is null", () => {
    renderPanel([MOTION_A, MOTION_B], "open", vi.fn(), false, null);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // --- Prop updates (re-sync) ---

  it("updates displayed order when motions prop changes", async () => {
    const { rerender } = renderPanel([MOTION_A, MOTION_B], "open");
    // Swap the order via new prop
    const swapped = [{ ...MOTION_B, display_order: 1 }, { ...MOTION_A, display_order: 2 }];
    rerender(
      <MotionReorderPanel
        motions={swapped}
        meetingStatus="open"
        onReorder={vi.fn()}
      />
    );
    const rows = screen.getAllByRole("row");
    // First data row should now be Beta Motion
    expect(rows[1]).toHaveTextContent("Beta Motion");
  });

  // --- Boundary values ---

  it("renders correctly with exactly two motions", () => {
    renderPanel([MOTION_A, MOTION_B], "open");
    expect(screen.getByRole("button", { name: `Move ${MOTION_A.title} to top` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_B.title} to bottom` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_A.title} to bottom` })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${MOTION_B.title} to top` })).not.toBeDisabled();
  });

  it("renders motion type for each row", () => {
    renderPanel([MOTION_A, MOTION_B], "open");
    expect(screen.getAllByText("general").length).toBeGreaterThan(0);
  });

  // --- Drag-end handler (via DndContext mock) ---

  it("handleDragEnd: reorders and calls onReorder when different items swapped", () => {
    const onReorder = vi.fn();
    renderPanel([MOTION_A, MOTION_B, MOTION_C], "open", onReorder);

    // Fire synthetic drag end: move MOTION_C (id=m3) over MOTION_A (id=m1)
    act(() => {
      capturedOnDragEnd!({
        active: { id: "m3", data: { current: undefined } } as DragEndEvent["active"],
        over: { id: "m1", data: { current: undefined }, rect: { current: { initial: null, translated: null } } } as DragEndEvent["over"],
        activatorEvent: {} as Event,
        collisions: null,
        delta: { x: 0, y: 0 },
      } as DragEndEvent);
    });

    expect(onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = onReorder.mock.calls[0][0];
    expect(newOrder[0].id).toBe(MOTION_C.id);
  });
});
