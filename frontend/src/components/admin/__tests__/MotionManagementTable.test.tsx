import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DragEndEvent } from "@dnd-kit/core";
import { TouchSensor } from "@dnd-kit/core";
import MotionManagementTable from "../MotionManagementTable";
import type { MotionManagementTableProps } from "../MotionManagementTable";
import type { MotionDetail } from "../../../api/admin";

// ---------------------------------------------------------------------------
// Capture DndContext's onDragEnd so we can fire synthetic drag events
// ---------------------------------------------------------------------------

let capturedOnDragEnd: ((event: DragEndEvent) => void) | null = null;
const useSensorSpy = vi.fn();

vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
  return {
    ...actual,
    useSensor: (...args: Parameters<typeof actual.useSensor>) => {
      useSensorSpy(...args);
      return actual.useSensor(...args);
    },
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd?: (e: DragEndEvent) => void }) => {
      capturedOnDragEnd = onDragEnd ?? null;
      return <>{children}</>;
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMotion(
  id: string,
  title: string,
  order: number,
  opts: Partial<MotionDetail> = {}
): MotionDetail {
  return {
    id,
    title,
    description: null,
    display_order: order,
    motion_number: null,
    motion_type: "general",
    is_visible: true,
    option_limit: null,
    options: [],
    tally: {
      yes: { voter_count: 0, entitlement_sum: 0 },
      no: { voter_count: 0, entitlement_sum: 0 },
      abstained: { voter_count: 0, entitlement_sum: 0 },
      absent: { voter_count: 0, entitlement_sum: 0 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
      options: [],
    },
    voter_lists: { yes: [], no: [], abstained: [], absent: [], not_eligible: [], options: {} },
    ...opts,
  };
}

const MOTION_A = makeMotion("m1", "Alpha Motion", 1, { motion_number: "1", description: "Alpha desc" });
const MOTION_B = makeMotion("m2", "Beta Motion", 2);
const MOTION_C = makeMotion("m3", "Gamma Motion", 3, { motion_type: "special" });

const HIDDEN_A = makeMotion("m-h1", "Hidden Alpha", 1, { is_visible: false });

function defaultProps(overrides: Partial<MotionManagementTableProps> = {}): MotionManagementTableProps {
  return {
    motions: [MOTION_A, MOTION_B, MOTION_C],
    meetingStatus: "open",
    onReorder: vi.fn(),
    isReorderPending: false,
    reorderError: null,
    pendingVisibilityMotionId: null,
    isBulkLoading: false,
    motionsWithVotes: new Set<string>(),
    visibilityErrors: {},
    onToggleVisibility: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    deleteMotionErrors: {},
    ...overrides,
  };
}

function renderTable(overrides: Partial<MotionManagementTableProps> = {}) {
  const props = defaultProps(overrides);
  return { ...render(<MotionManagementTable {...props} />), props };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MotionManagementTable", () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    useSensorSpy.mockClear();
  });

  // --- Happy path ---

  it("renders all columns for open meeting", () => {
    renderTable();
    expect(screen.getByRole("columnheader", { name: "#" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Motion" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Visibility" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  it("renders all motions in order", () => {
    renderTable();
    expect(screen.getByText("Alpha Motion")).toBeInTheDocument();
    expect(screen.getByText("Beta Motion")).toBeInTheDocument();
    expect(screen.getByText("Gamma Motion")).toBeInTheDocument();
  });

  it("renders motion_number label when set", () => {
    renderTable({ motions: [MOTION_A] });
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("falls back to display_order when motion_number is null", () => {
    renderTable({ motions: [MOTION_B] });
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders description when present", () => {
    renderTable({ motions: [MOTION_A] });
    expect(screen.getByText("Alpha desc")).toBeInTheDocument();
  });

  it("renders type badges correctly", () => {
    renderTable();
    expect(screen.getAllByLabelText("Motion type: General").length).toBe(2);
    expect(screen.getByLabelText("Motion type: Special")).toBeInTheDocument();
  });

  it("renders visibility toggles checked for visible motions", () => {
    renderTable({ motions: [MOTION_A] });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    expect(screen.getByText("Visible")).toBeInTheDocument();
  });

  it("renders visibility toggles unchecked for hidden motions", () => {
    renderTable({ motions: [HIDDEN_A] });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });

  it("renders Edit and Delete buttons for open meeting", () => {
    renderTable({ motions: [HIDDEN_A] });
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  // --- Drag handles ---

  it("shows drag handles on open meeting with multiple motions", () => {
    renderTable();
    expect(screen.getByTestId("drag-handle-m1")).toBeInTheDocument();
    expect(screen.getByTestId("drag-handle-m2")).toBeInTheDocument();
  });

  it("shows drag handles on pending meeting", () => {
    renderTable({ meetingStatus: "pending" });
    expect(screen.getByTestId("drag-handle-m1")).toBeInTheDocument();
  });

  it("does not show drag handles on closed meeting", () => {
    renderTable({ meetingStatus: "closed" });
    expect(screen.queryByTestId("drag-handle-m1")).not.toBeInTheDocument();
  });

  it("does not show drag handles when only one motion", () => {
    renderTable({ motions: [MOTION_A] });
    expect(screen.queryByTestId("drag-handle-m1")).not.toBeInTheDocument();
  });

  // --- Touch sensor ---

  it("registers TouchSensor with delay+tolerance activation constraint", () => {
    renderTable();
    // useSensor is called three times: PointerSensor, TouchSensor, KeyboardSensor
    const calls = useSensorSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const touchCall = calls.find((c) => c[0] === TouchSensor);
    expect(touchCall).toBeDefined();
    expect(touchCall![1]).toEqual({
      activationConstraint: { delay: 250, tolerance: 5 },
    });
  });

  it("drag handle span has touchAction none and 44px min dimensions", () => {
    const { container } = renderTable();
    const handle = container.querySelector("[data-testid='drag-handle-m1']") as HTMLElement;
    expect(handle).toBeTruthy();
    expect(handle.style.touchAction).toBe("none");
    expect(parseInt(handle.style.minWidth)).toBeGreaterThanOrEqual(44);
    expect(parseInt(handle.style.minHeight)).toBeGreaterThanOrEqual(44);
  });

  // --- Move buttons: disabled states ---

  it("'Move to top' disabled for first motion", () => {
    renderTable();
    expect(screen.getByRole("button", { name: "Move Alpha Motion to top" })).toBeDisabled();
  });

  it("'Move to bottom' disabled for last motion", () => {
    renderTable();
    expect(screen.getByRole("button", { name: "Move Gamma Motion to bottom" })).toBeDisabled();
  });

  it("middle motion's top and bottom buttons are enabled", () => {
    renderTable();
    expect(screen.getByRole("button", { name: "Move Beta Motion to top" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Beta Motion to bottom" })).not.toBeDisabled();
  });

  it("no move buttons rendered on closed meeting", () => {
    renderTable({ meetingStatus: "closed" });
    expect(screen.queryByRole("button", { name: /Move .* to top/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move .* to bottom/ })).not.toBeInTheDocument();
  });

  it("all move buttons disabled when isReorderPending is true", () => {
    renderTable({ isReorderPending: true });
    const topBtn = screen.getByRole("button", { name: "Move Beta Motion to top" });
    const bottomBtn = screen.getByRole("button", { name: "Move Beta Motion to bottom" });
    expect(topBtn).toBeDisabled();
    expect(bottomBtn).toBeDisabled();
  });

  // --- Move button interactions ---

  it("clicking 'Move to top' calls onReorder placing item first", async () => {
    const user = userEvent.setup();
    const { props } = renderTable();
    await user.click(screen.getByRole("button", { name: "Move Gamma Motion to top" }));
    expect(props.onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = (props.onReorder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(newOrder[0].id).toBe("m3");
    expect(newOrder[1].id).toBe("m1");
    expect(newOrder[2].id).toBe("m2");
  });

  it("clicking 'Move to bottom' calls onReorder placing item last", async () => {
    const user = userEvent.setup();
    const { props } = renderTable();
    await user.click(screen.getByRole("button", { name: "Move Alpha Motion to bottom" }));
    expect(props.onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = (props.onReorder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(newOrder[0].id).toBe("m2");
    expect(newOrder[1].id).toBe("m3");
    expect(newOrder[2].id).toBe("m1");
  });

  // --- Drag-end handler ---

  it("handleDragEnd: reorders and calls onReorder when different items swapped", () => {
    const { props } = renderTable();
    act(() => {
      capturedOnDragEnd!({
        active: { id: "m3", data: { current: undefined } } as DragEndEvent["active"],
        over: { id: "m1", disabled: false, data: { current: undefined }, rect: { current: { initial: null, translated: null } } } as unknown as DragEndEvent["over"],
        activatorEvent: {} as Event,
        collisions: null,
        delta: { x: 0, y: 0 },
      } as DragEndEvent);
    });
    expect(props.onReorder).toHaveBeenCalledOnce();
    const newOrder: MotionDetail[] = (props.onReorder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(newOrder[0].id).toBe("m3");
  });

  // --- Reorder error ---

  it("shows reorder error message when reorderError is set", () => {
    renderTable({ reorderError: "Failed to reorder" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Failed to reorder")).toBeInTheDocument();
  });

  it("does not show reorder error alert when reorderError is null", () => {
    renderTable({ reorderError: null });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // --- Visibility toggle ---

  it("clicking toggle calls onToggleVisibility", async () => {
    const user = userEvent.setup();
    const { props } = renderTable({ motions: [MOTION_A] });
    await user.click(screen.getByRole("checkbox"));
    expect(props.onToggleVisibility).toHaveBeenCalledWith("m1", false);
  });

  it("toggle is disabled when meeting is closed", () => {
    renderTable({ meetingStatus: "closed", motions: [MOTION_A] });
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("toggle is disabled when motion has votes", () => {
    renderTable({ motionsWithVotes: new Set(["m1"]), motions: [MOTION_A] });
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("toggle is disabled during bulk loading", () => {
    renderTable({ isBulkLoading: true, motions: [MOTION_A] });
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("toggle shows loading state when pendingVisibilityMotionId matches", () => {
    renderTable({ pendingVisibilityMotionId: "m1", motions: [MOTION_A] });
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("shows visibility error per-row", () => {
    renderTable({
      motions: [MOTION_A],
      visibilityErrors: { m1: "Cannot hide: motion has received votes" },
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Cannot hide: motion has received votes")).toBeInTheDocument();
  });

  it("shows 'Meeting is closed' as disabled title when closed", () => {
    const { container } = renderTable({ meetingStatus: "closed", motions: [MOTION_A] });
    const label = container.querySelector(".motion-visibility-toggle");
    expect(label).toHaveAttribute("title", "Meeting is closed");
  });

  it("shows 'Motion has received votes' as disabled title", () => {
    const { container } = renderTable({ motionsWithVotes: new Set(["m1"]), motions: [MOTION_A] });
    const label = container.querySelector(".motion-visibility-toggle");
    expect(label).toHaveAttribute("title", "Motion has received votes");
  });

  // --- Edit/Delete buttons ---

  it("Edit and Delete buttons disabled when motion is visible", () => {
    renderTable({ motions: [MOTION_A] });
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("Edit and Delete buttons enabled when motion is hidden", () => {
    renderTable({ motions: [HIDDEN_A] });
    expect(screen.getByRole("button", { name: "Edit" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).not.toBeDisabled();
  });

  it("Edit and Delete buttons hidden when meeting is closed", () => {
    renderTable({ meetingStatus: "closed", motions: [HIDDEN_A] });
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("Actions column header hidden when meeting is closed", () => {
    renderTable({ meetingStatus: "closed" });
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("disabled Edit/Delete buttons have correct tooltip", () => {
    renderTable({ motions: [MOTION_A] });
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute(
      "title",
      "Hide this motion first to edit or delete"
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
      "title",
      "Hide this motion first to edit or delete"
    );
  });

  it("clicking Edit calls onEdit with the motion", async () => {
    const user = userEvent.setup();
    const { props } = renderTable({ motions: [HIDDEN_A] });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(props.onEdit).toHaveBeenCalledWith(HIDDEN_A);
  });

  it("clicking Delete calls onDelete with the motion id", async () => {
    const user = userEvent.setup();
    const { props } = renderTable({ motions: [HIDDEN_A] });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDelete).toHaveBeenCalledWith("m-h1");
  });

  it("shows delete error per-row", () => {
    renderTable({
      motions: [HIDDEN_A],
      deleteMotionErrors: { "m-h1": "Failed to delete motion" },
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Failed to delete motion")).toBeInTheDocument();
  });

  // --- Muted styling ---

  it("applies muted class on data cells for hidden motions", () => {
    const { container } = renderTable({ motions: [HIDDEN_A] });
    const mutedCells = container.querySelectorAll(".admin-table__cell--muted");
    expect(mutedCells.length).toBe(3); // #, Motion, Type cells
  });

  it("does not apply muted class for visible motions", () => {
    const { container } = renderTable({ motions: [MOTION_A] });
    const mutedCells = container.querySelectorAll(".admin-table__cell--muted");
    expect(mutedCells.length).toBe(0);
  });

  // --- Prop updates (re-sync) ---

  it("updates displayed order when motions prop changes", () => {
    const { rerender } = render(
      <MotionManagementTable {...defaultProps({ motions: [MOTION_A, MOTION_B] })} />
    );
    const swapped = [{ ...MOTION_B, display_order: 1 }, { ...MOTION_A, display_order: 2 }];
    rerender(
      <MotionManagementTable {...defaultProps({ motions: swapped })} />
    );
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Beta Motion");
  });

  // --- Boundary values ---

  it("renders correctly with exactly two motions", () => {
    renderTable({ motions: [MOTION_A, MOTION_B] });
    expect(screen.getByRole("button", { name: "Move Alpha Motion to top" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Beta Motion to bottom" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Alpha Motion to bottom" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Beta Motion to top" })).not.toBeDisabled();
  });

  // --- Edit button classes ---

  it("Edit button has btn--secondary class", () => {
    renderTable({ motions: [HIDDEN_A] });
    expect(screen.getByRole("button", { name: "Edit" })).toHaveClass("btn--secondary");
  });

  it("Delete button has btn--danger class", () => {
    renderTable({ motions: [HIDDEN_A] });
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn--danger");
  });

  // --- Edge: delete error not shown on closed meeting ---

  it("does not show delete error row when meeting is closed (no actions column)", () => {
    renderTable({
      meetingStatus: "closed",
      motions: [HIDDEN_A],
      deleteMotionErrors: { "m-h1": "Failed to delete motion" },
    });
    expect(screen.queryByText("Failed to delete motion")).not.toBeInTheDocument();
  });

  // --- Multi-choice motion type badge (RR3-48) ---

  it("shows General type badge for a general multi-choice motion", () => {
    const MC_GENERAL = makeMotion("mc1", "Board Election", 4, {
      motion_type: "general",
      is_multi_choice: true,
      option_limit: 2,
      options: [
        { id: "opt-1", text: "Alice", display_order: 1 },
        { id: "opt-2", text: "Bob", display_order: 2 },
      ],
    });
    renderTable({ motions: [MC_GENERAL] });
    const typeBadge = screen.getByLabelText("Motion type: General");
    expect(typeBadge).toHaveClass("motion-type-badge--general");
    expect(typeBadge).toHaveTextContent("General");
  });

  it("shows Special type badge for a special multi-choice motion", () => {
    const MC_SPECIAL = makeMotion("mc2", "Special Election", 5, {
      motion_type: "special",
      is_multi_choice: true,
      option_limit: 1,
      options: [
        { id: "opt-1", text: "Alice", display_order: 1 },
      ],
    });
    renderTable({ motions: [MC_SPECIAL] });
    const typeBadge = screen.getByLabelText("Motion type: Special");
    expect(typeBadge).toHaveClass("motion-type-badge--special");
    expect(typeBadge).toHaveTextContent("Special");
  });

  it("shows secondary multi-choice indicator with option count", () => {
    const MC_MOTION = makeMotion("mc3", "Board Election", 6, {
      motion_type: "general",
      is_multi_choice: true,
      option_limit: 2,
      options: [
        { id: "opt-1", text: "Alice", display_order: 1 },
        { id: "opt-2", text: "Bob", display_order: 2 },
        { id: "opt-3", text: "Carol", display_order: 3 },
      ],
    });
    renderTable({ motions: [MC_MOTION] });
    const indicator = screen.getByLabelText("Voting mechanism: Multi-choice (3 options)");
    expect(indicator).toHaveTextContent("Multi-choice (3 options)");
  });

  it("shows secondary multi-choice indicator without count when options is empty", () => {
    const MC_NO_OPTS = makeMotion("mc4", "Election", 7, {
      motion_type: "general",
      is_multi_choice: true,
      option_limit: 1,
      options: [],
    });
    renderTable({ motions: [MC_NO_OPTS] });
    const indicator = screen.getByLabelText("Voting mechanism: Multi-choice");
    expect(indicator).toHaveTextContent("Multi-choice");
    expect(indicator).not.toHaveTextContent("options");
  });

  it("does not show multi-choice indicator for standard single-choice motions", () => {
    renderTable({ motions: [MOTION_A] });
    expect(screen.queryByLabelText(/Voting mechanism/)).not.toBeInTheDocument();
  });
});
