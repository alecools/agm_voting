import type { BuildingOut } from "../../api/voter";

interface BuildingDropdownProps {
  buildings: BuildingOut[];
  value: string;
  onChange: (id: string) => void;
  error?: string;
}

export function BuildingDropdown({ buildings, value, onChange, error }: BuildingDropdownProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor="building-select">Select your building</label>
      <select
        id="building-select"
        className="field__select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? "building-select-error" : undefined}
      >
        <option value="">-- Select a building --</option>
        {buildings.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      {error && (
        <span id="building-select-error" className="field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
