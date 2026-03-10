import { vi, describe, it, expect, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import { parseMotionsExcel } from "../parseMotionsExcel";

vi.mock("xlsx");

const mockedXLSX = vi.mocked(XLSX);

function makeMockFile(): File {
  const file = new File(["dummy"], "test.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  // jsdom does not implement arrayBuffer on File; provide a stub
  file.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0));
  return file;
}

function setupMockSheetData(rows: unknown[][]) {
  const fakeSheet = {};
  const fakeWorkbook = {
    SheetNames: ["Sheet1"],
    Sheets: { Sheet1: fakeSheet },
  };
  mockedXLSX.read = vi.fn().mockReturnValue(fakeWorkbook);
  mockedXLSX.utils = {
    ...mockedXLSX.utils,
    sheet_to_json: vi.fn().mockReturnValue(rows),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseMotionsExcel", () => {
  // --- Happy path ---

  it("returns sorted MotionFormEntry array for valid file with 2 motions", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [2, "Second motion text"],
      [1, "First motion text"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "First motion text", description: "" },
        { title: "Second motion text", description: "" },
      ],
    });
  });

  it("returns single MotionFormEntry for a single valid row", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "Only motion"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Only motion", description: "" }],
    });
  });

  it("sorts motions by Motion number ascending even if file is out of order", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [3, "Third"],
      [1, "First"],
      [2, "Second"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "First", description: "" },
        { title: "Second", description: "" },
        { title: "Third", description: "" },
      ],
    });
  });

  it("skips completely blank rows without error", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "Valid motion"],
      [null, null],
      [undefined, undefined],
      ["", ""],
      [2, "Another motion"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "Valid motion", description: "" },
        { title: "Another motion", description: "" },
      ],
    });
  });

  it("handles case-insensitive column headers", async () => {
    setupMockSheetData([
      ["MOTION", "DESCRIPTION"],
      [1, "Motion content"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion content", description: "" }],
    });
  });

  it("handles lowercase column headers", async () => {
    setupMockSheetData([
      ["motion", "description"],
      [1, "Motion content"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion content", description: "" }],
    });
  });

  it("handles null cells in header row (treats them as empty string for matching)", async () => {
    // null header cells should be treated as "" and not match "motion" or "description"
    setupMockSheetData([
      [null, "Motion", "Description"],
      [null, 1, "Motion content"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion content", description: "" }],
    });
  });

  // --- Missing column headers ---

  it("returns error when Motion column is missing", async () => {
    setupMockSheetData([
      ["Description"],
      [1, "Some text"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Missing required column: Motion"] });
  });

  it("returns error when Description column is missing", async () => {
    setupMockSheetData([
      ["Motion"],
      [1],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Missing required column: Description"] });
  });

  it("returns both errors when both columns are missing", async () => {
    setupMockSheetData([
      ["OtherColumn"],
      [1, "text"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      errors: [
        "Missing required column: Motion",
        "Missing required column: Description",
      ],
    });
  });

  it("returns both errors when sheet is empty", async () => {
    setupMockSheetData([]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      errors: [
        "Missing required column: Motion",
        "Missing required column: Description",
      ],
    });
  });

  // --- Row validation errors ---

  it("returns error for row with non-numeric Motion value", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      ["abc", "Some text"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Motion must be a number"] });
  });

  it("returns error for row with null Motion value", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [null, "Some text"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Motion must be a number"] });
  });

  it("returns error for row with empty Description", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, ""],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Description is empty"] });
  });

  it("returns error for row with null Description", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, null],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Description is empty"] });
  });

  it("returns error for row with whitespace-only Description", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "   "],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Description is empty"] });
  });

  // --- Multiple errors ---

  it("collects all errors across multiple rows and returns no motions", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      ["bad", "Good text"],
      [2, ""],
      [3, "Valid"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      errors: [
        "Row 1: Motion must be a number",
        "Row 2: Description is empty",
      ],
    });
  });

  // --- Duplicate Motion numbers ---

  it("returns error for duplicate Motion numbers", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "First motion"],
      [2, "Second motion"],
      [1, "Duplicate motion"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Duplicate Motion number: 1"] });
  });

  it("reports all duplicate Motion numbers", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "Motion A"],
      [2, "Motion B"],
      [1, "Motion C"],
      [2, "Motion D"],
      [3, "Motion E"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      errors: ["Duplicate Motion number: 1", "Duplicate Motion number: 2"],
    });
  });
});
