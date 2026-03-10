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
};

const motionNoDesc = {
  id: "mot-002",
  title: "Motion without description",
  description: null,
  order_index: 1,
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

  it("renders Yes, No, Abstain buttons", () => {
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
    expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abstain" })).toBeInTheDocument();
  });

  it("shows Yes as pressed when choice is yes", () => {
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
    expect(screen.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onChoiceChange when Yes is clicked", async () => {
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
    await user.click(screen.getByRole("button", { name: "Yes" }));
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
    await user.click(screen.getByRole("button", { name: "Yes" }));
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
    await user.click(screen.getByRole("button", { name: "Yes" }));
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
      expect(screen.getByText("Saved")).toBeInTheDocument();
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
      expect(screen.getByText(/Could not save your selection/)).toBeInTheDocument();
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
    expect(card).toHaveStyle({ border: "2px solid #ff9800" });
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
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    }, { timeout: 1000 });

    // Fix the handler and click Save
    server.use(
      http.put(`${BASE}/api/agm/agm-1/draft`, () => HttpResponse.json({ saved: true }))
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    }, { timeout: 1000 });
  });
});
