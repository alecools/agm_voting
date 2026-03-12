import React from "react";

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const isOpen = status === "open";
  const isPending = status === "pending";
  const style: React.CSSProperties = {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontWeight: 600,
    fontSize: "0.85em",
    background: isOpen ? "#d4edda" : isPending ? "#fff3cd" : "#f8d7da",
    color: isOpen ? "#155724" : isPending ? "#856404" : "#721c24",
    border: `1px solid ${isOpen ? "#c3e6cb" : isPending ? "#ffeeba" : "#f5c6cb"}`,
  };
  return <span style={style}>{isOpen ? "Open" : isPending ? "Pending" : "Closed"}</span>;
}
