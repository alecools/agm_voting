import React from "react";

export interface MotionFormEntry {
  title: string;
  description: string;
}

interface MotionEditorProps {
  motions: MotionFormEntry[];
  onChange: (motions: MotionFormEntry[]) => void;
}

export default function MotionEditor({ motions, onChange }: MotionEditorProps) {
  function addMotion() {
    onChange([...motions, { title: "", description: "" }]);
  }

  function removeMotion(index: number) {
    onChange(motions.filter((_, i) => i !== index));
  }

  function updateMotion(index: number, field: keyof MotionFormEntry, value: string) {
    const updated = motions.map((m, i) =>
      i === index ? { ...m, [field]: value } : m
    );
    onChange(updated);
  }

  return (
    <div>
      <h4>Motions</h4>
      {motions.map((motion, index) => (
        <div
          key={index}
          style={{
            border: "1px solid #dee2e6",
            borderRadius: 4,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={fieldStyle}>
            <label htmlFor={`motion-title-${index}`}>
              Motion {index + 1} Title
            </label>
            <input
              id={`motion-title-${index}`}
              type="text"
              value={motion.title}
              onChange={(e) => updateMotion(index, "title", e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={fieldStyle}>
            <label htmlFor={`motion-desc-${index}`}>
              Motion {index + 1} Description
            </label>
            <textarea
              id={`motion-desc-${index}`}
              value={motion.description}
              onChange={(e) => updateMotion(index, "description", e.target.value)}
              rows={3}
              style={inputStyle}
            />
          </div>
          <button
            type="button"
            onClick={() => removeMotion(index)}
            style={{ color: "#721c24" }}
          >
            Remove Motion
          </button>
        </div>
      ))}
      <button type="button" onClick={addMotion}>
        Add Motion
      </button>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #ced4da",
  borderRadius: 4,
  marginTop: 4,
};
