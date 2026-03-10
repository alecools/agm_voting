import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listBuildings } from "../../api/admin";
import type { Building } from "../../types";
import BuildingTable from "../../components/admin/BuildingTable";
import BuildingCSVUpload from "../../components/admin/BuildingCSVUpload";

export default function BuildingsPage() {
  const queryClient = useQueryClient();

  const { data: buildings = [], isLoading, error } = useQuery<Building[]>({
    queryKey: ["admin", "buildings"],
    queryFn: listBuildings,
  });

  function handleImportSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
  }

  if (isLoading) return <p>Loading buildings...</p>;
  if (error) return <p style={{ color: "#721c24" }}>Failed to load buildings.</p>;

  return (
    <div>
      <h1>Buildings</h1>
      <BuildingTable buildings={buildings} />
      <BuildingCSVUpload onSuccess={handleImportSuccess} />
    </div>
  );
}
