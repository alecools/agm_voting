import React, { useRef, useState } from "react";
import { parseMotionsExcel } from "../../utils/parseMotionsExcel";
import type { MotionFormEntry } from "./MotionEditor";

interface MotionExcelUploadProps {
  onMotionsLoaded: (motions: MotionFormEntry[]) => void;
}

export default function MotionExcelUpload({ onMotionsLoaded }: MotionExcelUploadProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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
    <div style={{ marginBottom: 16 }}>
      <a href="/agm_motions_template.xlsx" download>
        Download template
      </a>
      <div style={{ marginTop: 8 }}>
        <label htmlFor="motion-excel-upload">Upload motions (Excel)</label>
        <input
          id="motion-excel-upload"
          type="file"
          accept=".xlsx,.xls"
          ref={fileRef}
          onChange={handleChange}
          disabled={parsing}
          style={{ marginLeft: 8 }}
        />
      </div>
      {parsing && <p>Parsing...</p>}
      {errors.length > 0 && (
        <div role="alert" style={{ color: "#721c24", marginTop: 8 }}>
          <ul>
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
