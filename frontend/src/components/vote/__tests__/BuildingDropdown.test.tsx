import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuildingDropdown } from "../BuildingDropdown";

const buildings = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];

describe("BuildingDropdown", () => {
  it("renders the label and default option", () => {
    render(
      <BuildingDropdown buildings={buildings} value="" onChange={() => {}} />
    );
    expect(screen.getByLabelText("Select your building")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "-- Select a building --" })).toBeInTheDocument();
  });

  it("renders all buildings as options", () => {
    render(
      <BuildingDropdown buildings={buildings} value="" onChange={() => {}} />
    );
    expect(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument();
  });

  it("calls onChange when a building is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <BuildingDropdown buildings={buildings} value="" onChange={onChange} />
    );
    await user.selectOptions(screen.getByRole("combobox"), "1");
    expect(onChange).toHaveBeenCalledWith("1");
  });

  it("shows error message when error prop is provided", () => {
    render(
      <BuildingDropdown
        buildings={buildings}
        value=""
        onChange={() => {}}
        error="Please select a building"
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Please select a building");
  });

  it("does not show error when no error prop", () => {
    render(
      <BuildingDropdown buildings={buildings} value="" onChange={() => {}} />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reflects the selected value", () => {
    render(
      <BuildingDropdown buildings={buildings} value="2" onChange={() => {}} />
    );
    expect(screen.getByRole("combobox")).toHaveValue("2");
  });
});
