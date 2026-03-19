import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionCard } from "../MotionCard";

const motion = {
  id: "mot-001",
  title: "Approve budget",
  description: "The annual budget",
  order_index: 0,
  motion_type: "general" as const,
  is_visible: true,
  already_voted: false,
};

const motionNoDesc = {
  id: "mot-002",
  title: "Motion without description",
  description: null,
  order_index: 1,
  motion_type: "general" as const,
  is_visible: true,
  already_voted: false,
};

const motionSpecial = {
  id: "mot-003",
  title: "Special resolution",
  description: "A special motion",
  order_index: 2,
  motion_type: "special" as const,
  is_visible: true,
  already_voted: false,
};

describe("MotionCard", () => {
  it("renders motion title and description", () => {
    render(
      <MotionCard
        motion={motion}
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
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).not.toHaveClass("motion-card--highlight");
  });

  // --- motion_type badge tests ---

  it("shows 'General' badge for a general motion", () => {
    render(
      <MotionCard
        motion={motion}
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
});
