import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AGMReportView from "../AGMReportView";
import type { MotionDetail } from "../../../api/admin";

const motions: MotionDetail[] = [
  {
    id: "m1",
    title: "Motion 1",
    description: "First motion description",
    display_order: 1,
    motion_number: null,
    motion_type: "general" as const,
    is_visible: true,
    option_limit: null,
    options: [],
    voting_closed_at: null,
    tally: {
      yes: { voter_count: 2, entitlement_sum: 200 },
      no: { voter_count: 1, entitlement_sum: 100 },
      abstained: { voter_count: 0, entitlement_sum: 0 },
      absent: { voter_count: 2, entitlement_sum: 150 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
      options: [],
    },
    voter_lists: {
      yes: [
        { voter_email: "voter1@example.com", lot_number: "L1", entitlement: 100 },
        { voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 },
      ],
      no: [{ voter_email: "voter3@example.com", lot_number: "L3", entitlement: 100 }],
      abstained: [],
      absent: [
        { voter_email: "voter4@example.com", lot_number: "L4", entitlement: 100 },
        { voter_email: "voter5@example.com", lot_number: "L5", entitlement: 50 },
      ],
      not_eligible: [],
      options: {},
    },
  },
  {
    id: "m2",
    title: "Motion 2",
    description: null,
    display_order: 2,
    motion_number: null,
    motion_type: "special" as const,
    is_visible: true,
    option_limit: null,
    options: [],
    voting_closed_at: null,
    tally: {
      yes: { voter_count: 1, entitlement_sum: 50 },
      no: { voter_count: 0, entitlement_sum: 0 },
      abstained: { voter_count: 2, entitlement_sum: 200 },
      absent: { voter_count: 0, entitlement_sum: 0 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
      options: [],
    },
    voter_lists: {
      yes: [{ voter_email: "voter1@example.com", lot_number: "L1", entitlement: 50 }],
      no: [],
      abstained: [
        { voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 },
        { voter_email: "voter3@example.com", lot_number: "L3", entitlement: 100 },
      ],
      absent: [],
      not_eligible: [],
      options: {},
    },
  },
];

// Multi-choice motion fixture
const mcMotionFixture: MotionDetail = {
  id: "mc1",
  title: "Board Election",
  description: null,
  display_order: 3,
  motion_number: null,
  motion_type: "general" as const,
  is_multi_choice: true,
  is_visible: true,
  option_limit: 2,
  voting_closed_at: null,
  options: [
    { id: "opt-a", text: "Alice", display_order: 1 },
    { id: "opt-b", text: "Bob", display_order: 2 },
  ],
  tally: {
    yes: { voter_count: 0, entitlement_sum: 0 },
    no: { voter_count: 0, entitlement_sum: 0 },
    abstained: { voter_count: 1, entitlement_sum: 50 },
    absent: { voter_count: 1, entitlement_sum: 75 },
    not_eligible: { voter_count: 0, entitlement_sum: 0 },
    options: [
      { option_id: "opt-a", option_text: "Alice", display_order: 1, for_voter_count: 2, for_entitlement_sum: 200, against_voter_count: 1, against_entitlement_sum: 50, abstained_voter_count: 0, abstained_entitlement_sum: 0, voter_count: 2, entitlement_sum: 200, outcome: null },
      { option_id: "opt-b", option_text: "Bob", display_order: 2, for_voter_count: 1, for_entitlement_sum: 100, against_voter_count: 0, against_entitlement_sum: 0, abstained_voter_count: 1, abstained_entitlement_sum: 75, voter_count: 1, entitlement_sum: 100, outcome: null },
    ],
  },
  voter_lists: {
    yes: [],
    no: [],
    abstained: [{ voter_email: "abstainer@example.com", lot_number: "L10", entitlement: 50 }],
    absent: [{ voter_email: "absent@example.com", lot_number: "L11", entitlement: 75 }],
    not_eligible: [],
    options_for: {
      "opt-a": [
        { voter_email: "voter1@example.com", lot_number: "L1", entitlement: 100 },
        { voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 },
      ],
      "opt-b": [{ voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 }],
    },
    options_against: {
      "opt-a": [{ voter_email: "voter3@example.com", lot_number: "L3", entitlement: 50 }],
    },
    options_abstained: {
      "opt-b": [{ voter_email: "voter4@example.com", lot_number: "L4", entitlement: 75 }],
    },
    options: {
      "opt-a": [
        { voter_email: "voter1@example.com", lot_number: "L1", entitlement: 100 },
        { voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 },
      ],
      "opt-b": [{ voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 }],
    },
  },
};

// Helper to capture CSV text from a Blob created during export
async function captureCSVFromExport(
  motionData: MotionDetail[],
  agmTitle?: string
): Promise<string> {
  // Render FIRST so React can mount the component before we intercept DOM methods
  render(<AGMReportView motions={motionData} agmTitle={agmTitle} />);

  let capturedBlob: Blob | null = null;
  // JSDOM does not implement URL.createObjectURL — define it on the global URL object
  URL.createObjectURL = vi.fn((blob: Blob) => {
    capturedBlob = blob;
    return "blob:mock-url";
  });
  URL.revokeObjectURL = vi.fn();

  // Mock body DOM methods AFTER render so React can mount properly
  const appendChildSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);
  const removeChildSpy = vi.spyOn(document.body, "removeChild").mockImplementation((node) => node);
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Export voter lists/ }));

  appendChildSpy.mockRestore();
  removeChildSpy.mockRestore();
  clickSpy.mockRestore();

  if (!capturedBlob) throw new Error("Blob not captured");
  // Use FileReader to read Blob content (JSDOM compatible)
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(capturedBlob as Blob);
  });
}

describe("AGMReportView", () => {
  it("renders motion titles", () => {
    render(<AGMReportView motions={motions} />);
    expect(screen.getByText(/Motion 1/)).toBeInTheDocument();
    expect(screen.getByText(/Motion 2/)).toBeInTheDocument();
  });

  it("renders tally categories for each motion", () => {
    render(<AGMReportView motions={motions} />);
    const forCells = screen.getAllByText("For");
    expect(forCells.length).toBeGreaterThan(0);
    const againstCells = screen.getAllByText("Against");
    expect(againstCells.length).toBeGreaterThan(0);
  });

  it("renders voter counts", () => {
    render(<AGMReportView motions={motions} totalEntitlement={1000} />);
    // Yes tally for motion 1: voter_count=2
    const cells = screen.getAllByText("2");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("shows entitlement sum with percentage when totalEntitlement > 0", () => {
    // Motion 1 yes: entitlement_sum=200, total=1000 → 20.0%
    render(<AGMReportView motions={[motions[0]]} totalEntitlement={1000} />);
    expect(screen.getByText("200 (20.0%)")).toBeInTheDocument();
  });

  it("shows entitlement sum with percentage rounded to 1 decimal", () => {
    // Motion 1 no: entitlement_sum=100, total=300 → 33.3%
    render(<AGMReportView motions={[motions[0]]} totalEntitlement={300} />);
    expect(screen.getByText("100 (33.3%)")).toBeInTheDocument();
  });

  it("shows — for entitlement when totalEntitlement is 0", () => {
    render(<AGMReportView motions={[motions[0]]} totalEntitlement={0} />);
    // All categories should show — for entitlement
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("shows — when totalEntitlement prop is omitted (defaults to 0)", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("renders motion description when present", () => {
    render(<AGMReportView motions={motions} />);
    expect(screen.getByText("First motion description")).toBeInTheDocument();
  });

  it("does not render description when null", () => {
    render(<AGMReportView motions={[motions[1]]} />);
    // Motion 2 has no description
    expect(screen.queryByText("First motion description")).not.toBeInTheDocument();
  });

  it("shows General badge for general motion", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    const badge = screen.getByLabelText("Motion type: General");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("motion-type-badge--general");
  });

  it("shows Special badge for special motion", () => {
    render(<AGMReportView motions={[motions[1]]} />);
    const badge = screen.getByLabelText("Motion type: Special");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("motion-type-badge--special");
  });

  it("renders export CSV button", () => {
    render(<AGMReportView motions={motions} />);
    expect(screen.getByRole("button", { name: /Export voter lists/ })).toBeInTheDocument();
  });

  it("shows 'No motions recorded' when empty", () => {
    render(<AGMReportView motions={[]} />);
    expect(screen.getByText("No motions recorded.")).toBeInTheDocument();
  });

  it("shows Hidden badge for motion with is_visible=false", () => {
    const hiddenMotion: MotionDetail = {
      ...motions[0],
      id: "m-hidden",
      is_visible: false,
    };
    render(<AGMReportView motions={[hiddenMotion]} />);
    const badge = screen.getByLabelText("Motion is hidden from voters");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("motion-type-badge--hidden");
  });

  it("does not show Hidden badge for visible motion", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    expect(screen.queryByLabelText("Motion is hidden from voters")).not.toBeInTheDocument();
  });

  // --- CSV export: Voter Email column ---

  it("CSV header row contains all expected columns including 'Submitted By'", async () => {
    const csv = await captureCSVFromExport(motions);
    const headerRow = csv.split("\n")[0];
    expect(headerRow).toBe("Motion,Category,Lot Number,Entitlement (UOE),Voter Email,Submitted By");
  });

  it("CSV data row for direct-vote lot includes the voter email", async () => {
    const singleMotion: MotionDetail[] = [
      {
        ...motions[0],
        voter_lists: {
          ...motions[0].voter_lists,
          yes: [{ voter_email: "direct@example.com", lot_number: "L1", entitlement: 100 }],
          no: [],
          abstained: [],
          absent: [],
          not_eligible: [],
        },
      },
    ];
    const csv = await captureCSVFromExport(singleMotion);
    expect(csv).toContain('"direct@example.com"');
    expect(csv).not.toContain("(proxy)");
  });

  it("CSV data row for proxy-voted lot formats as 'voter (proxy)'", async () => {
    const singleMotion: MotionDetail[] = [
      {
        ...motions[0],
        voter_lists: {
          ...motions[0].voter_lists,
          yes: [
            {
              voter_email: "proxy@example.com",
              lot_number: "L1",
              entitlement: 100,
              proxy_email: "proxy@example.com",
            },
          ],
          no: [],
          abstained: [],
          absent: [],
          not_eligible: [],
        },
      },
    ];
    const csv = await captureCSVFromExport(singleMotion);
    expect(csv).toContain("proxy@example.com (proxy)");
  });

  it("CSV data row for absent lot shows comma-separated contact emails", async () => {
    const singleMotion: MotionDetail[] = [
      {
        ...motions[0],
        voter_lists: {
          ...motions[0].voter_lists,
          yes: [],
          no: [],
          abstained: [],
          absent: [
            {
              voter_email: "owner1@example.com, owner2@example.com",
              lot_number: "L4",
              entitlement: 100,
            },
          ],
          not_eligible: [],
        },
      },
    ];
    const csv = await captureCSVFromExport(singleMotion);
    expect(csv).toContain("owner1@example.com, owner2@example.com");
  });

  it("CSV data row for absent lot with no emails has blank Voter Email cell", async () => {
    const singleMotion: MotionDetail[] = [
      {
        ...motions[0],
        voter_lists: {
          ...motions[0].voter_lists,
          yes: [],
          no: [],
          abstained: [],
          absent: [
            {
              voter_email: "",
              lot_number: "L4",
              entitlement: 100,
            },
          ],
          not_eligible: [],
        },
      },
    ];
    const csv = await captureCSVFromExport(singleMotion);
    // The email cell should be empty (quoted empty string at end of row)
    expect(csv).toContain(',"L4",100,""');
  });

  it("CSV row for entry with undefined voter_email uses empty string", async () => {
    const singleMotion: MotionDetail[] = [
      {
        ...motions[0],
        voter_lists: {
          ...motions[0].voter_lists,
          yes: [
            {
              lot_number: "L1",
              entitlement: 100,
              // voter_email is intentionally omitted (undefined)
            },
          ],
          no: [],
          abstained: [],
          absent: [],
          not_eligible: [],
        },
      },
    ];
    const csv = await captureCSVFromExport(singleMotion);
    // Entry with no voter_email should produce empty email cell
    expect(csv).toContain(',"L1",100,""');
  });

  it("CSV export uses agmTitle in filename when provided", async () => {
    // Render first so React mounts before we mock DOM methods
    render(<AGMReportView motions={motions} agmTitle="My AGM 2024" />);
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
    let capturedDownload = "";
    const appendChildSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) {
        capturedDownload = node.download;
      }
      return node;
    });
    const removeChildSpy = vi.spyOn(document.body, "removeChild").mockImplementation((node) => node);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Export voter lists/ }));

    expect(capturedDownload).toContain("My_AGM_2024");
    appendChildSpy.mockRestore();
    removeChildSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("CSV export uses default filename when agmTitle is not provided", async () => {
    // Render first so React mounts before we mock DOM methods
    render(<AGMReportView motions={motions} />);
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
    let capturedDownload = "";
    const appendChildSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) {
        capturedDownload = node.download;
      }
      return node;
    });
    const removeChildSpy = vi.spyOn(document.body, "removeChild").mockImplementation((node) => node);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Export voter lists/ }));

    expect(capturedDownload).toBe("general_meeting_results.csv");
    appendChildSpy.mockRestore();
    removeChildSpy.mockRestore();
    clickSpy.mockRestore();
  });

  // --- Multi-choice motion rendering ---

  it("renders Multi-Choice badge for multi_choice motion", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const typeBadge = screen.getByLabelText("Motion type: General");
    expect(typeBadge).toBeInTheDocument();
    expect(typeBadge).toHaveClass("motion-type-badge--general");
    const mcBadge = screen.getByLabelText("Multi-choice motion");
    expect(mcBadge).toBeInTheDocument();
    expect(mcBadge).toHaveClass("motion-type-badge--multi_choice");
  });

  it("renders per-option tally rows for multi_choice motion", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("renders For/Against summary counts in collapsed header for multi_choice motion (Fix 3)", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    // Fix 3: For/Against counts are now visible in the header row without expanding
    expect(screen.getAllByText(/For/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Against/).length).toBeGreaterThan(0);
  });

  it("renders Absent row at motion level for multi_choice motion", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    expect(screen.getByText("Absent")).toBeInTheDocument();
  });

  it("Abstained counts appear in option header row (not as a motion-level row) for multi_choice motion (Fix 3)", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    // Fix 3: Abstained now shows as per-option summary count in the collapsed header.
    // The motion-level separate Abstained row is NOT rendered (preventing double-counting).
    // The summary count text includes "Abstained" as part of the header counts.
    const abstainedText = screen.getAllByText(/Abstained/);
    expect(abstainedText.length).toBeGreaterThan(0);
  });

  it("CSV export for multi_choice motion uses Option: prefix", async () => {
    const csv = await captureCSVFromExport([mcMotionFixture]);
    expect(csv).toContain("Option: Alice");
    expect(csv).toContain("Option: Bob");
  });

  it("CSV export for multi_choice includes abstained/absent rows", async () => {
    const csv = await captureCSVFromExport([mcMotionFixture]);
    expect(csv).toContain("Abstained");
    expect(csv).toContain("Absent");
  });

  it("CSV export for multi_choice does not include For/Against rows", async () => {
    const csv = await captureCSVFromExport([mcMotionFixture]);
    const rows = csv.split("\n").filter((r) => r.trim());
    const forRow = rows.find((r) => r.includes(',"For",'));
    const againstRow = rows.find((r) => r.includes(',"Against",'));
    expect(forRow).toBeUndefined();
    expect(againstRow).toBeUndefined();
  });

  it("CSV export for multi_choice option voter with proxy shows (proxy) suffix", async () => {
    const mcWithProxy: MotionDetail = {
      ...mcMotionFixture,
      voter_lists: {
        ...mcMotionFixture.voter_lists,
        options_for: {
          "opt-a": [
            { voter_email: "proxy@example.com", lot_number: "L1", entitlement: 100, proxy_email: "proxy@example.com" },
          ],
          "opt-b": [],
        },
        options_against: {},
        options_abstained: {},
        options: {
          "opt-a": [
            { voter_email: "proxy@example.com", lot_number: "L1", entitlement: 100, proxy_email: "proxy@example.com" },
          ],
          "opt-b": [],
        },
      },
    };
    const csv = await captureCSVFromExport([mcWithProxy]);
    expect(csv).toContain("proxy@example.com (proxy)");
  });

  it("CSV export for multi_choice abstained voter with proxy shows (proxy) suffix", async () => {
    const mcWithProxy: MotionDetail = {
      ...mcMotionFixture,
      voter_lists: {
        ...mcMotionFixture.voter_lists,
        abstained: [
          { voter_email: "abs_proxy@example.com", lot_number: "L10", entitlement: 50, proxy_email: "abs_proxy@example.com" },
        ],
      },
    };
    const csv = await captureCSVFromExport([mcWithProxy]);
    expect(csv).toContain("abs_proxy@example.com (proxy)");
  });

  // --- Fix 4: is_multi_choice flag governs MC rendering (not motion_type === "multi_choice") ---

  it("renders MC table rows when is_multi_choice=true even with motion_type='general'", () => {
    // Real-world scenario: motion_type is "general" but is_multi_choice is true.
    // Before the fix, the component checked motion_type === "multi_choice" so this would
    // render For/Against rows instead of per-option rows.
    const realWorldMcMotion: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-real",
      motion_type: "general" as const,  // NOT "multi_choice"
      is_multi_choice: true,
    };
    render(<AGMReportView motions={[realWorldMcMotion]} />);
    // Should render option rows (Alice, Bob) with per-option For/Against counts in the header (Fix 3)
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    // For/Against now appear in header counts — the important check is that binary row cells
    // (separate <tr> for For/Against) are NOT rendered; only option rows appear.
    // Verify the per-option Show voting details buttons are present
    expect(screen.getAllByRole("button", { name: /Show voting details for/ }).length).toBeGreaterThan(0);
  });

  it("CSV export uses MC format when is_multi_choice=true and motion_type='general'", async () => {
    const realWorldMcMotion: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-real2",
      motion_type: "general" as const,
      is_multi_choice: true,
    };
    const csv = await captureCSVFromExport([realWorldMcMotion]);
    expect(csv).toContain("Option: Alice");
    expect(csv).not.toContain(",\"For\",");
  });

  it("renders For/Against rows for general motion WITHOUT is_multi_choice flag", () => {
    // Sanity check: a plain general motion with is_multi_choice=false (or absent)
    // still renders For/Against rows.
    render(<AGMReportView motions={[motions[0]]} />);
    expect(screen.getByText("For")).toBeInTheDocument();
    expect(screen.getByText("Against")).toBeInTheDocument();
  });

  // --- Outcome badges (Slice 4 — US-MC-RESULT-01) ---

  it("renders Pass badge when outcome is 'pass'", () => {
    const mcWithPass: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-pass",
      tally: {
        ...mcMotionFixture.tally,
        options: [
          { option_id: "opt-a", option_text: "Alice", display_order: 1, voter_count: 2, entitlement_sum: 200, outcome: "pass" },
          { option_id: "opt-b", option_text: "Bob", display_order: 2, voter_count: 1, entitlement_sum: 100, outcome: "fail" },
        ],
      },
    };
    render(<AGMReportView motions={[mcWithPass]} />);
    expect(screen.getByLabelText("Outcome: Pass")).toBeInTheDocument();
  });

  it("renders Fail badge when outcome is 'fail'", () => {
    const mcWithFail: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-fail",
      tally: {
        ...mcMotionFixture.tally,
        options: [
          { option_id: "opt-a", option_text: "Alice", display_order: 1, voter_count: 2, entitlement_sum: 200, outcome: "pass" },
          { option_id: "opt-b", option_text: "Bob", display_order: 2, voter_count: 1, entitlement_sum: 100, outcome: "fail" },
        ],
      },
    };
    render(<AGMReportView motions={[mcWithFail]} />);
    expect(screen.getByLabelText("Outcome: Fail")).toBeInTheDocument();
  });

  it("renders Tie badge when outcome is 'tie'", () => {
    const mcWithTie: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-tie",
      tally: {
        ...mcMotionFixture.tally,
        options: [
          { option_id: "opt-a", option_text: "Alice", display_order: 1, voter_count: 2, entitlement_sum: 200, outcome: "tie" },
          { option_id: "opt-b", option_text: "Bob", display_order: 2, voter_count: 2, entitlement_sum: 200, outcome: "tie" },
        ],
      },
    };
    render(<AGMReportView motions={[mcWithTie]} />);
    const tieBadges = screen.getAllByLabelText("Outcome: Tie — admin review required");
    expect(tieBadges).toHaveLength(2);
  });

  it("renders no outcome badges when outcome is null", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    expect(screen.queryByLabelText("Outcome: Pass")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Outcome: Fail")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Outcome: Tie — admin review required")).not.toBeInTheDocument();
  });

  it("renders outcome badges for all options in a meeting", () => {
    const mcAllOutcomes: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-all-outcomes",
      options: [
        { id: "opt-a", text: "Alice", display_order: 1 },
        { id: "opt-b", text: "Bob", display_order: 2 },
        { id: "opt-c", text: "Carol", display_order: 3 },
      ],
      tally: {
        ...mcMotionFixture.tally,
        options: [
          { option_id: "opt-a", option_text: "Alice", display_order: 1, voter_count: 3, entitlement_sum: 300, outcome: "pass" },
          { option_id: "opt-b", option_text: "Bob", display_order: 2, voter_count: 2, entitlement_sum: 200, outcome: "tie" },
          { option_id: "opt-c", option_text: "Carol", display_order: 3, voter_count: 1, entitlement_sum: 100, outcome: "fail" },
        ],
      },
    };
    render(<AGMReportView motions={[mcAllOutcomes]} />);
    expect(screen.getByLabelText("Outcome: Pass")).toBeInTheDocument();
    expect(screen.getByLabelText("Outcome: Tie — admin review required")).toBeInTheDocument();
    expect(screen.getByLabelText("Outcome: Fail")).toBeInTheDocument();
  });

  // --- Slice 10: Expand/Collapse For/Against/Abstained sub-rows (US-MC-ADMIN-01) ---

  it("shows 'Show voting details' button for multi-choice option rows (Fix 3)", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showVotersButtons = screen.getAllByRole("button", { name: /Show voting details for/ });
    expect(showVotersButtons).toHaveLength(2);
  });

  it("For/Against/Abstained summary counts visible in collapsed header (Fix 3)", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    // Fix 3: summary counts are now in the header, visible without expanding
    expect(screen.getAllByText(/For/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Against/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Abstained/).length).toBeGreaterThan(0);
  });

  it("voter list is NOT shown by default (Fix 3: only voter list is in expanded section)", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    // The voter email detail is hidden until "Show voters" is clicked
    expect(screen.queryByText(/voter1@example\.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/voter3@example\.com/)).not.toBeInTheDocument();
  });

  it("clicking 'Show voting details' reveals voter list (Fix 3)", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    // Voter list should now be visible
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
    // Against voter (voter3@example.com)
    expect(screen.getByText(/voter3@example\.com/)).toBeInTheDocument();
  });

  it("clicking 'Show voting details' then 'Hide voting details' hides voter list again (Fix 3)", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
    // Click hide button
    const hideBtn = screen.getAllByRole("button", { name: /Hide voting details for Alice/ })[0];
    await user.click(hideBtn);
    expect(screen.queryByText(/voter1@example\.com/)).not.toBeInTheDocument();
  });

  it("expanded section shows abstained voter list when present (Fix 3)", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Bob/ })[0];
    await user.click(showBtn);
    // Bob has abstained voter (voter4@example.com)
    expect(screen.getByText(/voter4@example\.com/)).toBeInTheDocument();
  });

  it("CSV export includes Against voter with proxy suffix", async () => {
    const mcWithAgainstProxy: MotionDetail = {
      ...mcMotionFixture,
      voter_lists: {
        ...mcMotionFixture.voter_lists,
        options_for: {},
        options_against: {
          "opt-a": [
            { voter_email: "against_proxy@example.com", lot_number: "L1", entitlement: 100, proxy_email: "against_proxy@example.com" },
          ],
        },
        options_abstained: {},
        options: {},
      },
    };
    const csv = await captureCSVFromExport([mcWithAgainstProxy]);
    expect(csv).toContain("against_proxy@example.com (proxy)");
    expect(csv).toContain("Option: Alice — Against");
  });

  it("CSV export includes Abstained voter with proxy suffix", async () => {
    const mcWithAbstainedProxy: MotionDetail = {
      ...mcMotionFixture,
      voter_lists: {
        ...mcMotionFixture.voter_lists,
        options_for: {},
        options_against: {},
        options_abstained: {
          "opt-a": [
            { voter_email: "abs_proxy@example.com", lot_number: "L1", entitlement: 100, proxy_email: "abs_proxy@example.com" },
          ],
        },
        options: {},
      },
    };
    const csv = await captureCSVFromExport([mcWithAbstainedProxy]);
    expect(csv).toContain("abs_proxy@example.com (proxy)");
    expect(csv).toContain("Option: Alice — Abstained");
  });

  // --- MC drill-down: table format (matching binary voter drill-down) ---

  it("MC drill-down: expanded option shows admin-table with correct headers", async () => {
    const user = userEvent.setup();
    const { container } = render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    const table = container.querySelector(".admin-table-wrapper .admin-table");
    expect(table).not.toBeNull();
    expect(screen.getAllByText("Lot #").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Email").length).toBeGreaterThan(0);
    expect(screen.getAllByText("UOE").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Submitted By").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Choice").length).toBeGreaterThan(0);
  });

  it("MC drill-down: voter row contains lot number, email, entitlement, and choice badge", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    // opt-a has For: voter1 (L1, 100), voter2 (L2, 100); Against: voter3 (L3, 50)
    expect(screen.getByText("voter1@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("L1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Voter").length).toBeGreaterThan(0);
  });

  it("MC drill-down: For voters show For choice badge", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    // For voters get "For" badge — multiple exist (summary count + badge)
    const forBadges = screen.getAllByText("For");
    expect(forBadges.length).toBeGreaterThan(0);
  });

  it("MC drill-down: Against voters show Against choice badge", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    // voter3 is Against for opt-a
    const againstBadges = screen.getAllByText("Against");
    expect(againstBadges.length).toBeGreaterThan(0);
    expect(screen.getByText("voter3@example.com")).toBeInTheDocument();
  });

  it("MC drill-down: Abstained voters show Abstained choice badge", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Bob/ })[0];
    await user.click(showBtn);
    // voter4 is Abstained for opt-b
    expect(screen.getByText("voter4@example.com")).toBeInTheDocument();
    const abstainedBadges = screen.getAllByText("Abstained");
    expect(abstainedBadges.length).toBeGreaterThan(0);
  });

  it("MC drill-down: proxy voter shows (proxy) indicator next to email", async () => {
    const user = userEvent.setup();
    const mcWithProxy: MotionDetail = {
      ...mcMotionFixture,
      voter_lists: {
        ...mcMotionFixture.voter_lists,
        options_for: {
          "opt-a": [
            { voter_email: "proxy@example.com", lot_number: "L1", entitlement: 100, proxy_email: "proxy@example.com" },
          ],
          "opt-b": [],
        },
        options_against: {},
        options_abstained: {},
        options: {
          "opt-a": [
            { voter_email: "proxy@example.com", lot_number: "L1", entitlement: 100, proxy_email: "proxy@example.com" },
          ],
          "opt-b": [],
        },
      },
    };
    render(<AGMReportView motions={[mcWithProxy]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    expect(screen.getByText("(proxy)")).toBeInTheDocument();
  });

  it("MC drill-down: admin-submitted ballot shows 'Admin' in Submitted By column", async () => {
    const user = userEvent.setup();
    const mcWithAdmin: MotionDetail = {
      ...mcMotionFixture,
      voter_lists: {
        ...mcMotionFixture.voter_lists,
        options_for: {
          "opt-a": [
            { voter_email: "admin@example.com", lot_number: "L1", entitlement: 100, submitted_by_admin: true },
          ],
          "opt-b": [],
        },
        options_against: {},
        options_abstained: {},
        options: {
          "opt-a": [
            { voter_email: "admin@example.com", lot_number: "L1", entitlement: 100, submitted_by_admin: true },
          ],
          "opt-b": [],
        },
      },
    };
    render(<AGMReportView motions={[mcWithAdmin]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("MC drill-down: option with no voters shows 'No voter records.'", async () => {
    const user = userEvent.setup();
    const mcEmpty: MotionDetail = {
      ...mcMotionFixture,
      voter_lists: {
        ...mcMotionFixture.voter_lists,
        options_for: { "opt-a": [], "opt-b": [] },
        options_against: {},
        options_abstained: {},
        options: { "opt-a": [], "opt-b": [] },
      },
    };
    render(<AGMReportView motions={[mcEmpty]} />);
    const showBtn = screen.getAllByRole("button", { name: /Show voting details for Alice/ })[0];
    await user.click(showBtn);
    expect(screen.getByText("No voter records.")).toBeInTheDocument();
  });

  it("CSV row with proxy_email containing double-quotes has them escaped", async () => {
    const singleMotion: MotionDetail[] = [
      {
        ...motions[0],
        voter_lists: {
          ...motions[0].voter_lists,
          yes: [
            {
              voter_email: 'test"quoted@example.com',
              lot_number: "L1",
              entitlement: 100,
            },
          ],
          no: [],
          abstained: [],
          absent: [],
          not_eligible: [],
        },
      },
    ];
    const csv = await captureCSVFromExport(singleMotion);
    // Double-quotes in the email should be escaped as ""
    expect(csv).toContain('""quoted@example.com"');
  });

  // --- RR4-22: OutcomeBadge uses CSS classes, not inline styles ---

  it("RR4-22: OutcomeBadge for pass uses outcome-badge--pass class, not inline colour styles", () => {
    const passMotion: MotionDetail = {
      ...mcMotionFixture,
      tally: {
        ...mcMotionFixture.tally,
        options: [
          {
            ...mcMotionFixture.tally.options[0],
            outcome: "pass",
          },
          mcMotionFixture.tally.options[1],
        ],
      },
    };
    render(<AGMReportView motions={[passMotion]} totalEntitlement={500} />);
    const badge = screen.getByLabelText("Outcome: Pass");
    expect(badge).toHaveClass("outcome-badge--pass");
    expect(badge).toHaveClass("outcome-badge");
    // Must NOT have inline colour styles
    expect(badge.getAttribute("style")).toBeFalsy();
  });

  it("RR4-22: OutcomeBadge for fail uses outcome-badge--fail class, not inline colour styles", () => {
    const failMotion: MotionDetail = {
      ...mcMotionFixture,
      tally: {
        ...mcMotionFixture.tally,
        options: [
          {
            ...mcMotionFixture.tally.options[0],
            outcome: "fail",
          },
          mcMotionFixture.tally.options[1],
        ],
      },
    };
    render(<AGMReportView motions={[failMotion]} totalEntitlement={500} />);
    const badge = screen.getByLabelText("Outcome: Fail");
    expect(badge).toHaveClass("outcome-badge--fail");
    expect(badge.getAttribute("style")).toBeFalsy();
  });

  it("RR4-22: OutcomeBadge for tie uses outcome-badge--tie class, not inline colour styles", () => {
    const tieMotion: MotionDetail = {
      ...mcMotionFixture,
      tally: {
        ...mcMotionFixture.tally,
        options: [
          {
            ...mcMotionFixture.tally.options[0],
            outcome: "tie",
          },
          mcMotionFixture.tally.options[1],
        ],
      },
    };
    render(<AGMReportView motions={[tieMotion]} totalEntitlement={500} />);
    const badge = screen.getByLabelText("Outcome: Tie — admin review required");
    expect(badge).toHaveClass("outcome-badge--tie");
    expect(badge.getAttribute("style")).toBeFalsy();
  });

  it("RR4-22: OutcomeBadge renders nothing when outcome is null", () => {
    render(<AGMReportView motions={[mcMotionFixture]} totalEntitlement={500} />);
    expect(screen.queryByLabelText(/Outcome:/i)).not.toBeInTheDocument();
  });

  // --- Fix 4: binary winner highlight ---

  it("Fix 4: highlights 'For' row in green when yes_sum > no_sum", () => {
    const { container } = render(<AGMReportView motions={[motions[0]]} totalEntitlement={500} />);
    // motions[0]: yes=200, no=100 — For row should be highlighted
    const rows = container.querySelectorAll("tbody tr");
    // First row is "For" (yes)
    const forRow = Array.from(rows).find((r) => r.textContent?.includes("For"));
    expect(forRow).toBeTruthy();
    // Row should have green highlight style
    expect(forRow?.getAttribute("style")).toContain("var(--green)");
  });

  it("Fix 4: highlights 'Against' row in red when no_sum > yes_sum", () => {
    const againstWinsMotion: MotionDetail = {
      ...motions[0],
      id: "against-wins",
      tally: {
        ...motions[0].tally,
        yes: { voter_count: 1, entitlement_sum: 50 },
        no: { voter_count: 2, entitlement_sum: 200 },
      },
    };
    const { container } = render(<AGMReportView motions={[againstWinsMotion]} totalEntitlement={500} />);
    const rows = container.querySelectorAll("tbody tr");
    const againstRow = Array.from(rows).find((r) => r.textContent?.includes("Against"));
    expect(againstRow).toBeTruthy();
    expect(againstRow?.getAttribute("style")).toContain("var(--red)");
  });

  it("Fix 4: no highlight when yes_sum equals no_sum (tie)", () => {
    const tieMotion: MotionDetail = {
      ...motions[0],
      id: "tie-binary",
      tally: {
        ...motions[0].tally,
        yes: { voter_count: 1, entitlement_sum: 100 },
        no: { voter_count: 1, entitlement_sum: 100 },
      },
    };
    const { container } = render(<AGMReportView motions={[tieMotion]} totalEntitlement={500} />);
    const rows = container.querySelectorAll("tbody tr");
    const forRow = Array.from(rows).find((r) => r.textContent?.includes("For"));
    const againstRow = Array.from(rows).find((r) => r.textContent?.includes("Against"));
    // Neither row should have highlight styles
    expect(forRow?.getAttribute("style")).toBeNull();
    expect(againstRow?.getAttribute("style")).toBeNull();
  });

  it("Fix 4: highlights winning MC options by for_entitlement_sum (top N by option_limit)", () => {
    // option_limit=2, opt-a has highest for entitlement (200), opt-b next (100)
    const { container } = render(<AGMReportView motions={[mcMotionFixture]} totalEntitlement={500} />);
    const optionRows = container.querySelectorAll("tbody tr[style]");
    // At least one row should have green highlight for the winner
    const greenRows = Array.from(optionRows).filter((r) =>
      r.getAttribute("style")?.includes("var(--green)")
    );
    expect(greenRows.length).toBeGreaterThan(0);
  });

  it("Fix 4: handles MC option with null for_entitlement_sum using entitlement_sum fallback", () => {
    // Cover the `?? b.entitlement_sum ?? 0` fallback in the sort comparator
    const mcWithNullForEntitlement: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-null-for",
      tally: {
        ...mcMotionFixture.tally,
        options: [
          // for_entitlement_sum is undefined — falls back to entitlement_sum
          { option_id: "opt-a", option_text: "Alice", display_order: 1, voter_count: 2, entitlement_sum: 200, outcome: null },
          { option_id: "opt-b", option_text: "Bob", display_order: 2, voter_count: 1, entitlement_sum: 100, outcome: null },
        ],
      },
    };
    render(<AGMReportView motions={[mcWithNullForEntitlement]} totalEntitlement={500} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("Fix 4: handles MC option with both for_entitlement_sum and entitlement_sum null (fallback to 0)", () => {
    // Cover the final `?? 0` in `b.for_entitlement_sum ?? b.entitlement_sum ?? 0`
    const mcBothNull: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-both-null",
      tally: {
        ...mcMotionFixture.tally,
        options: [
          // Both for_entitlement_sum and entitlement_sum are undefined → 0
          { option_id: "opt-a", option_text: "Alice", display_order: 1, voter_count: 0, outcome: null } as Parameters<typeof Array.prototype.push>[0],
          { option_id: "opt-b", option_text: "Bob", display_order: 2, voter_count: 0, outcome: null } as Parameters<typeof Array.prototype.push>[0],
        ] as MotionDetail["tally"]["options"],
      },
    };
    render(<AGMReportView motions={[mcBothNull]} totalEntitlement={500} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("Fix 4: handles MC motion with no options (tally.options is empty array)", () => {
    // Cover the `options ?? []` path when options is empty
    const mcNoOptions: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-no-opts",
      options: [],
      tally: {
        ...mcMotionFixture.tally,
        options: [],
      },
    };
    render(<AGMReportView motions={[mcNoOptions]} totalEntitlement={500} />);
    // Should render without error; absent row should still show
    expect(screen.getByText("Absent")).toBeInTheDocument();
  });

  it("Fix 4: handles MC motion with null tally.options (fallback to empty array)", () => {
    // Cover the `tally.options ?? []` null-coalescing branch
    const mcNullOptions: MotionDetail = {
      ...mcMotionFixture,
      id: "mc-null-options",
      tally: {
        ...mcMotionFixture.tally,
        options: null as unknown as MotionDetail["tally"]["options"],
      },
    };
    render(<AGMReportView motions={[mcNullOptions]} totalEntitlement={500} />);
    // Should render without error
    expect(screen.getByText("Absent")).toBeInTheDocument();
  });

  // --- Fix 10: per-binary-motion voter drill-down ---

  it("Fix 10: binary motion shows '▶ Show voting details' expand button", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    expect(screen.getByRole("button", { name: /Expand voting details for Motion 1/ })).toBeInTheDocument();
    expect(screen.getByText("▶ Show voting details")).toBeInTheDocument();
  });

  it("Fix 10: voter list is hidden before expand button is clicked", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    // voter1@example.com is in the Yes category — should not be visible by default
    expect(screen.queryByText("voter1@example.com")).not.toBeInTheDocument();
  });

  it("Fix 10: clicking expand reveals binary voter list as table", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    // voter1 and voter3 are in For/Against categories — visible in table rows
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/voter3@example\.com/)).toBeInTheDocument();
  });

  it("Fix 10: button label changes to 'Collapse voting details' after expanding", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    expect(screen.getByRole("button", { name: /Collapse voting details for Motion 1/ })).toBeInTheDocument();
    expect(screen.getByText("▲ Hide voting details")).toBeInTheDocument();
  });

  it("Fix 10: clicking collapse hides voter list again (toggleExpanded toggles off)", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    const btn = screen.getByRole("button", { name: /Expand voting details for Motion 1/ });
    await user.click(btn); // expand
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
    const collapseBtn = screen.getByRole("button", { name: /Collapse voting details for Motion 1/ });
    await user.click(collapseBtn); // collapse
    expect(screen.queryByText(/voter1@example\.com/)).not.toBeInTheDocument();
  });

  it("Fix 10: two binary motions can be independently expanded", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={motions} />);
    // Expand motion 1
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
    // Expand motion 2
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 2/ }));
    // Both voter lists shown
    expect(screen.getAllByText(/voter1@example\.com/).length).toBeGreaterThanOrEqual(1);
  });

  it("Fix 10: multi-choice motions do NOT get an expand/collapse button", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    // The per-option "Show voting details" buttons exist, but NOT the binary voter-list expand button
    // Binary expand button aria-label format: "Expand voting details for <title>"
    expect(screen.queryByRole("button", { name: /Expand voting details for Board Election/ })).not.toBeInTheDocument();
  });

  it("Fix 10: absent voters appear in expanded voter list", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    // Absent voters in motions[0]: voter4 and voter5
    expect(screen.getByText(/voter4@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/voter5@example\.com/)).toBeInTheDocument();
  });

  it("Fix 10: BinaryVoterList handles empty voter category gracefully", async () => {
    const user = userEvent.setup();
    // motions[0].voter_lists.abstained is [] — should not render that category
    render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    // No error thrown; voter list renders for non-empty categories only
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
  });

  // --- Fix 4: renamed button labels ---

  it("Fix 4: binary motion expand button shows 'Show voting details' text", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    expect(screen.getByText("▶ Show voting details")).toBeInTheDocument();
  });

  it("Fix 4: after expand binary motion button shows 'Hide voting details' text", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    expect(screen.getByText("▲ Hide voting details")).toBeInTheDocument();
  });

  it("Fix 4: aria-expanded is false before clicking binary expand button", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    const btn = screen.getByRole("button", { name: /Expand voting details for Motion 1/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("Fix 4: aria-expanded is true after clicking binary expand button", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    const btn = screen.getByRole("button", { name: /Expand voting details for Motion 1/ });
    await user.click(btn);
    // After click the button gets new aria-label "Collapse voting details for..."
    const collapseBtn = screen.getByRole("button", { name: /Collapse voting details for Motion 1/ });
    expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
  });

  it("Fix 4: multi-choice option button shows 'Show voting details' text", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    const showBtns = screen.getAllByText("▶ Show voting details");
    expect(showBtns.length).toBeGreaterThan(0);
  });

  // --- Fix 6: tabular BinaryVoterList ---

  it("Fix 6: expanded binary motion shows admin-table with correct headers", async () => {
    const user = userEvent.setup();
    const { container } = render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    const table = container.querySelector(".admin-table-wrapper .admin-table");
    expect(table).not.toBeNull();
    expect(screen.getByText("Lot #")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("UOE")).toBeInTheDocument();
    expect(screen.getByText("Submitted By")).toBeInTheDocument();
    expect(screen.getByText("Choice")).toBeInTheDocument();
  });

  it("Fix 6: voter row contains lot number, email, entitlement, Voter label, and choice badge", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    // voter1@example.com is a For voter in lot L1 with entitlement 100
    expect(screen.getByText("voter1@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("L1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Voter").length).toBeGreaterThan(0);
    // Check choice badge text (For)
    const forBadges = screen.getAllByText("For");
    expect(forBadges.length).toBeGreaterThan(0);
  });

  it("Fix 6: proxy voter shows (proxy) indicator next to email", async () => {
    const user = userEvent.setup();
    const motionWithProxy: typeof motions[0] = {
      ...motions[0],
      voter_lists: {
        ...motions[0].voter_lists,
        yes: [{ voter_email: "proxy@example.com", lot_number: "L1", entitlement: 100, proxy_email: "proxy@example.com" }],
        no: [],
        abstained: [],
        absent: [],
        not_eligible: [],
      },
    };
    render(<AGMReportView motions={[motionWithProxy]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    expect(screen.getByText("(proxy)")).toBeInTheDocument();
  });

  it("Fix 6: admin-submitted ballot shows 'Admin' in Submitted By column", async () => {
    const user = userEvent.setup();
    const motionWithAdmin: typeof motions[0] = {
      ...motions[0],
      voter_lists: {
        ...motions[0].voter_lists,
        yes: [{ voter_email: "admin@example.com", lot_number: "L1", entitlement: 100, submitted_by_admin: true }],
        no: [],
        abstained: [],
        absent: [],
        not_eligible: [],
      },
    };
    render(<AGMReportView motions={[motionWithAdmin]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("Fix 6: empty voter lists show 'No voter records.' message", async () => {
    const user = userEvent.setup();
    const emptyMotion: typeof motions[0] = {
      ...motions[0],
      voter_lists: {
        yes: [],
        no: [],
        abstained: [],
        absent: [],
        not_eligible: [],
        options: {},
      },
    };
    render(<AGMReportView motions={[emptyMotion]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    expect(screen.getByText("No voter records.")).toBeInTheDocument();
  });

  it("Fix 6: not_eligible voter shows 'Not eligible' choice badge", async () => {
    const user = userEvent.setup();
    const motionWithNotEligible: typeof motions[0] = {
      ...motions[0],
      voter_lists: {
        yes: [],
        no: [],
        abstained: [],
        absent: [],
        not_eligible: [{ voter_email: "ne@example.com", lot_number: "L1", entitlement: 50 }],
        options: {},
      },
    };
    render(<AGMReportView motions={[motionWithNotEligible]} />);
    await user.click(screen.getByRole("button", { name: /Expand voting details for Motion 1/ }));
    // Multiple "Not eligible" text nodes may exist (tally row + badge) — assert at least one is present
    expect(screen.getAllByText("Not eligible").length).toBeGreaterThan(0);
  });
});
