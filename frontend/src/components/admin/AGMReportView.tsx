import React, { useState } from "react";
import type { MotionDetail } from "../../api/admin";

interface AGMReportViewProps {
  motions: MotionDetail[];
}

export default function AGMReportView({ motions }: AGMReportViewProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  if (motions.length === 0) {
    return <p>No motions.</p>;
  }

  return (
    <div>
      {motions.map((motion) => (
        <div
          key={motion.id}
          style={{
            marginBottom: 24,
            border: "1px solid #dee2e6",
            borderRadius: 4,
            padding: 16,
          }}
        >
          <h4 style={{ margin: "0 0 4px" }}>
            {motion.order_index + 1}. {motion.title}
          </h4>
          {motion.description && (
            <p style={{ color: "#666", marginBottom: 12 }}>{motion.description}</p>
          )}

          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
            <thead>
              <tr>
                <th style={thStyle}>Category</th>
                <th style={thStyle}>Voter Count</th>
                <th style={thStyle}>Entitlement Sum</th>
              </tr>
            </thead>
            <tbody>
              {(["yes", "no", "abstained", "absent"] as const).map((cat) => (
                <tr key={cat}>
                  <td style={tdStyle} style={{ ...tdStyle, textTransform: "capitalize" }}>
                    {cat}
                  </td>
                  <td style={tdStyle}>{motion.tally[cat].voter_count}</td>
                  <td style={tdStyle}>{motion.tally[cat].entitlement_sum}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <button
            type="button"
            onClick={() => toggleExpand(motion.id)}
            style={{ fontSize: "0.85em", marginBottom: 8 }}
          >
            {expanded[motion.id] ? "Hide voter lists" : "Show voter lists"}
          </button>

          {expanded[motion.id] && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {(["yes", "no", "abstained", "absent"] as const).map((cat) => (
                <div key={cat}>
                  <strong style={{ textTransform: "capitalize" }}>{cat}</strong>
                  {motion.voter_lists[cat].length === 0 ? (
                    <p style={{ color: "#666", fontSize: "0.85em" }}>None</p>
                  ) : (
                    <ul style={{ margin: "4px 0", paddingLeft: 16, fontSize: "0.85em" }}>
                      {motion.voter_lists[cat].map((v) => (
                        <li key={v.voter_email}>
                          {v.voter_email} ({v.entitlement})
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "2px solid #dee2e6",
  background: "#f8f9fa",
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid #dee2e6",
};
