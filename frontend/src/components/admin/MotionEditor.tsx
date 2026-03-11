import type { MotionType } from "../../types";

export interface MotionFormEntry {
  title: string;
  description: string;
  motion_type: MotionType;
}

interface MotionEditorProps {
  motions: MotionFormEntry[];
  onChange: (motions: MotionFormEntry[]) => void;
}

export default function MotionEditor({ motions, onChange }: MotionEditorProps) {
  function addMotion() {
    onChange([...motions, { title: "", description: "", motion_type: "general" }]);
  }

  function removeMotion(index: number) {
    onChange(motions.filter((_, i) => i !== index));
  }

  function updateMotion(index: number, field: keyof MotionFormEntry, value: string) {
    onChange(motions.map((m, i) => i === index ? { ...m, [field]: value } : m));
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <p className="section-label" style={{ marginBottom: 12 }}>Motions</p>
      {motions.map((motion, index) => (
        <div key={index} className="motion-entry">
          <div className="motion-entry__header">Motion {index + 1}</div>
          <div className="field">
            <label className="field__label" htmlFor={`motion-title-${index}`}>Title</label>
            <input
              id={`motion-title-${index}`}
              className="field__input"
              type="text"
              value={motion.title}
              onChange={(e) => updateMotion(index, "title", e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 8 }}>
            <label className="field__label" htmlFor={`motion-desc-${index}`}>Description</label>
            <textarea
              id={`motion-desc-${index}`}
              className="field__input"
              value={motion.description}
              onChange={(e) => updateMotion(index, "description", e.target.value)}
              rows={3}
              style={{ resize: "vertical" }}
            />
          </div>
          <div className="field" style={{ marginBottom: 8 }}>
            <label className="field__label" htmlFor={`motion-type-${index}`}>Motion Type</label>
            <select
              id={`motion-type-${index}`}
              className="field__select"
              value={motion.motion_type}
              onChange={(e) => updateMotion(index, "motion_type", e.target.value)}
            >
              <option value="general">General</option>
              <option value="special">Special</option>
            </select>
          </div>
          <button
            type="button"
            className="btn btn--danger"
            style={{ fontSize: "0.75rem", padding: "5px 12px", textTransform: "none", letterSpacing: 0 }}
            onClick={() => removeMotion(index)}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn btn--secondary" style={{ marginTop: 4 }} onClick={addMotion}>
        + Add Motion
      </button>
    </div>
  );
}
