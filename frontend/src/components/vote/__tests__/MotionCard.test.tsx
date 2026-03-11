import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { MotionCard } from "../MotionCard";

const motion = {
  id: "mot-001",
  title: "Approve budget",
  description: "The annual budget",
  order_index: 0,
  motion_type: "general" as const,
};

const motionNoDesc = {
  id: "mot-002",
  title: "Motion without description",
  description: null,
  order_index: 1,
  motion_type: "general" as const,
};

const motionSpecial = {
  id: "mot-003",
  title: "Special resolution",
  description: "A special motion",
  order_index: 2,
  motion_type: "special" as const,
};

const BASE = "http://localhost:8000";

describe("MotionCard", () => {
  it("renders motion title and description", () => {
    render(
      <MotionCard
        motion={motion}
        agmId="agm-1"
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
        agmId="agm-1"
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
        agmId="agm-1"
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
        agmId="agm-1"
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
        agmId="agm-1"
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
        agmId="agm-1"
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
        agmId="agm-1"
        choice={null}
        onChoiceChange={onChoiceChange}
        disabled={true}
        highlight={false}
      />
    );
    await user.click(screen.getByRole("button", { name: "For" }));
    expect(onChoiceChange).not.toHaveBeenCalled();
  });

  it("shows Saved indicator after auto-save", async () => {
    render(
      <MotionCard
        motion={motion}
        agmId="agm-1"
        choice="yes"
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    await waitFor(() => {
      expect(screen.getByText(/Saved/)).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  it("shows error indicator when save fails", async () => {
    server.use(
      http.put(`${BASE}/api/agm/agm-1/draft`, () => HttpResponse.error())
    );
    render(
      <MotionCard
        motion={motion}
        agmId="agm-1"
        choice="no"
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    await waitFor(() => {
      expect(screen.getByText(/Could not save\./)).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  it("highlights card when highlight is true", () => {
    render(
      <MotionCard
        motion={motion}
        agmId="agm-1"
        choice={null}
        onChoiceChange={() => {}}
        disabled={false}
        highlight={true}
      />
    );
    const card = screen.getByTestId("motion-card-mot-001");
    expect(card).toHaveClass("motion-card--highlight");
  });

  it("manual save button triggers immediate save", async () => {
    const user = userEvent.setup();
    server.use(
      http.put(`${BASE}/api/agm/agm-1/draft`, () => HttpResponse.error())
    );
    render(
      <MotionCard
        motion={motion}
        agmId="agm-1"
        choice="no"
        onChoiceChange={() => {}}
        disabled={false}
        highlight={false}
      />
    );
    // Wait for error state
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    }, { timeout: 1000 });

    // Fix the handler and click Retry
    server.use(
      http.put(`${BASE}/api/agm/agm-1/draft`, () => HttpResponse.json({ saved: true }))
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByText(/Saved/)).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  // --- motion_type badge tests ---

  it("shows 'General' badge for a general motion", () => {
    render(
      <MotionCard
        motion={motion}
        agmId="agm-1"
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
        agmId="agm-1"
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
});
