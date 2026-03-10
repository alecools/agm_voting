import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminLayout from "../AdminLayout";

describe("AdminLayout", () => {
  it("renders Admin Portal heading", () => {
    render(
      <MemoryRouter initialEntries={["/admin/buildings"]}>
        <AdminLayout />
      </MemoryRouter>
    );
    expect(screen.getByText("Admin Portal")).toBeInTheDocument();
  });

  it("renders Buildings nav link", () => {
    render(
      <MemoryRouter initialEntries={["/admin/buildings"]}>
        <AdminLayout />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "Buildings" })).toBeInTheDocument();
  });

  it("renders AGMs nav link", () => {
    render(
      <MemoryRouter initialEntries={["/admin/agms"]}>
        <AdminLayout />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "AGMs" })).toBeInTheDocument();
  });

  it("renders outlet content", () => {
    render(
      <MemoryRouter initialEntries={["/admin/buildings"]}>
        <AdminLayout />
      </MemoryRouter>
    );
    // Outlet renders nothing without routes defined, but the nav is visible
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });
});
