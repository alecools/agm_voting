import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiChoiceOptionList, optionChoiceMapToRequest } from "../MultiChoiceOptionList";
import type { MotionOut } from "../../../api/voter";

const mcMotion: MotionOut = {
  id: "mot-mc-001",
  title: "Board Election",
  description: null,
  display_order: 1,
  motion_number: null,
  motion_type: "general",
  is_visible: true,
  already_voted: false,
  submitted_choice: null,
  submitted_option_choices: {},
  option_limit: 2,
  options: [
    { id: "opt-1", text: "Alice", display_order: 1 },
    { id: "opt-2", text: "Bob", display_order: 2 },
    { id: "opt-3", text: "Carol", display_order: 3 },
  ],
};

describe("MultiChoiceOptionList", () => {
  it("renders all option rows", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("shows counter with 0 voted For initially", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-counter")).toHaveTextContent("0 voted For");
    expect(screen.getByTestId("mc-counter")).toHaveTextContent("Select up to 2 options");
  });

  it("shows correct For count in counter when options are voted For", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for", "opt-2": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-counter")).toHaveTextContent("2 voted For");
  });

  it("calls onChoiceChange with updated map when For is clicked", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={onChoiceChange}
        disabled={false}
      />
    );
    await user.click(screen.getByTestId("mc-for-opt-1"));
    expect(onChoiceChange).toHaveBeenCalledWith("mot-mc-001", { "opt-1": "for" });
  });

  it("calls onChoiceChange with against when Against is clicked", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={onChoiceChange}
        disabled={false}
      />
    );
    await user.click(screen.getByTestId("mc-against-opt-1"));
    expect(onChoiceChange).toHaveBeenCalledWith("mot-mc-001", { "opt-1": "against" });
  });

  it("calls onChoiceChange with abstained when Abstain is clicked", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={onChoiceChange}
        disabled={false}
      />
    );
    await user.click(screen.getByTestId("mc-abstain-opt-1"));
    expect(onChoiceChange).toHaveBeenCalledWith("mot-mc-001", { "opt-1": "abstained" });
  });

  it("deselects option when same active choice is clicked again", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for" }}
        onChoiceChange={onChoiceChange}
        disabled={false}
      />
    );
    await user.click(screen.getByTestId("mc-for-opt-1"));
    expect(onChoiceChange).toHaveBeenCalledWith("mot-mc-001", {});
  });

  it("RR4-35: For button is disabled for unselected options when option_limit is reached", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for", "opt-2": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    // opt-3 is not voted For and limit is reached — its For button must be disabled
    expect(screen.getByTestId("mc-for-opt-3")).toBeDisabled();
    // opt-1 and opt-2 are already voted For — their For buttons remain enabled (deselect toggle)
    expect(screen.getByTestId("mc-for-opt-1")).not.toBeDisabled();
    expect(screen.getByTestId("mc-for-opt-2")).not.toBeDisabled();
  });

  it("RR4-35: aria-describedby is set on disabled For buttons when limit is reached", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for", "opt-2": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    const forOpt3 = screen.getByTestId("mc-for-opt-3");
    expect(forOpt3).toHaveAttribute("aria-describedby");
    const describedById = forOpt3.getAttribute("aria-describedby")!;
    const descEl = document.getElementById(describedById);
    expect(descEl).toBeInTheDocument();
    expect(descEl?.textContent).toMatch(/Maximum selections reached/i);
  });

  it("RR4-35: Maximum selections reached message is visible in DOM when limit is reached", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for", "opt-2": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByText(/Maximum selections reached/i)).toBeInTheDocument();
  });

  it("RR4-35: Maximum selections reached message is absent when limit not reached", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.queryByText(/Maximum selections reached/i)).not.toBeInTheDocument();
  });

  it("does not disable Against/Abstain buttons when limit is reached", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for", "opt-2": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-against-opt-3")).not.toBeDisabled();
    expect(screen.getByTestId("mc-abstain-opt-3")).not.toBeDisabled();
  });

  it("RR4-35: does not call onChoiceChange when For is clicked on limit-reached unselected option", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for", "opt-2": "for" }}
        onChoiceChange={onChoiceChange}
        disabled={false}
      />
    );
    await user.click(screen.getByTestId("mc-for-opt-3"));
    expect(onChoiceChange).not.toHaveBeenCalled();
  });

  it("counter shows singular 'option' for option_limit=1", () => {
    const singleLimitMotion = { ...mcMotion, option_limit: 1 };
    render(
      <MultiChoiceOptionList
        motion={singleLimitMotion}
        optionChoices={{}}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-counter")).toHaveTextContent("Select up to 1 option");
    expect(screen.getByTestId("mc-counter")).not.toHaveTextContent("options");
  });

  it("handles null option_limit gracefully (falls back to options.length)", () => {
    const noLimitMotion = { ...mcMotion, option_limit: null };
    render(
      <MultiChoiceOptionList
        motion={noLimitMotion}
        optionChoices={{}}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-counter")).toHaveTextContent("Select up to 3 options");
  });

  it("all buttons are disabled when disabled=true", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={() => {}}
        disabled={true}
      />
    );
    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("all buttons are disabled when readOnly=true", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
        readOnly={true}
      />
    );
    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("does not call onChoiceChange when readOnly=true", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={onChoiceChange}
        disabled={false}
        readOnly={true}
      />
    );
    await user.click(screen.getByTestId("mc-for-opt-1"));
    expect(onChoiceChange).not.toHaveBeenCalled();
  });

  it("does not call onChoiceChange when disabled=true", async () => {
    const user = userEvent.setup();
    const onChoiceChange = vi.fn();
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={onChoiceChange}
        disabled={true}
      />
    );
    await user.click(screen.getByTestId("mc-for-opt-1"));
    expect(onChoiceChange).not.toHaveBeenCalled();
  });

  it("wraps options in a fieldset element", () => {
    const { container } = render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(container.querySelector("fieldset")).toBeInTheDocument();
  });

  it("renders a legend with the motion title", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{}}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    const legend = document.querySelector("legend");
    expect(legend).toBeInTheDocument();
    expect(legend?.textContent).toBe("Board Election");
  });

  it("For button has aria-pressed=true when option is voted For", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "for" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-for-opt-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mc-against-opt-1")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("mc-abstain-opt-1")).toHaveAttribute("aria-pressed", "false");
  });

  it("Against button has aria-pressed=true when option is voted Against", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "against" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-against-opt-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mc-for-opt-1")).toHaveAttribute("aria-pressed", "false");
  });

  it("Abstain button has aria-pressed=true when option is set to Abstained", () => {
    render(
      <MultiChoiceOptionList
        motion={mcMotion}
        optionChoices={{ "opt-1": "abstained" }}
        onChoiceChange={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByTestId("mc-abstain-opt-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mc-for-opt-1")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("optionChoiceMapToRequest", () => {
  it("converts empty map to empty array", () => {
    expect(optionChoiceMapToRequest({})).toEqual([]);
  });

  it("converts single entry to array", () => {
    const result = optionChoiceMapToRequest({ "opt-1": "for" });
    expect(result).toEqual([{ option_id: "opt-1", choice: "for" }]);
  });

  it("converts multiple entries", () => {
    const result = optionChoiceMapToRequest({
      "opt-1": "for",
      "opt-2": "against",
      "opt-3": "abstained",
    });
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ option_id: "opt-1", choice: "for" });
    expect(result).toContainEqual({ option_id: "opt-2", choice: "against" });
    expect(result).toContainEqual({ option_id: "opt-3", choice: "abstained" });
  });
});
