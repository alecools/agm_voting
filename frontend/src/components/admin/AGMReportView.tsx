import { useState } from "react";
import type { MotionDetail, OptionTallyEntry } from "../../api/admin";

function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return null;
  if (outcome === "pass") {
    return (
      <span
        className="outcome-badge outcome-badge--pass"
        aria-label="Outcome: Pass"
      >
        Pass
      </span>
    );
  }
  if (outcome === "fail") {
    return (
      <span
        className="outcome-badge outcome-badge--fail"
        aria-label="Outcome: Fail"
      >
        Fail
      </span>
    );
  }
  // tie
  return (
    <span
      className="outcome-badge outcome-badge--tie"
      aria-label="Outcome: Tie — admin review required"
    >
      Tie — admin review required
    </span>
  );
}

interface AGMReportViewProps {
  motions: MotionDetail[];
  agmTitle?: string;
  totalEntitlement?: number;
}

function formatEntitlementPct(sum: number, total: number): string {
  if (total === 0) return "—";
  const pct = (sum / total) * 100;
  return `${sum} (${pct.toFixed(1)}%)`;
}

const CATEGORY_LABELS: Record<string, string> = {
  yes: "For",
  no: "Against",
  abstained: "Abstained",
  absent: "Absent",
  not_eligible: "Not eligible",
};

const CATEGORY_COLORS: Record<string, string> = {
  yes: "var(--green)",
  no: "var(--red)",
  abstained: "var(--text-muted)",
  absent: "var(--text-muted)",
  not_eligible: "var(--text-muted)",
};

const CHOICE_BG_COLORS: Record<string, string> = {
  yes: "var(--green-bg)",
  no: "var(--red-bg)",
  abstained: "#F0EFEE",
  absent: "#F0EFEE",
  not_eligible: "#F0EFEE",
};

interface MultiChoiceOptionRowsProps {
  optTally: OptionTallyEntry;
  motion: MotionDetail;
  totalEntitlement: number;
  isWinner: boolean;
}

function MultiChoiceOptionRows({ optTally, motion, totalEntitlement, isWinner }: MultiChoiceOptionRowsProps) {
  const [expanded, setExpanded] = useState(false);

  const forVoters = motion.voter_lists.options_for?.[optTally.option_id] ?? motion.voter_lists.options?.[optTally.option_id] ?? [];
  const againstVoters = motion.voter_lists.options_against?.[optTally.option_id] ?? [];
  const abstainedVoters = motion.voter_lists.options_abstained?.[optTally.option_id] ?? [];

  const forVoterCount = optTally.for_voter_count ?? optTally.voter_count ?? 0;
  const forEntitlementSum = optTally.for_entitlement_sum ?? optTally.entitlement_sum ?? 0;
  const againstVoterCount = optTally.against_voter_count ?? 0;
  const againstEntitlementSum = optTally.against_entitlement_sum ?? 0;
  const abstainedVoterCount = optTally.abstained_voter_count ?? 0;
  const abstainedEntitlementSum = optTally.abstained_entitlement_sum ?? 0;

  return (
    <>
      {/* Fix 3 & 4: option header row now includes summary counts; highlight winning options */}
      <tr style={isWinner ? { borderLeft: "4px solid var(--green)", background: "var(--green-bg)" } : undefined}>
        <td colSpan={3} style={{ padding: "8px 10px", background: isWinner ? undefined : "var(--surface-raised, #f7f7f7)", borderBottom: "1px solid var(--border, #e0e0e0)" }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 600 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--navy)", flexShrink: 0 }} />
              {optTally.option_text}
              <OutcomeBadge outcome={optTally.outcome} />
            </span>
            {/* Fix 3: summary counts visible in collapsed state */}
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "inline-flex", gap: 8 }}>
              <span style={{ color: "var(--green)" }}>{forVoterCount} For ({formatEntitlementPct(forEntitlementSum, totalEntitlement)})</span>
              <span style={{ color: "var(--red)" }}>{againstVoterCount} Against ({formatEntitlementPct(againstEntitlementSum, totalEntitlement)})</span>
              <span>{abstainedVoterCount} Abstained ({formatEntitlementPct(abstainedEntitlementSum, totalEntitlement)})</span>
            </span>
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide voting details" : "Show voting details"} for ${optTally.option_text}`}
              onClick={() => setExpanded((v) => !v)}
              style={{
                marginLeft: "auto",
                fontSize: "0.8125rem",
                fontWeight: 600,
                cursor: "pointer",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-sm)",
                padding: "3px 10px",
                color: "var(--text-secondary)",
              }}
            >
              {expanded ? "▲ Hide voting details" : "▶ Show voting details"}
            </button>
          </div>
        </td>
      </tr>
      {/* expanded section: flat table matching binary voter drill-down format */}
      {expanded && (
        <tr>
          <td colSpan={3} style={{ padding: 0, borderTop: "1px solid var(--border-subtle)" }}>
            {(() => {
              type OptionChoice = "for" | "against" | "abstained";
              const OPTION_CHOICE_LABELS: Record<OptionChoice, string> = {
                for: "For",
                against: "Against",
                abstained: "Abstained",
              };
              const OPTION_CHOICE_COLORS: Record<OptionChoice, string> = {
                for: "var(--green)",
                against: "var(--red)",
                abstained: "var(--text-muted)",
              };
              const OPTION_CHOICE_BG: Record<OptionChoice, string> = {
                for: "var(--green-bg)",
                against: "var(--red-bg)",
                abstained: "#F0EFEE",
              };
              const rows: Array<{ choice: OptionChoice; voter: typeof forVoters[number] }> = [
                ...forVoters.map((v) => ({ choice: "for" as const, voter: v })),
                ...againstVoters.map((v) => ({ choice: "against" as const, voter: v })),
                ...abstainedVoters.map((v) => ({ choice: "abstained" as const, voter: v })),
              ];
              if (rows.length === 0) {
                return (
                  <p style={{ padding: "12px 20px", fontSize: "0.875rem", color: "var(--text-muted)" }}>
                    No voter records.
                  </p>
                );
              }
              return (
                <div className="admin-table-wrapper">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Lot #</th>
                        <th>Email</th>
                        <th style={{ textAlign: "right" }}>UOE</th>
                        <th>Submitted By</th>
                        <th>Choice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ choice, voter }) => (
                        <tr key={`${choice}-${voter.lot_number}-${voter.voter_email}`}>
                          <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem" }}>
                            {voter.lot_number ?? "—"}
                          </td>
                          <td style={{ fontSize: "0.875rem" }}>
                            {voter.voter_name
                              ? `${voter.voter_name} <${voter.voter_email ?? ""}>`
                              : (voter.voter_email ?? "—")}
                            {voter.proxy_email && (
                              <span style={{ marginLeft: 6, fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                (proxy)
                              </span>
                            )}
                          </td>
                          <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem", textAlign: "right" }}>
                            {voter.entitlement}
                          </td>
                          <td style={{ fontSize: "0.875rem" }}>
                            {voter.submitted_by_admin ? "Admin" : "Voter"}
                          </td>
                          <td>
                            <span style={{
                              fontSize: "0.7rem",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.07em",
                              padding: "3px 8px",
                              borderRadius: "100px",
                              color: OPTION_CHOICE_COLORS[choice],
                              background: OPTION_CHOICE_BG[choice],
                            }}>
                              {OPTION_CHOICE_LABELS[choice]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </td>
        </tr>
      )}
    </>
  );
}

/** Fix 10: Renders the expanded voter list for a binary motion (Fix 6: tabular layout) */
function BinaryVoterList({ motion }: { motion: MotionDetail }) {
  const categories = ["yes", "no", "abstained", "absent", "not_eligible"] as const;
  const rows: Array<{ cat: typeof categories[number]; voter: MotionDetail["voter_lists"]["yes"][number] }> = [];
  for (const cat of categories) {
    for (const v of motion.voter_lists[cat]) {
      rows.push({ cat, voter: v });
    }
  }
  if (rows.length === 0) {
    return (
      <p style={{ padding: "12px 20px", fontSize: "0.875rem", color: "var(--text-muted)" }}>
        No voter records.
      </p>
    );
  }
  return (
    <div style={{ padding: "0 0 8px 0", borderTop: "1px solid var(--border-subtle)" }}>
      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Lot #</th>
              <th>Email</th>
              <th style={{ textAlign: "right" }}>UOE</th>
              <th>Submitted By</th>
              <th>Choice</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ cat, voter }) => (
              <tr key={`${cat}-${voter.lot_number}-${voter.voter_email}`}>
                <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem" }}>
                  {voter.lot_number ?? "—"}
                </td>
                <td style={{ fontSize: "0.875rem" }}>
                  {voter.voter_name
                    ? `${voter.voter_name} <${voter.voter_email ?? ""}>`
                    : (voter.voter_email ?? "—")}
                  {voter.proxy_email && (
                    <span style={{ marginLeft: 6, fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      (proxy)
                    </span>
                  )}
                </td>
                <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem", textAlign: "right" }}>
                  {voter.entitlement}
                </td>
                <td style={{ fontSize: "0.875rem" }}>
                  {voter.submitted_by_admin ? "Admin" : "Voter"}
                </td>
                <td>
                  <span style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    padding: "3px 8px",
                    borderRadius: "100px",
                    color: CATEGORY_COLORS[cat],
                    background: CHOICE_BG_COLORS[cat],
                  }}>
                    {CATEGORY_LABELS[cat]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AGMReportView({ motions, agmTitle, totalEntitlement = 0 }: AGMReportViewProps) {
  // Fix 10: per-motion expand/collapse state for binary motions
  const [expandedMotionIds, setExpandedMotionIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedMotionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleMotionExportCSV(motion: MotionDetail) {
    function csvCell(value: string): string {
      return `"${value.replace(/"/g, '""')}"`;
    }

    function buildEmailCell(v: { voter_email?: string; voter_name?: string | null; proxy_email?: string | null }): string {
      const displayName = v.voter_name
        ? `${v.voter_name} <${v.voter_email ?? ""}>`
        : (v.voter_email || "");
      return v.proxy_email ? `${displayName} (proxy)` : displayName;
    }

    function buildSubmittedAt(v: { submitted_at?: string | null }): string {
      return v.submitted_at ?? "";
    }

    const motionPrefix = motion.motion_number?.trim() || String(motion.display_order);
    const titleSlug = motion.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 40);
    const filename = `${motionPrefix}-${titleSlug}_results.csv`;

    const rows: string[] = [];

    if (motion.is_multi_choice === true) {
      rows.push("Lot Number,Owner Name,Voter Email,Option,Vote Choice,Entitlement (UOE),Submitted By,Submitted At");

      for (const optTally of motion.tally.options ?? []) {
        const forVoters = motion.voter_lists.options_for?.[optTally.option_id] ?? motion.voter_lists.options?.[optTally.option_id] ?? [];
        const againstVoters = motion.voter_lists.options_against?.[optTally.option_id] ?? [];
        const abstainedVoters = motion.voter_lists.options_abstained?.[optTally.option_id] ?? [];

        for (const v of forVoters) {
          rows.push(`${csvCell(v.lot_number ?? "")},${csvCell(v.voter_name ?? "")},${csvCell(buildEmailCell(v))},${csvCell(optTally.option_text)},${csvCell("For")},${v.entitlement},${csvCell(v.submitted_by_admin ? "Admin" : "Voter")},${csvCell(buildSubmittedAt(v))}`);
        }
        for (const v of againstVoters) {
          rows.push(`${csvCell(v.lot_number ?? "")},${csvCell(v.voter_name ?? "")},${csvCell(buildEmailCell(v))},${csvCell(optTally.option_text)},${csvCell("Against")},${v.entitlement},${csvCell(v.submitted_by_admin ? "Admin" : "Voter")},${csvCell(buildSubmittedAt(v))}`);
        }
        for (const v of abstainedVoters) {
          rows.push(`${csvCell(v.lot_number ?? "")},${csvCell(v.voter_name ?? "")},${csvCell(buildEmailCell(v))},${csvCell(optTally.option_text)},${csvCell("Abstained")},${v.entitlement},${csvCell(v.submitted_by_admin ? "Admin" : "Voter")},${csvCell(buildSubmittedAt(v))}`);
        }
      }

      // Absent and not_eligible rows — Option cell is empty
      for (const cat of ["absent", "not_eligible"] as const) {
        const label = CATEGORY_LABELS[cat];
        for (const v of motion.voter_lists[cat]) {
          rows.push(`${csvCell(v.lot_number ?? "")},${csvCell(v.voter_name ?? "")},${csvCell(buildEmailCell(v))},${""},${csvCell(label)},${v.entitlement},${csvCell(v.submitted_by_admin ? "Admin" : "Voter")},${csvCell(buildSubmittedAt(v))}`);
        }
      }
    } else {
      rows.push("Lot Number,Owner Name,Voter Email,Vote Choice,Entitlement (UOE),Submitted By,Submitted At");

      for (const cat of ["yes", "no", "abstained", "absent", "not_eligible"] as const) {
        const label = CATEGORY_LABELS[cat];
        for (const v of motion.voter_lists[cat]) {
          rows.push(`${csvCell(v.lot_number ?? "")},${csvCell(v.voter_name ?? "")},${csvCell(buildEmailCell(v))},${csvCell(label)},${v.entitlement},${csvCell(v.submitted_by_admin ? "Admin" : "Voter")},${csvCell(buildSubmittedAt(v))}`);
        }
      }
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleExportCSV() {
    // Build "Given Surname <email>" when name is present, plain email otherwise.
    // Appends " (proxy)" suffix when proxy_email is set.
    function buildEmailCell(v: { voter_email?: string; voter_name?: string | null; proxy_email?: string | null }): string {
      const displayName = v.voter_name
        ? `${v.voter_name} <${v.voter_email ?? ""}>`
        : (v.voter_email || "");
      return v.proxy_email ? `${displayName} (proxy)` : displayName;
    }

    const rows: string[] = ["Motion,Category,Lot Number,Entitlement (UOE),Voter Email,Submitted By"];
    for (const motion of motions) {
      const motionLabel = `${motion.motion_number?.trim() || String(motion.display_order)}. ${motion.title.replace(/"/g, '""')}`;
      if (motion.is_multi_choice === true) {
        // Per-option For/Against/Abstained rows for multi-choice
        for (const optTally of (motion.tally.options ?? [])) {
          const forVoters = motion.voter_lists.options_for?.[optTally.option_id] ?? motion.voter_lists.options?.[optTally.option_id] ?? [];
          const againstVoters = motion.voter_lists.options_against?.[optTally.option_id] ?? [];
          const abstainedVoters = motion.voter_lists.options_abstained?.[optTally.option_id] ?? [];
          for (const v of forVoters) {
            const emailCell = buildEmailCell(v);
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","Option: ${optTally.option_text.replace(/"/g, '""')} — For","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
          for (const v of againstVoters) {
            const emailCell = buildEmailCell(v);
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","Option: ${optTally.option_text.replace(/"/g, '""')} — Against","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
          for (const v of abstainedVoters) {
            const emailCell = buildEmailCell(v);
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","Option: ${optTally.option_text.replace(/"/g, '""')} — Abstained","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
        }
        // Abstained / absent / not_eligible rows
        for (const cat of ["abstained", "absent", "not_eligible"] as const) {
          for (const v of motion.voter_lists[cat]) {
            const emailCell = buildEmailCell(v);
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","${CATEGORY_LABELS[cat]}","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
        }
      } else {
        for (const cat of ["yes", "no", "abstained", "absent", "not_eligible"] as const) {
          for (const v of motion.voter_lists[cat]) {
            const emailCell = buildEmailCell(v);
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","${CATEGORY_LABELS[cat]}","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
        }
      }
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = agmTitle ? `${agmTitle.replace(/[^a-z0-9]/gi, "_")}_results.csv` : "general_meeting_results.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (motions.length === 0) {
    return <p className="state-message">No motions recorded.</p>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button type="button" className="btn btn--secondary" onClick={handleExportCSV}>
          ↓ Export voter lists (CSV)
        </button>
      </div>

      {motions.map((motion) => {
        // Fix 4: compute winning rows/options before rendering
        let winningOptionIds: Set<string> | null = null;
        if (motion.is_multi_choice === true) {
          const options = motion.tally.options ?? [];
          const limit = motion.option_limit ?? 1;
          // Sort by descending for_entitlement_sum; top N are winners
          const sorted = [...options].sort(
            (a, b) =>
              (b.for_entitlement_sum ?? b.entitlement_sum ?? 0) -
              (a.for_entitlement_sum ?? a.entitlement_sum ?? 0)
          );
          winningOptionIds = new Set(sorted.slice(0, limit).map((o) => o.option_id));
        }

        // Fix 4: determine binary winner
        const yesSumBinary = motion.tally.yes.entitlement_sum;
        const noSumBinary = motion.tally.no.entitlement_sum;

        const isExpanded = expandedMotionIds.has(motion.id);

        // Determine if there are any voters across all categories for this motion
        const hasNoVoters = (() => {
          const vl = motion.voter_lists;
          const binaryHasVoters =
            vl.yes.length > 0 ||
            vl.no.length > 0 ||
            vl.abstained.length > 0 ||
            vl.absent.length > 0 ||
            vl.not_eligible.length > 0;
          if (motion.is_multi_choice !== true) return !binaryHasVoters;
          const optionsForLen = Object.values(vl.options_for ?? {}).reduce((s, a) => s + a.length, 0);
          const optionsAgainstLen = Object.values(vl.options_against ?? {}).reduce((s, a) => s + a.length, 0);
          const optionsAbstainedLen = Object.values(vl.options_abstained ?? {}).reduce((s, a) => s + a.length, 0);
          const mcHasVoters =
            optionsForLen > 0 ||
            optionsAgainstLen > 0 ||
            optionsAbstainedLen > 0 ||
            vl.absent.length > 0 ||
            vl.not_eligible.length > 0;
          return !mcHasVoters;
        })();

        return (
          <div key={motion.id} className="admin-card" style={{ marginBottom: 16 }}>
            <div className="admin-card__header">
              <h3 className="admin-card__title">
                {motion.motion_number?.trim() || String(motion.display_order)}. {motion.title}
              </h3>
              <span
                className={`motion-type-badge motion-type-badge--${motion.motion_type === "special" ? "special" : "general"}`}
                aria-label={`Motion type: ${motion.motion_type === "special" ? "Special" : "General"}`}
              >
                {motion.motion_type === "special" ? "Special" : "General"}
              </span>
              {motion.is_multi_choice === true && (
                <span className="motion-type-badge motion-type-badge--multi_choice" aria-label="Multi-choice motion">Multi-Choice</span>
              )}
              {!motion.is_visible && (
                <span className="motion-type-badge motion-type-badge--hidden" aria-label="Motion is hidden from voters">
                  Hidden
                </span>
              )}
              {/* Fix 10: per-binary-motion expand/collapse toggle */}
              {motion.is_multi_choice !== true && (
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} voting details for ${motion.title}`}
                  onClick={() => toggleExpanded(motion.id)}
                  style={{
                    marginLeft: "auto",
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    cursor: "pointer",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-sm)",
                    padding: "3px 10px",
                    color: "var(--text-secondary)",
                  }}
                >
                  {isExpanded ? "▲ Hide voting details" : "▶ Show voting details"}
                </button>
              )}
              <button
                type="button"
                className="btn btn--admin"
                onClick={() => handleMotionExportCSV(motion)}
                disabled={hasNoVoters}
                aria-disabled={hasNoVoters}
                aria-label={`Download results CSV for ${motion.title}`}
                style={motion.is_multi_choice !== true ? undefined : { marginLeft: "auto" }}
              >
                ↓ CSV
              </button>
            </div>
            {motion.description && (
              <p style={{ color: "var(--text-muted)", margin: "0 0 14px", fontSize: "0.875rem", padding: "0 20px" }}>
                {motion.description}
              </p>
            )}
            <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Voter Count</th>
                  <th>Entitlement Sum (UOE)</th>
                </tr>
              </thead>
              <tbody>
                {motion.is_multi_choice === true ? (
                  <>
                    {(motion.tally.options ?? []).map((optTally: OptionTallyEntry) => (
                      <MultiChoiceOptionRows
                        key={optTally.option_id}
                        optTally={optTally}
                        motion={motion}
                        totalEntitlement={totalEntitlement}
                        isWinner={winningOptionIds !== null && winningOptionIds.has(optTally.option_id)}
                      />
                    ))}
                    {(["absent", "not_eligible"] as const).map((cat) => (
                      <tr key={cat}>
                        <td>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: CATEGORY_COLORS[cat], flexShrink: 0 }} />
                            {CATEGORY_LABELS[cat]}
                          </span>
                        </td>
                        <td style={{ fontFamily: "'Overpass Mono', monospace" }}>
                          {motion.tally[cat].voter_count}
                        </td>
                        <td style={{ fontFamily: "'Overpass Mono', monospace" }}>
                          {formatEntitlementPct(motion.tally[cat].entitlement_sum, totalEntitlement)}
                        </td>
                      </tr>
                    ))}
                  </>
                ) : (
                  (["yes", "no", "abstained", "absent", "not_eligible"] as const).map((cat) => {
                    // Fix 4: highlight winning binary row
                    const isWinnerYes = cat === "yes" && yesSumBinary > noSumBinary;
                    const isWinnerNo = cat === "no" && noSumBinary > yesSumBinary;
                    const rowStyle =
                      isWinnerYes
                        ? { borderLeft: "4px solid var(--green)", background: "var(--green-bg)" }
                        : isWinnerNo
                        ? { borderLeft: "4px solid var(--red)", background: "var(--red-bg)" }
                        : undefined;

                    return (
                      <tr key={cat} style={rowStyle}>
                        <td>
                          <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 7,
                            fontWeight: cat === "yes" || cat === "no" ? 600 : undefined,
                          }}>
                            <span style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: CATEGORY_COLORS[cat],
                              flexShrink: 0,
                            }} />
                            {CATEGORY_LABELS[cat]}
                          </span>
                        </td>
                        <td style={{ fontFamily: "'Overpass Mono', monospace" }}>
                          {motion.tally[cat].voter_count}
                        </td>
                        <td style={{ fontFamily: "'Overpass Mono', monospace" }}>
                          {formatEntitlementPct(motion.tally[cat].entitlement_sum, totalEntitlement)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            </div>
            {/* Fix 10: voter list for binary motions, expanded on demand */}
            {motion.is_multi_choice !== true && isExpanded && (
              <BinaryVoterList motion={motion} />
            )}
          </div>
        );
      })}
    </div>
  );
}
