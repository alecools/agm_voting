import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionCard } from "../MotionCard";

const motion = {
  id: "mot-001",
  title: "Approve budget",
  description: "The annual budget",
  display_order: 1,
  motion_number: null,
  motion_type: "general" as const,
  is_multi_choice: false,
  is_visible: true,
  already_voted: false,
  submitted_choice: null,
  option_limit: null,
  options: [],
};

const motionNoDesc = {
  id: "mot-002",
  title: "Motion without description",
  description: null,
  display_order: 2,
  motion_number: null,
  motion_type: "general" as const,
  is_multi_choice: false,
  is_visible: true,
  already_voted: false,
  submitted_choice: null,
  option_limit: null,
  options: [],
};

const motionSpecial = {
  id: "mot-003",
  title: "Special resolution",
  description: "A special motion",
  display_order: 3,
  motion_number: null,
  motion_type: "special" as const,
  is_multi_choice: false,
  is_visible: true,
  already_voted: false,
  submitted_choice: null,
  option_limit: null,
  options: [],
};

const motionWithNumber = {
  id: "mot-004",
  title: "Special Resolution Budget",
  description: null,
  display_order: 4,
  motion_number: "SR-1",
  motion_type: "general" as const,
  is_multi_choice: false,
  is_visible: true,
  already_voted: false,
  submitted_choice: null,
  option_limit: null,
  options: [],
};

const motionMultiChoice = {
  id: "mot-mc-001",
  title: "Board Election",
  description: "Choose board members",
  display_order: 5,
  motion_number: null,
  motion_type: "general" as const,
  is_multi_choice: true,
  is_visible: true,
  already_voted: false,
  submitted_choice: null,
  option_limit: 2,
  options: [
    { id: "opt-1", text: "Alice", display_order: 1 },
    { id: "opt-2", text: "Bob", display_order: 2 },
    { id: "opt-3", text: "Carol", display_order: 3 },
  ],
};

describe("MotionCard", () => {
  it("renders motion title and description", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByText("Approve budget")).toBeInTheDocument();
    expect(screen.getByText("The annual budget")).toBeInTheDocument();
  });

  it("renders motion without description", () => {
    render(
      <MotionCard
        motion={motionNoDesc}
        position={2}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByText("Motion without description")).toBeInTheDocument();
  });

  it("renders For, Against, Abstain buttons", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByRole("button", { name: "For" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Against" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abstain" })).toBeInTheDocument();
  });

  it("shows For as pressed when choice is yes", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice="yes"
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByRole("button", { name: "For" })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onChoiceChange when For is clicked", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={onChoiceChange}
        disabled={false}
        highlight={false}
      />
    );
    await user.click(screen.getByRole("button", { name: "For" }));
    expect(onChoiceChange).toHaveBeenCalledWith("mot-001", "yes");
  });

  it("deselects when same choice clicked again", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice="yes"
        onChoiceChange={onChoiceChange}
        disabled={false}
        highlight={false}
      />
    );
    await user.click(screen.getByRole("button", { name: "For" }));
    expect(onChoiceChange).toHaveBeenCalledWith("mot-001", null);
  });

  it("does not call onChoiceChange when disabled", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={onChoiceChange}
        disabled={true}
        highlight={false}
      />
    );
    await user.click(screen.getByRole("button", { name: "For" }));
    expect(onChoiceChange).not.toHaveBeenCalled();
  });

  it("does not show a save indicator (no auto-save)", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice="yes"
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    // SaveIndicator is removed — no "Saved" or "Saving" text should appear
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saving/)).not.toBeInTheDocument();
  });

  it("highlights card when highlight is true", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={true}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).toHaveClass("motion-card--highlight");
  });

  it("does not highlight card when highlight is false", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).not.toHaveClass("motion-card--highlight");
  });

  // --- 1-based motion number display ---

  it("displays 'Motion {position}' fallback when motion_number is null", () => {
    render(
      <MotionCard
        motion={{ ...motion, motion_number: null }}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByText("Motion 1")).toBeInTheDocument();
  });

  it("displays correct 1-based position number when motion_number is null", () => {
    render(
      <MotionCard
        motion={{ ...motion, motion_number: null }}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByText("Motion 5")).toBeInTheDocument();
  });

  // --- motion_type badge tests ---

  it("shows 'General' badge for a general motion", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    const badge = screen.getByLabelText("Motion type: General");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("General");
    expect(badge).toHaveClass("motion-type-badge--general");
  });

  it("shows 'Special' badge for a special motion", () => {
    render(
      <MotionCard
        motion={motionSpecial}
        position={3}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    const badge = screen.getByLabelText("Motion type: Special");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Special");
    expect(badge).toHaveClass("motion-type-badge--special");
  });

  // --- no in-arrear locking on the card ---

  it("vote buttons are never aria-disabled — in-arrear restriction is backend-only", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    const buttons = screen.getAllByRole("button", { name: /For|Against|Abstain/ });
    buttons.forEach((btn) => {
      expect(btn).not.toHaveAttribute("aria-disabled", "true");
    });
  });

  // --- motion_number label tests ---

  it("displays motion_number prefixed with 'Motion' when it is set", () => {
    render(
      <MotionCard
        motion={motionWithNumber}
        position={4}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByText("Motion SR-1")).toBeInTheDocument();
  });

  it("falls back to 'Motion {position}' label when motion_number is null", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByText("Motion 1")).toBeInTheDocument();
  });

  it("falls back to 'Motion {position}' label when motion_number is empty string after trim", () => {
    const motionEmptyNumber = { ...motion, motion_number: "   " };
    render(
      <MotionCard
        motion={motionEmptyNumber}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByText("Motion 5")).toBeInTheDocument();
  });

  // --- US-ACC-04: non-colour cues ---

  it("shows '✓ Already voted' badge (non-colour cue) when readOnly is true", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice="yes"
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        readOnly={true}
      />
    );
    const badge = screen.getByLabelText("Already voted");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("✓ Already voted");
  });

  it("does not show 'Already voted' badge when readOnly is false", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        readOnly={false}
      />
    );
    expect(screen.queryByLabelText("Already voted")).not.toBeInTheDocument();
  });

  // --- US-CQM-06: read-only modifier class ---

  it("applies motion-card--read-only class when readOnly is true", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice="yes"
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        readOnly={true}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).toHaveClass("motion-card--read-only");
  });

  it("does not apply motion-card--read-only class when readOnly is false", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        readOnly={false}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).not.toHaveClass("motion-card--read-only");
  });

  // --- US-ACC-04: highlight has non-colour text indicator ---

  it("shows '! Unanswered' badge (non-colour text cue) when highlight is true", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={true}
      />
    );
    const badge = screen.getByLabelText("Unanswered");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("! Unanswered");
  });

  it("does not show 'Unanswered' badge when highlight is false", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.queryByLabelText("Unanswered")).not.toBeInTheDocument();
  });

  it("applies motion-card--highlight class when highlight is true", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={true}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).toHaveClass("motion-card--highlight");
  });

  // --- Multi-choice motion type ---

  it("renders MultiChoiceOptionList instead of binary vote buttons for multi_choice motions", () => {
    render(
      <MotionCard
        motion={motionMultiChoice}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        multiChoiceOptionChoices={{}}
        onMultiChoiceChange={() => {}}
      />
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("shows Multi-Choice badge as a supplementary badge for multi_choice motion (Fix 6)", () => {
    render(
      <MotionCard
        motion={motionMultiChoice}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        multiChoiceOptionChoices={{}}
        onMultiChoiceChange={() => {}}
      />
    );
    // Fix 6: primary badge shows motion_type ("General"), secondary badge shows "Multi-Choice"
    const typeBadge = screen.getByLabelText("Motion type: General");
    expect(typeBadge).toHaveClass("motion-type-badge--general");
    const mcBadge = screen.getByLabelText("Multi-choice motion");
    expect(mcBadge).toHaveClass("motion-type-badge--multi_choice");
  });

  it("shows only General badge (no Multi-Choice badge) for a general non-multi-choice motion", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.getByLabelText("Motion type: General")).toBeInTheDocument();
    expect(screen.queryByLabelText("Multi-choice motion")).not.toBeInTheDocument();
  });

  it("shows votingClosed badge inside card when votingClosed=true (Fix 10)", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={true}
        highlight={false}
        votingClosed={true}
      />
    );
    const badge = screen.getByRole("status", { name: "Motion voting is closed" });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("motion-type-badge--closed");
    expect(badge).toHaveTextContent("Motion Closed");
  });

  it("does not show votingClosed badge when votingClosed=false (default)", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    expect(screen.queryByRole("status", { name: "Motion voting is closed" })).not.toBeInTheDocument();
  });

  // --- motion-card--closed CSS class ---

  it("applies motion-card--closed class when votingClosed=true", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={true}
        highlight={false}
        votingClosed={true}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).toHaveClass("motion-card--closed");
  });

  it("does not apply motion-card--closed class when votingClosed=false", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        votingClosed={false}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).not.toHaveClass("motion-card--closed");
  });

  it("disables For/Against/Abstain buttons when votingClosed=true (binary motion)", () => {
    render(
      <MotionCard
        motion={motion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={true}
        highlight={false}
        votingClosed={true}
      />
    );
    expect(screen.getByRole("button", { name: "For" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Against" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abstain" })).toBeDisabled();
  });

  it("disables multi-choice option buttons when votingClosed=true", () => {
    render(
      <MotionCard
        motion={motionMultiChoice}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={true}
        highlight={false}
        votingClosed={true}
        multiChoiceOptionChoices={{}}
        onMultiChoiceChange={() => {}}
      />
    );
    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("renders multi-choice options even when onMultiChoiceChange is not provided (fallback)", () => {
    // Exercises the `onMultiChoiceChange ?? (() => {})` fallback (line 106)
    render(
      <MotionCard
        motion={motionMultiChoice}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        multiChoiceOptionChoices={{}}
        // onMultiChoiceChange intentionally omitted
      />
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("shows motion_type as label for unknown motion type (fallback branch)", () => {
    // Exercises the `?? motion.motion_type` fallback in MOTION_TYPE_LABELS lookup
    const unknownTypeMotion = { ...motion, motion_type: "unknown_type" as "general" };
    render(
      <MotionCard
        motion={unknownTypeMotion}
        position={1}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    // Badge label falls back to "unknown_type"
    expect(screen.getByLabelText("Motion type: unknown_type")).toBeInTheDocument();
  });

  it("calls onMultiChoiceChange when MC For button is clicked", async () => {
    const user = userEvent.setup();
    const onMultiChoiceChange = vi.fn();
    render(
      <MotionCard
        motion={motionMultiChoice}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        multiChoiceOptionChoices={{}}
        onMultiChoiceChange={onMultiChoiceChange}
      />
    );
    await user.click(screen.getByTestId("mc-for-opt-1"));
    expect(onMultiChoiceChange).toHaveBeenCalledWith("mot-mc-001", { "opt-1": "for" });
  });

  it("MC option buttons are disabled when motion is readOnly", () => {
    render(
      <MotionCard
        motion={motionMultiChoice}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        readOnly={true}
        multiChoiceOptionChoices={{ "opt-1": "for" }}
        onMultiChoiceChange={() => {}}
      />
    );
    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("MC counter shows correct For count", () => {
    render(
      <MotionCard
        motion={motionMultiChoice}
        position={5}
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
        multiChoiceOptionChoices={{ "opt-1": "for", "opt-2": "for" }}
        onMultiChoiceChange={() => {}}
      />
    );
    expect(screen.getByTestId("mc-counter")).toHaveTextContent("2 voted For");
  });
});
