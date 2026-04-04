import { useState } from "react";
import type { MotionDetail, OptionTallyEntry } from "../../api/admin";

function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return null;
  if (outcome === "pass") {
    return (
      <span
        style={{
          marginLeft: 6,
          fontSize: "0.7rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.4px",
          color: "var(--green)",
          background: "var(--green-bg)",
          borderRadius: "var(--r-sm)",
          padding: "2px 6px",
        }}
        aria-label="Outcome: Pass"
      >
        Pass
      </span>
    );
  }
  if (outcome === "fail") {
    return (
      <span
        style={{
          marginLeft: 6,
          fontSize: "0.7rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.4px",
          color: "var(--red)",
          background: "var(--red-bg)",
          borderRadius: "var(--r-sm)",
          padding: "2px 6px",
        }}
        aria-label="Outcome: Fail"
      >
        Fail
      </span>
    );
  }
  // tie
  return (
    <span
      style={{
        marginLeft: 6,
        fontSize: "0.7rem",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.4px",
        color: "var(--amber)",
        background: "var(--amber-bg)",
        borderRadius: "var(--r-sm)",
        padding: "2px 6px",
      }}
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

interface MultiChoiceOptionRowsProps {
  optTally: OptionTallyEntry;
  motion: MotionDetail;
  totalEntitlement: number;
}

function MultiChoiceOptionRows({ optTally, motion, totalEntitlement }: MultiChoiceOptionRowsProps) {
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
      {/* Option header row */}
      <tr>
        <td colSpan={3} style={{ padding: "8px 10px", background: "var(--surface-raised, #f7f7f7)", borderBottom: "1px solid var(--border, #e0e0e0)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 600 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--navy)", flexShrink: 0 }} />
            {optTally.option_text}
            <OutcomeBadge outcome={optTally.outcome} />
          </span>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} breakdown for ${optTally.option_text}`}
            onClick={() => setExpanded((v) => !v)}
            style={{
              marginLeft: 10,
              fontSize: "0.75rem",
              cursor: "pointer",
              background: "none",
              border: "1px solid var(--border, #ccc)",
              borderRadius: "var(--r-sm, 4px)",
              padding: "1px 6px",
              color: "var(--text-muted, #555)",
            }}
          >
            {expanded ? "▲ Collapse" : "▶ Expand"}
          </button>
        </td>
      </tr>
      {/* For/Against/Abstained sub-rows — collapsed by default */}
      {expanded && (
        <>
          <tr>
            <td style={{ paddingLeft: 24, fontSize: "0.85rem", color: "var(--green)", fontWeight: 500 }}>
              For
            </td>
            <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.85rem" }}>
              {forVoterCount}
            </td>
            <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.85rem" }}>
              {formatEntitlementPct(forEntitlementSum, totalEntitlement)}
            </td>
          </tr>
          {forVoters.length > 0 && (
            <tr>
              <td colSpan={3} style={{ paddingLeft: 36, fontSize: "0.8rem", color: "var(--text-muted)" }}>
                {forVoters.map((v) => (
                  <span key={`${v.lot_number}-for`} style={{ display: "block" }}>
                    Lot {v.lot_number} — {v.voter_email}{v.proxy_email ? " (proxy)" : ""} — {v.entitlement} UOE
                  </span>
                ))}
              </td>
            </tr>
          )}
          <tr>
            <td style={{ paddingLeft: 24, fontSize: "0.85rem", color: "var(--red)", fontWeight: 500 }}>
              Against
            </td>
            <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.85rem" }}>
              {againstVoterCount}
            </td>
            <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.85rem" }}>
              {formatEntitlementPct(againstEntitlementSum, totalEntitlement)}
            </td>
          </tr>
          {againstVoters.length > 0 && (
            <tr>
              <td colSpan={3} style={{ paddingLeft: 36, fontSize: "0.8rem", color: "var(--text-muted)" }}>
                {againstVoters.map((v) => (
                  <span key={`${v.lot_number}-against`} style={{ display: "block" }}>
                    Lot {v.lot_number} — {v.voter_email}{v.proxy_email ? " (proxy)" : ""} — {v.entitlement} UOE
                  </span>
                ))}
              </td>
            </tr>
          )}
          <tr>
            <td style={{ paddingLeft: 24, fontSize: "0.85rem", color: "var(--amber, #f57c00)", fontWeight: 500 }}>
              Abstained
            </td>
            <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.85rem" }}>
              {abstainedVoterCount}
            </td>
            <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.85rem" }}>
              {formatEntitlementPct(abstainedEntitlementSum, totalEntitlement)}
            </td>
          </tr>
          {abstainedVoters.length > 0 && (
            <tr>
              <td colSpan={3} style={{ paddingLeft: 36, fontSize: "0.8rem", color: "var(--text-muted)" }}>
                {abstainedVoters.map((v) => (
                  <span key={`${v.lot_number}-abs`} style={{ display: "block" }}>
                    Lot {v.lot_number} — {v.voter_email}{v.proxy_email ? " (proxy)" : ""} — {v.entitlement} UOE
                  </span>
                ))}
              </td>
            </tr>
          )}
        </>
      )}
    </>
  );
}

export default function AGMReportView({ motions, agmTitle, totalEntitlement = 0 }: AGMReportViewProps) {
  function handleExportCSV() {
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
            const emailCell = v.proxy_email
              ? `${v.voter_email || ""} (proxy)`
              : (v.voter_email || "");
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","Option: ${optTally.option_text.replace(/"/g, '""')} — For","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
          for (const v of againstVoters) {
            const emailCell = v.proxy_email
              ? `${v.voter_email || ""} (proxy)`
              : (v.voter_email || "");
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","Option: ${optTally.option_text.replace(/"/g, '""')} — Against","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
          for (const v of abstainedVoters) {
            const emailCell = v.proxy_email
              ? `${v.voter_email || ""} (proxy)`
              : (v.voter_email || "");
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","Option: ${optTally.option_text.replace(/"/g, '""')} — Abstained","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
        }
        // Abstained / absent / not_eligible rows
        for (const cat of ["abstained", "absent", "not_eligible"] as const) {
          for (const v of motion.voter_lists[cat]) {
            const emailCell = v.proxy_email
              ? `${v.voter_email || ""} (proxy)`
              : (v.voter_email || "");
            const submittedBy = v.submitted_by_admin ? "Admin" : "Voter";
            rows.push(`"${motionLabel}","${CATEGORY_LABELS[cat]}","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}","${submittedBy}"`);
          }
        }
      } else {
        for (const cat of ["yes", "no", "abstained", "absent", "not_eligible"] as const) {
          for (const v of motion.voter_lists[cat]) {
            const emailCell = v.proxy_email
              ? `${v.voter_email || ""} (proxy)`
              : (v.voter_email || "");
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

      {motions.map((motion) => (
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
                (["yes", "no", "abstained", "absent", "not_eligible"] as const).map((cat) => (
                  <tr key={cat}>
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
                ))
              )}
            </tbody>
          </table>
          </div>
        </div>
      ))}
    </div>
  );
}
