import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthForm } from "../AuthForm";

describe("AuthForm", () => {
  it("renders AGM title and building name", () => {
    render(
      <AuthForm
        agmTitle="2024 AGM"
        buildingName="Sunset Towers"
        onSubmit={() => {}}
        isLoading={false}
      />
    );
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    expect(screen.getByText("Sunset Towers")).toBeInTheDocument();
  });

  it("renders lot number and email inputs", () => {
    render(
      <AuthForm agmTitle="AGM" buildingName="Building" onSubmit={() => {}} isLoading={false} />
    );
    expect(screen.getByLabelText("Lot number")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });

  it("calls onSubmit with lot number and email", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AuthForm agmTitle="AGM" buildingName="Building" onSubmit={onSubmit} isLoading={false} />
    );
    await user.type(screen.getByLabelText("Lot number"), "42");
    await user.type(screen.getByLabelText("Email address"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith("42", "owner@example.com");
  });

  it("shows lot number validation error when empty", async () => {
    const user = userEvent.setup();
    render(
      <AuthForm agmTitle="AGM" buildingName="Building" onSubmit={() => {}} isLoading={false} />
    );
    await user.type(screen.getByLabelText("Email address"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Lot number is required")).toBeInTheDocument();
  });

  it("shows email validation error when empty", async () => {
    const user = userEvent.setup();
    render(
      <AuthForm agmTitle="AGM" buildingName="Building" onSubmit={() => {}} isLoading={false} />
    );
    await user.type(screen.getByLabelText("Lot number"), "42");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Email address is required")).toBeInTheDocument();
  });

  it("shows both validation errors when both fields empty", async () => {
    const user = userEvent.setup();
    render(
      <AuthForm agmTitle="AGM" buildingName="Building" onSubmit={() => {}} isLoading={false} />
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Lot number is required")).toBeInTheDocument();
    expect(screen.getByText("Email address is required")).toBeInTheDocument();
  });

  it("shows external error message", () => {
    render(
      <AuthForm
        agmTitle="AGM"
        buildingName="Building"
        onSubmit={() => {}}
        isLoading={false}
        error="Lot number and email address do not match our records"
      />
    );
    expect(
      screen.getByText("Lot number and email address do not match our records")
    ).toBeInTheDocument();
  });

  it("shows Verifying... and disables button when loading", () => {
    render(
      <AuthForm agmTitle="AGM" buildingName="Building" onSubmit={() => {}} isLoading={true} />
    );
    expect(screen.getByRole("button", { name: "Verifying..." })).toBeDisabled();
  });

  it("shows Continue but disables button when isContextLoading=true", () => {
    render(
      <AuthForm
        agmTitle="AGM"
        buildingName="Building"
        onSubmit={() => {}}
        isLoading={false}
        isContextLoading={true}
      />
    );
    const btn = screen.getByRole("button", { name: "Continue" });
    expect(btn).toBeDisabled();
    // Still shows "Continue" (not "Verifying...") — context loading is silent
    expect(btn).toHaveTextContent("Continue");
  });

  it("does not call onSubmit when loading and submitted again", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AuthForm agmTitle="AGM" buildingName="Building" onSubmit={onSubmit} isLoading={true} />
    );
    await user.type(screen.getByLabelText("Lot number"), "1");
    await user.type(screen.getByLabelText("Email address"), "a@b.com");
    // Button is disabled so clicking does nothing
    const btn = screen.getByRole("button", { name: "Verifying..." });
    expect(btn).toBeDisabled();
  });
});
