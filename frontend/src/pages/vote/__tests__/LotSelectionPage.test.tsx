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
  sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
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

// Helpers for multi-lot scenarios
const LOT_A: LotInfo = { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false };
const LOT_B: LotInfo = { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false };
const LOT_B_SUBMITTED: LotInfo = { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false };

describe("LotSelectionPage", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    clearStorage();
  });

  // --- Happy path (single-lot voter) ---

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

  it("shows 'Start Voting' button when there are pending lots", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByRole("button", { name: "Start Voting" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View Submission" })).not.toBeInTheDocument();
  });

  it("shows singular 'lot' for single pending lot", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
  });

  it("shows 'View Submission' button when all lots submitted (single-lot)", () => {
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

  it("navigates to voting page when Start Voting clicked (single-lot)", async () => {
    const user = userEvent.setup();
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    await user.click(screen.getByRole("button", { name: "Start Voting" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
  });

  it("does NOT write meeting_lots to sessionStorage for single-lot voter", async () => {
    const user = userEvent.setup();
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    await user.click(screen.getByRole("button", { name: "Start Voting" }));
    expect(sessionStorage.getItem(`meeting_lots_${AGM_ID}`)).toBeNull();
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

  it("single-lot voter: no checkbox rendered", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
    ]);
    renderPage();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
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

  // --- Multi-lot voter: checkbox rendering ---

  it("multi-lot: renders a checkbox for each lot", () => {
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
  });

  it("multi-lot: pending lots are checked by default", () => {
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
  });

  it("multi-lot: already-submitted lot renders disabled unchecked checkbox", () => {
    setLotsInStorage([LOT_A, LOT_B_SUBMITTED]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    const submittedCheckbox = checkboxes[1];
    expect(submittedCheckbox).toBeDisabled();
    expect(submittedCheckbox).not.toBeChecked();
  });

  it("multi-lot: subtitle shows count of selected lots", () => {
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    expect(screen.getByText("You are voting for 2 lots.")).toBeInTheDocument();
  });

  it("multi-lot: subtitle uses singular when 1 lot selected", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    // Uncheck lot B
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
  });

  it("multi-lot: unchecking a lot removes it from selected count", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
  });

  it("multi-lot: re-checking a lot adds it back to selected count", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]); // uncheck
    await user.click(checkboxes[0]); // re-check
    expect(screen.getByText("You are voting for 2 lots.")).toBeInTheDocument();
  });

  // --- Multi-lot voter: Start Voting disabled / validation ---

  it("multi-lot: Start Voting has aria-disabled when no lots selected", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    const btn = screen.getByRole("button", { name: "Start Voting" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
  });

  it("multi-lot: shows validation alert when Start Voting clicked with nothing selected", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    // Uncheck all lots
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    // Button is aria-disabled (not HTML disabled) so userEvent can still click it
    const btn = screen.getByRole("button", { name: "Start Voting" });
    await user.click(btn);
    expect(screen.getByRole("alert")).toHaveTextContent("Please select at least one lot");
  });

  it("multi-lot: validation alert clears after checking a lot", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    const checkboxes = screen.getAllByRole("checkbox");
    // Uncheck all lots and trigger the error
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    const btn = screen.getByRole("button", { name: "Start Voting" });
    await user.click(btn);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Re-check one lot — the alert should disappear
    await user.click(checkboxes[0]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // --- Multi-lot voter: sessionStorage write on submit ---

  it("multi-lot: writes selected lot_owner_ids to sessionStorage on Start Voting", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    await user.click(screen.getByRole("button", { name: "Start Voting" }));
    const stored = JSON.parse(sessionStorage.getItem(`meeting_lots_${AGM_ID}`) ?? "[]") as string[];
    expect(stored).toContain("lo1");
    expect(stored).toContain("lo2");
  });

  it("multi-lot: only selected lots written to sessionStorage", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    // Uncheck lot B
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    await user.click(screen.getByRole("button", { name: "Start Voting" }));
    const stored = JSON.parse(sessionStorage.getItem(`meeting_lots_${AGM_ID}`) ?? "[]") as string[];
    expect(stored).toEqual(["lo1"]);
  });

  it("multi-lot: navigates to voting page after Start Voting", async () => {
    const user = userEvent.setup();
    setLotsInStorage([LOT_A, LOT_B]);
    renderPage();
    await user.click(screen.getByRole("button", { name: "Start Voting" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
  });

  // --- Multi-lot voter: all submitted state ---

  it("multi-lot: shows 'View Submission' when all lots submitted", () => {
    setLotsInStorage([
      { ...LOT_A, already_submitted: true },
      { ...LOT_B, already_submitted: true },
    ]);
    renderPage();
    expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Voting" })).not.toBeInTheDocument();
  });

  it("multi-lot: shows all-submitted subtitle", () => {
    setLotsInStorage([
      { ...LOT_A, already_submitted: true },
      { ...LOT_B, already_submitted: true },
    ]);
    renderPage();
    expect(screen.getByText("All lots have been submitted.")).toBeInTheDocument();
  });

  it("multi-lot: mix of submitted and pending shows Start Voting and correct subtitle", () => {
    setLotsInStorage([LOT_A, LOT_B_SUBMITTED]);
    renderPage();
    expect(screen.getByRole("button", { name: "Start Voting" })).toBeInTheDocument();
    // Only lot A is pending (and selected by default) → 1 lot
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
  });

  it("multi-lot: renders mixed list of own and proxy lots with checkboxes", () => {
    setLotsInStorage([
      { lot_owner_id: "lo1", lot_number: "10", financial_position: "normal", already_submitted: false, is_proxy: false },
      { lot_owner_id: "lo2", lot_number: "20", financial_position: "normal", already_submitted: false, is_proxy: true },
    ]);
    renderPage();
    expect(screen.getByText("Lot 10")).toBeInTheDocument();
    expect(screen.getByText("Lot 20")).toBeInTheDocument();
    expect(screen.getByText("Proxy for Lot 20")).toBeInTheDocument();
    expect(screen.queryByText("Proxy for Lot 10")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});
