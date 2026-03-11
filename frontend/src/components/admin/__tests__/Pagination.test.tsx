import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Pagination from "../Pagination";

describe("Pagination", () => {
  it("returns null when totalPages is 1", () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} totalItems={5} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when totalPages is 0", () => {
    const { container } = render(
      <Pagination page={1} totalPages={0} totalItems={0} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows page range info on page 1", () => {
    render(
      <Pagination page={1} totalPages={3} totalItems={25} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(screen.getByText("1–10 of 25")).toBeInTheDocument();
  });

  it("shows correct range on page 2", () => {
    render(
      <Pagination page={2} totalPages={3} totalItems={25} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(screen.getByText("11–20 of 25")).toBeInTheDocument();
  });

  it("caps end at totalItems on last page", () => {
    render(
      <Pagination page={3} totalPages={3} totalItems={25} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(screen.getByText("21–25 of 25")).toBeInTheDocument();
  });

  it("disables Previous button on page 1", () => {
    render(
      <Pagination page={1} totalPages={3} totalItems={25} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  it("disables Next button on last page", () => {
    render(
      <Pagination page={3} totalPages={3} totalItems={25} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("calls onPageChange with page - 1 when Previous clicked", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <Pagination page={2} totalPages={3} totalItems={25} pageSize={10} onPageChange={onPageChange} />
    );
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("calls onPageChange with page + 1 when Next clicked", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <Pagination page={2} totalPages={3} totalItems={25} pageSize={10} onPageChange={onPageChange} />
    );
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("calls onPageChange when a page number button is clicked", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <Pagination page={1} totalPages={3} totalItems={25} pageSize={10} onPageChange={onPageChange} />
    );
    await user.click(screen.getByRole("button", { name: "2" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("marks current page button with aria-current=page", () => {
    render(
      <Pagination page={2} totalPages={3} totalItems={25} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "1" })).not.toHaveAttribute("aria-current");
  });

  it("shows ellipsis for non-adjacent pages", () => {
    render(
      <Pagination page={1} totalPages={10} totalItems={100} pageSize={10} onPageChange={vi.fn()} />
    );
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});
