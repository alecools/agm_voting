import React, { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { importBuildings } from "../../api/admin";
import type { BuildingImportResult } from "../../api/admin";

interface BuildingCSVUploadProps {
  onSuccess: () => void;
}

export default function BuildingCSVUpload({ onSuccess }: BuildingCSVUploadProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<BuildingImportResult | null>(null);

  const mutation = useMutation<BuildingImportResult, Error, File>({
    mutationFn: (file: File) => importBuildings(file),
    onSuccess: (data) => {
      setResult(data);
      if (fileRef.current) fileRef.current.value = "";
      onSuccess();
    },
  });

  function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setResult(null);
    mutation.reset();
    mutation.mutate(file);
  }

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Upload Buildings</h3>
      <p style={{ color: "#666", fontSize: "0.9em" }}>
        CSV or Excel file. Required columns: <code>building_name</code>, <code>manager_email</code>
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,.xlsx,.xls"
        aria-label="Buildings file"
      />
      <button
        onClick={handleUpload}
        disabled={mutation.isPending}
        style={{ marginLeft: 8 }}
      >
        {mutation.isPending ? "Uploading..." : "Upload"}
      </button>

      {result && (
        <p style={{ color: "#155724", marginTop: 8 }}>
          Import complete: {result.created} created, {result.updated} updated.
        </p>
      )}

      {mutation.isError && (
        <p style={{ color: "#721c24", marginTop: 8 }}>
          Error: {mutation.error.message}
        </p>
      )}
    </div>
  );
}
