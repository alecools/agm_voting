import { vi, describe, it, expect, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import { parseMotionsExcel } from "../parseMotionsExcel";

vi.mock("xlsx");

const mockedXLSX = vi.mocked(XLSX);

function makeMockFile(name = "test.xlsx", type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"): File {
  const file = new File(["dummy"], name, { type });
  // jsdom does not implement arrayBuffer on File; provide a stub
  file.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0));
  return file;
}

function makeMockCsvFile(): File {
  return makeMockFile("test.csv", "text/csv");
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
  // --- Happy path (old 2-column format — backwards compatibility) ---

  it("returns sorted MotionFormEntry array for valid file with 2 motions (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [2, "Second motion text"],
      [1, "First motion text"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "First motion text", description: "", motion_number: null, motion_type: "general" },
        { title: "Second motion text", description: "", motion_number: null, motion_type: "general" },
      ],
    });
  });

  it("returns single MotionFormEntry for a single valid row (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "Only motion"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Only motion", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  it("sorts motions by Motion number ascending even if file is out of order (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [3, "Third"],
      [1, "First"],
      [2, "Second"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "First", description: "", motion_number: null, motion_type: "general" },
        { title: "Second", description: "", motion_number: null, motion_type: "general" },
        { title: "Third", description: "", motion_number: null, motion_type: "general" },
      ],
    });
  });

  it("skips completely blank rows without error (old format)", async () => {
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
        { title: "Valid motion", description: "", motion_number: null, motion_type: "general" },
        { title: "Another motion", description: "", motion_number: null, motion_type: "general" },
      ],
    });
  });

  it("handles case-insensitive column headers (old format)", async () => {
    setupMockSheetData([
      ["MOTION", "DESCRIPTION"],
      [1, "Motion content"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion content", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  it("handles lowercase column headers (old format)", async () => {
    setupMockSheetData([
      ["motion", "description"],
      [1, "Motion content"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion content", description: "", motion_number: null, motion_type: "general" }],
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
      motions: [{ title: "Motion content", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  // --- New 4-column format ---

  it("parses all 4 columns correctly (new format)", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "Sample Motion Title", "general", "Full description text shown to voters"],
      [2, "Another Motion", "special", "Description for a special resolution"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "Sample Motion Title", description: "Full description text shown to voters", motion_number: null, motion_type: "general" },
        { title: "Another Motion", description: "Description for a special resolution", motion_number: null, motion_type: "special" },
      ],
    });
  });

  it("uses Title as title and Description as description when both columns present", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "My Title", "general", "My full description"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "My Title", description: "My full description", motion_number: null, motion_type: "general" }],
    });
  });

  it("sorts motions ascending by Motion number in new 4-column format", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [3, "Third", "general", "Third desc"],
      [1, "First", "general", "First desc"],
      [2, "Second", "special", "Second desc"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "First", description: "First desc", motion_number: null, motion_type: "general" },
        { title: "Second", description: "Second desc", motion_number: null, motion_type: "special" },
        { title: "Third", description: "Third desc", motion_number: null, motion_type: "general" },
      ],
    });
  });

  it("handles case-insensitive column headers in new 4-column format", async () => {
    setupMockSheetData([
      ["MOTION", "TITLE", "MOTION TYPE", "DESCRIPTION"],
      [1, "My Title", "SPECIAL", "My desc"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "My Title", description: "My desc", motion_number: null, motion_type: "special" }],
    });
  });

  it("skips completely blank rows in new 4-column format", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "First", "general", "First desc"],
      [null, null, null, null],
      [2, "Second", "special", "Second desc"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "First", description: "First desc", motion_number: null, motion_type: "general" },
        { title: "Second", description: "Second desc", motion_number: null, motion_type: "special" },
      ],
    });
  });

  // --- Partial columns (Title present, Motion Type absent) ---

  it("defaults motion_type to 'general' when Title present but Motion Type column absent", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Description"],
      [1, "My Title", "My desc"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "My Title", description: "My desc", motion_number: null, motion_type: "general" }],
    });
  });

  // --- Blank Title fallback to Description ---

  it("falls back to Description as title when Title cell is blank (null)", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, null, "general", "Fallback description used as title"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Fallback description used as title", description: "Fallback description used as title", motion_number: null, motion_type: "general" }],
    });
  });

  it("falls back to Description as title when Title cell is empty string", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "", "general", "Fallback description"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Fallback description", description: "Fallback description", motion_number: null, motion_type: "general" }],
    });
  });

  it("falls back to Description as title when Title cell is whitespace-only", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "   ", "general", "Fallback description"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Fallback description", description: "Fallback description", motion_number: null, motion_type: "general" }],
    });
  });

  it("returns error when both Title and Description are blank (4-column format)", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, null, "general", null],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Description is empty"] });
  });

  // --- Motion Type column ---

  it("defaults to 'general' when Motion Type column is absent (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "Motion A"],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion A", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  it("reads 'Special' from Motion Type column (case-insensitive, old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description", "Motion Type"],
      [1, "Special Motion", "Special"],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Special Motion", description: "", motion_number: null, motion_type: "special" }],
    });
  });

  it("reads 'SPECIAL' (all-caps) from Motion Type column (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description", "Motion Type"],
      [1, "Special Motion", "SPECIAL"],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Special Motion", description: "", motion_number: null, motion_type: "special" }],
    });
  });

  it("reads 'General' from Motion Type column (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description", "Motion Type"],
      [1, "General Motion", "General"],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "General Motion", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  it("defaults to 'general' when Motion Type cell is blank (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description", "Motion Type"],
      [1, "Motion A", null],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion A", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  it("defaults to 'general' when Motion Type cell is empty string (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description", "Motion Type"],
      [1, "Motion A", ""],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion A", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  it("defaults to 'general' for unrecognised Motion Type value", async () => {
    setupMockSheetData([
      ["Motion", "Description", "Motion Type"],
      [1, "Motion A", "ordinary"],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Motion A", description: "", motion_number: null, motion_type: "general" }],
    });
  });

  it("handles mixed motion types in same file (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description", "Motion Type"],
      [1, "General M", "General"],
      [2, "Special M", "Special"],
      [3, "Default M", null],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "General M", description: "", motion_number: null, motion_type: "general" },
        { title: "Special M", description: "", motion_number: null, motion_type: "special" },
        { title: "Default M", description: "", motion_number: null, motion_type: "general" },
      ],
    });
  });

  it("reads 'special' (lowercase) from Motion Type column (new 4-column format)", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "Special Motion", "special", "Special desc"],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Special Motion", description: "Special desc", motion_number: null, motion_type: "special" }],
    });
  });

  it("defaults to 'general' when Motion Type cell is blank (new 4-column format)", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "My Title", null, "My desc"],
    ]);
    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "My Title", description: "My desc", motion_number: null, motion_type: "general" }],
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

  it("returns both errors when both Motion and Description columns are missing", async () => {
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

  it("returns error for row with empty Description (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, ""],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Description is empty"] });
  });

  it("returns error for row with null Description (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, null],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Description is empty"] });
  });

  it("returns error for row with whitespace-only Description (old format)", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "   "],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Row 1: Description is empty"] });
  });

  it("returns error for row with empty Description in new 4-column format when Title is also blank", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "", "general", ""],
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

  it("returns error for duplicate Motion numbers in new 4-column format", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "Title A", "general", "Desc A"],
      [1, "Title B", "special", "Desc B"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({ errors: ["Duplicate Motion number: 1"] });
  });

  // --- Agenda Item column alias for Title ---

  it("treats 'Agenda Item' column as title alias (same behaviour as Title)", async () => {
    setupMockSheetData([
      ["Motion", "Agenda Item", "Motion Type", "Description"],
      [1, "My Agenda Title", "general", "Full description text"],
      [2, "Another Agenda Item", "special", "Another description"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "My Agenda Title", description: "Full description text", motion_number: null, motion_type: "general" },
        { title: "Another Agenda Item", description: "Another description", motion_number: null, motion_type: "special" },
      ],
    });
  });

  it("treats 'AGENDA ITEM' (case-insensitive) column as title alias", async () => {
    setupMockSheetData([
      ["Motion", "AGENDA ITEM", "Motion Type", "Description"],
      [1, "Case-insensitive title", "general", "Some description"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Case-insensitive title", description: "Some description", motion_number: null, motion_type: "general" }],
    });
  });

  it("parses Agenda Item + Motion Type + Description columns all correctly", async () => {
    setupMockSheetData([
      ["Motion", "Agenda Item", "Motion Type", "Description"],
      [1, "Approve minutes", "general", "Approve the minutes of the previous AGM"],
      [2, "Fix levy", "special", "Fix the levy amount for the next financial year"],
      [3, "Elect committee", "general", "Elect new committee members"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [
        { title: "Approve minutes", description: "Approve the minutes of the previous AGM", motion_number: null, motion_type: "general" },
        { title: "Fix levy", description: "Fix the levy amount for the next financial year", motion_number: null, motion_type: "special" },
        { title: "Elect committee", description: "Elect new committee members", motion_number: null, motion_type: "general" },
      ],
    });
  });

  it("falls back to Description when Agenda Item cell is blank", async () => {
    setupMockSheetData([
      ["Motion", "Agenda Item", "Motion Type", "Description"],
      [1, null, "general", "Fallback from blank agenda item"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Fallback from blank agenda item", description: "Fallback from blank agenda item", motion_number: null, motion_type: "general" }],
    });
  });

  it("uses Title when both Title and Agenda Item columns are present (Title appears first)", async () => {
    // findIndex returns the first match: "title" === "title" wins before "agenda item"
    setupMockSheetData([
      ["Motion", "Title", "Agenda Item", "Motion Type", "Description"],
      [1, "Title value", "Agenda Item value", "general", "Full description"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "Title value", description: "Full description", motion_number: null, motion_type: "general" }],
    });
  });

  it("works with only Motion + Agenda Item columns (no Motion Type or Description header — but Description required)", async () => {
    // Agenda Item present, Motion Type absent — description col is still required
    setupMockSheetData([
      ["Motion", "Agenda Item", "Description"],
      [1, "My agenda title", "Full description here"],
    ]);

    const result = await parseMotionsExcel(makeMockFile());
    expect(result).toEqual({
      motions: [{ title: "My agenda title", description: "Full description here", motion_number: null, motion_type: "general" }],
    });
  });

  // --- CSV file support ---

  it("parses a CSV file using the same XLSX.read call (type: 'array')", async () => {
    setupMockSheetData([
      ["Motion", "Description"],
      [1, "CSV motion text"],
    ]);

    const result = await parseMotionsExcel(makeMockCsvFile());
    expect(result).toEqual({
      motions: [{ title: "CSV motion text", description: "", motion_number: null, motion_type: "general" }],
    });
    // Verify XLSX.read was called with type: 'array' — the same call that handles both CSV and Excel
    expect(mockedXLSX.read).toHaveBeenCalledWith(expect.any(ArrayBuffer), { type: "array" });
  });

  it("parses a CSV file in new 4-column format", async () => {
    setupMockSheetData([
      ["Motion", "Title", "Motion Type", "Description"],
      [1, "CSV Title", "special", "CSV full description"],
    ]);

    const result = await parseMotionsExcel(makeMockCsvFile());
    expect(result).toEqual({
      motions: [{ title: "CSV Title", description: "CSV full description", motion_number: null, motion_type: "special" }],
    });
  });

  it("returns errors for an invalid CSV file just like an invalid Excel file", async () => {
    setupMockSheetData([
      ["OtherColumn"],
      [1, "text"],
    ]);

    const result = await parseMotionsExcel(makeMockCsvFile());
    expect(result).toEqual({
      errors: [
        "Missing required column: Motion",
        "Missing required column: Description",
      ],
    });
  });
});
