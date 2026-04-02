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
      { option_id: "opt-a", option_text: "Alice", display_order: 1, voter_count: 2, entitlement_sum: 200 },
      { option_id: "opt-b", option_text: "Bob", display_order: 2, voter_count: 1, entitlement_sum: 100 },
    ],
  },
  voter_lists: {
    yes: [],
    no: [],
    abstained: [{ voter_email: "abstainer@example.com", lot_number: "L10", entitlement: 50 }],
    absent: [{ voter_email: "absent@example.com", lot_number: "L11", entitlement: 75 }],
    not_eligible: [],
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

  it("does not render For/Against rows for multi_choice motion", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    // For and Against categories don't appear for MC motions
    expect(screen.queryByText("For")).not.toBeInTheDocument();
    expect(screen.queryByText("Against")).not.toBeInTheDocument();
  });

  it("renders Abstained and Absent rows for multi_choice motion", () => {
    render(<AGMReportView motions={[mcMotionFixture]} />);
    expect(screen.getByText("Abstained")).toBeInTheDocument();
    expect(screen.getByText("Absent")).toBeInTheDocument();
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
    // Should render option rows (Alice, Bob) — not For/Against
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByText("For")).not.toBeInTheDocument();
    expect(screen.queryByText("Against")).not.toBeInTheDocument();
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
});
