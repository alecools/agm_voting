import type { MotionDetail } from "../../api/admin";

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

export default function AGMReportView({ motions, agmTitle, totalEntitlement = 0 }: AGMReportViewProps) {
  function handleExportCSV() {
    const rows: string[] = ["Motion,Category,Lot Number,Entitlement (UOE)"];
    for (const motion of motions) {
      const motionLabel = `${motion.order_index + 1}. ${motion.title.replace(/"/g, '""')}`;
      for (const cat of ["yes", "no", "abstained", "absent", "not_eligible"] as const) {
        for (const v of motion.voter_lists[cat]) {
          rows.push(`"${motionLabel}","${CATEGORY_LABELS[cat]}","${v.lot_number}",${v.entitlement}`);
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
              {motion.order_index + 1}. {motion.title}
            </h3>
            <span
              className={`motion-type-badge${motion.motion_type === "special" ? " motion-type-badge--special" : " motion-type-badge--general"}`}
              aria-label={`Motion type: ${motion.motion_type === "special" ? "Special" : "General"}`}
            >
              {motion.motion_type === "special" ? "Special" : "General"}
            </span>
          </div>
          {motion.description && (
            <p style={{ color: "var(--text-muted)", margin: "0 0 14px", fontSize: "0.875rem" }}>
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
              {(["yes", "no", "abstained", "absent", "not_eligible"] as const).map((cat) => (
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
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ))}
    </div>
  );
}
