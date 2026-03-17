import React, { useRef, useState } from "react";
import { parseMotionsExcel } from "../../utils/parseMotionsExcel";
import type { MotionFormEntry } from "./MotionEditor";

interface MotionExcelUploadProps {
  onMotionsLoaded: (motions: MotionFormEntry[]) => void;
}

export default function MotionExcelUpload({ onMotionsLoaded }: MotionExcelUploadProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file.name);
    setErrors([]);
    setParsing(true);
    try {
      const result = await parseMotionsExcel(file);
      if ("errors" in result) {
        setErrors(result.errors);
      } else {
        setErrors([]);
        onMotionsLoaded(result.motions);
      }
    } finally {
      setParsing(false);
    }
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <input
          id="motion-excel-upload"
          type="file"
          accept=".csv,text/csv,.xlsx,.xls"
          aria-label="Upload motions (CSV or Excel)"
          ref={fileRef}
          onChange={handleChange}
          disabled={parsing}
          style={{ display: "none" }}
        />
        <button
          type="button"
          className="btn btn--secondary"
          style={{ fontSize: "0.8rem", padding: "7px 18px" }}
          onClick={() => fileRef.current?.click()}
          disabled={parsing}
        >
          {parsing ? "Parsing..." : "Import motions from CSV or Excel"}
        </button>
        {selectedFile && !parsing && (
          <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
            {selectedFile}
          </span>
        )}
        <a
          href="/agm_motions_template.csv"
          download
          style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginLeft: "auto" }}
        >
          Download template
        </a>
      </div>
      {errors.length > 0 && (
        <div role="alert" className="admin-upload__result admin-upload__result--error">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
