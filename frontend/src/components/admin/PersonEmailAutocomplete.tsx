import React, { useCallback, useEffect, useRef, useState } from "react";
import { searchPersons } from "../../api/admin";
import type { PersonOut } from "../../api/admin";

interface PersonEmailAutocompleteProps {
  value: string;
  onChange: (email: string) => void;
  onSelect: (person: PersonOut) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

function formatPersonLabel(person: PersonOut): string {
  const name =
    person.given_name || person.surname
      ? `${person.given_name ?? ""} ${person.surname ?? ""}`.trim()
      : null;
  return name ? `${name} <${person.email}>` : person.email;
}

export default function PersonEmailAutocomplete({
  value,
  onChange,
  onSelect,
  onKeyDown: externalOnKeyDown,
  id,
  placeholder,
  disabled,
  "aria-label": ariaLabel,
}: PersonEmailAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<PersonOut[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = id ? `${id}-listbox` : "person-email-listbox";

  // Debounced search
  const triggerSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 1) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchPersons(q);
        setSuggestions(results);
        setActiveIndex(-1);
        setOpen(results.length > 0);
      } catch {
        setSuggestions([]);
        setOpen(false);
      }
    }, 300);
  }, []);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    onChange(v);
    triggerSearch(v);
  }

  function handleSelect(person: PersonOut) {
    onChange(person.email);
    onSelect(person);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      externalOnKeyDown?.(e);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    } else {
      externalOnKeyDown?.(e);
    }
  }

  // Close on outside click
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const activeOptionId =
    activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input
        id={id}
        className="field__input"
        type="email"
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel ? `${ariaLabel} suggestions` : "Person suggestions"}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 100,
            background: "var(--white)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-md)",
            listStyle: "none",
            margin: 0,
            padding: "4px 0",
          }}
        >
          {suggestions.map((person, idx) => (
            <li
              key={person.id}
              id={`${listboxId}-option-${idx}`}
              role="option"
              aria-selected={idx === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(person);
              }}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: "0.875rem",
                background:
                  idx === activeIndex ? "var(--linen)" : "var(--white)",
              }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              {formatPersonLabel(person)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
