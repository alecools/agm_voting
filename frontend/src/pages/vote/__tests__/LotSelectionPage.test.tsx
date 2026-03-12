import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LotSelectionPage } from "../LotSelectionPage";
import type { LotInfo } from "../../../api/voter";

const AGM_ID = "agm-test-123";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function setLotsInStorage(lots: LotInfo[]) {
  sessionStorage.setItem(`meeting_lots_info_${AGM_ID}`, JSON.stringify(lots));
}

function clearStorage() {
  sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
}

function renderPage(meetingId = AGM_ID) {
  return render(
    <MemoryRouter initialEntries={[`/vote/${meetingId}/lot-selection`]}>
      <Routes>
        <Route path="/vote/:meetingId/lot-selection" element={<LotSelectionPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LotSelectionPage", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    clearStorage();
  });

  // --- Happy path ---

  it("renders page title", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByRole("heading", { name: "Your Lots" })).toBeInTheDocument();
  });

  it("renders own lot with lot number and no proxy badge", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "42", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByText("Lot 42")).toBeInTheDocument();
    expect(screen.queryByText(/Proxy for Lot/)).not.toBeInTheDocument();
  });

  it("renders proxy lot with Proxy badge", () => {
    setLotsInStorage([
      { lot_owner_id: "lo2", lot_number: "99", financial_position: "normal", already_submitted: false, is_proxy: true },
    ]);
    renderPage();
    expect(screen.getByText("Lot 99")).toBeInTheDocument();
    expect(screen.getByText("Proxy for Lot 99")).toBeInTheDocument();
  });

  it("renders in_arrear badge for in-arrear lot", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "5", financial_position: "in_arrear", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByText("In Arrear")).toBeInTheDocument();
  });

  it("renders in_arrear badge on a proxy lot", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "5", financial_position: "in_arrear", already_submitted: false, is_proxy: true },
    ]);
    renderPage();
    expect(screen.getByText("Proxy for Lot 5")).toBeInTheDocument();
    expect(screen.getByText("In Arrear")).toBeInTheDocument();
  });

  it("renders already-submitted lot greyed out with submitted badge", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "3", financial_position: "normal", already_submitted: true, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByText("Lot 3")).toBeInTheDocument();
    expect(screen.getByText("Already submitted")).toBeInTheDocument();
    const item = screen.getByText("Lot 3").closest("li");
    expect(item).toHaveClass("lot-selection__item--submitted");
  });

  it("renders proxy label on already-submitted proxy lot", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "7", financial_position: "normal", already_submitted: true, is_proxy: true },
    ]);
    renderPage();
    expect(screen.getByText("Proxy for Lot 7")).toBeInTheDocument();
    expect(screen.getByText("Already submitted")).toBeInTheDocument();
  });

  it("renders mixed list of own and proxy lots", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "10", financial_position: "normal", already_submitted: false, is_proxy: false },
      { lot_owner_id: "lo2", lot_number: "20", financial_position: "normal", already_submitted: false, is_proxy: true },
    ]);
    renderPage();
    expect(screen.getByText("Lot 10")).toBeInTheDocument();
    expect(screen.getByText("Lot 20")).toBeInTheDocument();
    expect(screen.getByText("Proxy for Lot 20")).toBeInTheDocument();
    expect(screen.queryByText("Proxy for Lot 10")).not.toBeInTheDocument();
  });

  it("shows 'Start Voting' button when there are pending lots", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByRole("button", { name: "Start Voting" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View Submission" })).not.toBeInTheDocument();
  });

  it("shows correct pending count subtitle", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
      { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: true },
    ]);
    renderPage();
    expect(screen.getByText("You are voting for 2 lots.")).toBeInTheDocument();
  });

  it("shows singular 'lot' for single pending lot", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
  });

  it("shows 'View Submission' button when all lots submitted", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Voting" })).not.toBeInTheDocument();
  });

  it("shows all-submitted subtitle when all lots submitted", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByText("All lots have been submitted.")).toBeInTheDocument();
  });

  it("navigates to voting page when Start Voting clicked", async () => {
    const user = userEvent.setup();
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    await user.click(screen.getByRole("button", { name: "Start Voting" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
  });

  it("navigates to confirmation page when View Submission clicked", async () => {
    const user = userEvent.setup();
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
    ]);
    renderPage();
    await user.click(screen.getByRole("button", { name: "View Submission" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
  });

  // --- Back navigation ---

  it("renders back button", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
  });

  it("back button navigates to auth page for the AGM", async () => {
    const user = userEvent.setup();
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}`);
  });

  // --- Edge cases ---

  it("renders empty list when no lots in storage", () => {
    renderPage();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.queryByText(/Lot /)).not.toBeInTheDocument();
  });

  it("renders empty list on invalid JSON in storage", () => {
    sessionStorage.setItem(`meeting_lots_info_${AGM_ID}`, "not-valid-json{{{");
    renderPage();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.queryByText(/Lot /)).not.toBeInTheDocument();
  });

  it("renders mix of submitted and pending lots with Start Voting button", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
      { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: true },
    ]);
    renderPage();
    // Still 1 pending lot → Start Voting shown
    expect(screen.getByRole("button", { name: "Start Voting" })).toBeInTheDocument();
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
  });
});
