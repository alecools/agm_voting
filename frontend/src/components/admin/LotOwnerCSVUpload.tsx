import React, { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { importLotOwners } from "../../api/admin";
import type { LotOwnerImportResult } from "../../api/admin";

interface LotOwnerCSVUploadProps {
  buildingId: string;
  onSuccess: () => void;
}

export default function LotOwnerCSVUpload({ buildingId, onSuccess }: LotOwnerCSVUploadProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<LotOwnerImportResult | null>(null);

  const mutation = useMutation<LotOwnerImportResult, Error, File>({
    mutationFn: (file: File) => importLotOwners(buildingId, file),
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
      <h3>Import Lot Owners</h3>
      <p style={{ color: "#666", fontSize: "0.9em" }}>
        CSV: <code>lot_number</code>, <code>email</code>, <code>unit_entitlement</code>. Excel (Owners_SBT format): Lot#, UOE2, Email. This replaces all existing lot owners.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,.xlsx,.xls"
        aria-label="Lot owners file"
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
          Import complete: {result.imported} records imported.
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
