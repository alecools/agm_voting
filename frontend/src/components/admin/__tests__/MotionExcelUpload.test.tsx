import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MotionExcelUpload from "../MotionExcelUpload";

// vi.mock is hoisted by Vitest and intercepts both static and dynamic imports
vi.mock("../../../utils/parseMotionsExcel");

import { parseMotionsExcel } from "../../../utils/parseMotionsExcel";

const mockParse = vi.mocked(parseMotionsExcel);

function renderComponent(onMotionsLoaded = vi.fn()) {
  return render(<MotionExcelUpload onMotionsLoaded={onMotionsLoaded} />);
}

describe("MotionExcelUpload", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // --- Happy path ---

  it("renders the Download template link with correct href and download attribute", () => {
    renderComponent();
    const link = screen.getByRole("link", { name: "Download template" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/agm_motions_template.csv");
    expect(link).toHaveAttribute("download");
  });

  it("renders file input with correct label and accept attribute", () => {
    renderComponent();
    const input = screen.getByLabelText("Upload motions (CSV or Excel)");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("accept", ".csv,text/csv,.xlsx,.xls");
  });

  it("renders button with 'Import motions from CSV or Excel' label", () => {
    renderComponent();
    expect(screen.getByRole("button", { name: "Import motions from CSV or Excel" })).toBeInTheDocument();
  });

  it("shows loading state while parsing", async () => {
    let resolvePromise!: (value: { motions: { title: string; description: string; motion_number: string; motion_type: "general" | "special" }[] }) => void;
    mockParse.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      })
    );

    const user = userEvent.setup();
    renderComponent();

    const file = new File([""], "motions.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(screen.getByLabelText("Upload motions (CSV or Excel)"), file);

    expect(screen.getByText("Parsing...")).toBeInTheDocument();

    resolvePromise({ motions: [] });

    await waitFor(() => {
      expect(screen.queryByText("Parsing...")).not.toBeInTheDocument();
    });
  });

  it("calls onMotionsLoaded with parsed motions on success and shows no error", async () => {
    const motions = [
      { title: "Motion A", description: "", motion_number: "", motion_type: "general" as const },
      { title: "Motion B", description: "", motion_number: "", motion_type: "general" as const },
    ];
    mockParse.mockResolvedValue({ motions });

    const onMotionsLoaded = vi.fn();
    const user = userEvent.setup();
    renderComponent(onMotionsLoaded);

    const file = new File([""], "motions.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(screen.getByLabelText("Upload motions (CSV or Excel)"), file);

    await waitFor(() => {
      expect(onMotionsLoaded).toHaveBeenCalledWith(motions);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("accepts a CSV file and calls onMotionsLoaded with parsed motions", async () => {
    const motions = [
      { title: "CSV Motion", description: "", motion_number: "", motion_type: "general" as const },
    ];
    mockParse.mockResolvedValue({ motions });

    const onMotionsLoaded = vi.fn();
    const user = userEvent.setup();
    renderComponent(onMotionsLoaded);

    const csvFile = new File(["Motion,Description\n1,CSV Motion"], "motions.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Upload motions (CSV or Excel)"), csvFile);

    await waitFor(() => {
      expect(onMotionsLoaded).toHaveBeenCalledWith(motions);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows filename after successful upload", async () => {
    mockParse.mockResolvedValue({ motions: [] });
    const user = userEvent.setup();
    renderComponent();

    const file = new File([""], "my-motions.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(screen.getByLabelText("Upload motions (CSV or Excel)"), file);

    await waitFor(() => {
      expect(screen.getByText("my-motions.xlsx")).toBeInTheDocument();
    });
  });

  // --- Input validation ---

  it("shows error alert with all error messages on parse error", async () => {
    mockParse.mockResolvedValue({ errors: ["Row 1: Motion must be a number", "Row 2: Description is empty"] });

    const user = userEvent.setup();
    renderComponent();

    const file = new File([""], "bad.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(screen.getByLabelText("Upload motions (CSV or Excel)"), file);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Row 1: Motion must be a number")).toBeInTheDocument();
    expect(screen.getByText("Row 2: Description is empty")).toBeInTheDocument();
  });

  it("displays multiple errors in the alert", async () => {
    const errors = [
      "Missing required column: Motion",
      "Missing required column: Description",
    ];
    mockParse.mockResolvedValue({ errors });

    const user = userEvent.setup();
    renderComponent();

    const file = new File([""], "bad.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(screen.getByLabelText("Upload motions (CSV or Excel)"), file);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    errors.forEach((err) => {
      expect(screen.getByText(err)).toBeInTheDocument();
    });
  });

  // --- Edge cases ---

  it("does nothing when change event fires with no file selected", async () => {
    const onMotionsLoaded = vi.fn();
    renderComponent(onMotionsLoaded);

    const input = screen.getByLabelText("Upload motions (CSV or Excel)");
    // Fire change with an empty FileList (no file)
    fireEvent.change(input, { target: { files: [] } });

    expect(mockParse).not.toHaveBeenCalled();
    expect(onMotionsLoaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Parsing...")).not.toBeInTheDocument();
  });

  it("clears previous errors when a new file is selected", async () => {
    mockParse.mockResolvedValueOnce({ errors: ["Row 1: Motion must be a number"] });
    mockParse.mockResolvedValueOnce({ motions: [{ title: "Motion A", description: "", motion_number: "", motion_type: "general" as const }] });

    const onMotionsLoaded = vi.fn();
    const user = userEvent.setup();
    renderComponent(onMotionsLoaded);

    const input = screen.getByLabelText("Upload motions (CSV or Excel)");

    const badFile = new File([""], "bad.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(input, badFile);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const goodFile = new File([""], "good.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(input, goodFile);

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(onMotionsLoaded).toHaveBeenCalledWith([{ title: "Motion A", description: "", motion_number: "", motion_type: "general" }]);
  });

  // --- Dynamic import failure (VP-PERF-06) ---

  it("shows a generic error when the dynamic import of parseMotionsExcel fails", async () => {
    // Simulate the module failing to load (e.g. network error during lazy chunk fetch)
    vi.doMock("../../../utils/parseMotionsExcel", () => {
      throw new Error("ChunkLoadError: Failed to load chunk");
    });

    // Use a fresh mock that rejects to simulate the dynamic import() promise rejecting
    mockParse.mockRejectedValue(new Error("ChunkLoadError: Failed to load chunk"));

    const onMotionsLoaded = vi.fn();
    const user = userEvent.setup();
    renderComponent(onMotionsLoaded);

    const file = new File([""], "motions.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(screen.getByLabelText("Upload motions (CSV or Excel)"), file);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to load the file parser. Please try again.")).toBeInTheDocument();
    expect(onMotionsLoaded).not.toHaveBeenCalled();
  });
});
