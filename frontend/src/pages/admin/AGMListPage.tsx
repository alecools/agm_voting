import React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listAGMs } from "../../api/admin";
import type { AGMListItem } from "../../api/admin";
import AGMTable from "../../components/admin/AGMTable";

export default function AGMListPage() {
  const navigate = useNavigate();

  const { data: agms = [], isLoading, error } = useQuery<AGMListItem[]>({
    queryKey: ["admin", "agms"],
    queryFn: listAGMs,
  });

  if (isLoading) return <p>Loading AGMs...</p>;
  if (error) return <p style={{ color: "#721c24" }}>Failed to load AGMs.</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>AGMs</h1>
        <button onClick={() => navigate("/admin/agms/new")}>Create AGM</button>
      </div>
      <AGMTable agms={agms} />
    </div>
  );
}
