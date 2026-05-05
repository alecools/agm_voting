import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import PersonEmailAutocomplete from "../PersonEmailAutocomplete";
import type { PersonOut } from "../../../api/admin";

const BASE = "http://localhost";

const personAlice: PersonOut = {
  id: "p1",
  email: "alice@example.com",
  given_name: "Alice",
  surname: "Smith",
  phone_number: null,
};

const personNoName: PersonOut = {
  id: "p2",
  email: "bob@example.com",
  given_name: null,
  surname: null,
  phone_number: null,
};

/**
 * Render the autocomplete, type a value to trigger the debounced search,
 * and wait for the listbox to appear (or confirm it stays absent).
 */
async function renderAndOpenDropdown(
  suggestions: PersonOut[] = [personAlice],
  inputValue = "ali",
  onChange = vi.fn(),
  onSelect = vi.fn(),
  extraProps: Record<string, unknown> = {}
) {
  server.use(
    http.get(`${BASE}/api/admin/persons/search`, () =>
      HttpResponse.json(suggestions)
    )
  );
  const result = render(
    <PersonEmailAutocomplete
      value=""
      onChange={onChange}
      onSelect={onSelect}
      id="test-input"
      aria-label="Person email"
      {...extraProps}
    />
  );
  const input = result.getByLabelText("Person email");
  // Simulate typing: this fires handleInputChange which calls triggerSearch
  fireEvent.change(input, { target: { value: inputValue } });

  if (suggestions.length > 0) {
    // Wait up to 1s for the dropdown — the 300ms debounce + async fetch
    await waitFor(() => screen.getByRole("listbox"), { timeout: 1000 });
  } else {
    // Give the debounce + fetch time to complete, then assert absence
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ...result, onChange, onSelect };
}

// --- Render ---

describe("PersonEmailAutocomplete - render", () => {
  it("renders an email input with aria-label", () => {
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        aria-label="Person email"
      />
    );
    const input = screen.getByLabelText("Person email");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "email");
  });

  it("renders with provided id", () => {
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        id="my-id"
        aria-label="x"
      />
    );
    expect(document.getElementById("my-id")).toBeInTheDocument();
  });

  it("renders with placeholder", () => {
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        placeholder="Enter email"
        aria-label="x"
      />
    );
    expect(screen.getByPlaceholderText("Enter email")).toBeInTheDocument();
  });

  it("renders disabled when disabled prop is true", () => {
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        disabled
        aria-label="Person email"
      />
    );
    expect(screen.getByLabelText("Person email")).toBeDisabled();
  });

  it("does not show dropdown on initial render", () => {
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        aria-label="x"
      />
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

// --- Dropdown open/close ---

describe("PersonEmailAutocomplete - dropdown", () => {
  it("shows dropdown after debounce with matching suggestions", async () => {
    await renderAndOpenDropdown([personAlice]);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("Alice Smith <alice@example.com>")).toBeInTheDocument();
  });

  it("whitespace-only input does not open dropdown", async () => {
    server.use(
      http.get(`${BASE}/api/admin/persons/search`, () =>
        HttpResponse.json([personAlice])
      )
    );
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        aria-label="x"
      />
    );
    const input = screen.getByLabelText("x");
    fireEvent.change(input, { target: { value: "  " } });
    // Whitespace trims to empty in triggerSearch — no debounce scheduled
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("hides dropdown when search returns empty results", async () => {
    await renderAndOpenDropdown([], "xyz");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });


  it("hides dropdown on search API error", async () => {
    server.use(
      http.get(`${BASE}/api/admin/persons/search`, () =>
        HttpResponse.json({ detail: "error" }, { status: 500 })
      )
    );
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        aria-label="x"
      />
    );
    const input = screen.getByLabelText("x");
    fireEvent.change(input, { target: { value: "err" } });
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("formats option label as 'Name <email>' when name fields are set", async () => {
    await renderAndOpenDropdown([personAlice]);
    expect(screen.getByText("Alice Smith <alice@example.com>")).toBeInTheDocument();
  });

  it("formats option label as email only when given_name and surname are null", async () => {
    await renderAndOpenDropdown([personNoName], "bob");
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("formats option label using surname only when given_name is null but surname is set", async () => {
    // Covers binary-expr branch: given_name is falsy, surname is truthy → name is non-null
    const personSurnameOnly: PersonOut = {
      id: "p3",
      email: "lee@example.com",
      given_name: null,
      surname: "Lee",
      phone_number: null,
    };
    await renderAndOpenDropdown([personSurnameOnly], "lee");
    expect(screen.getByText("Lee <lee@example.com>")).toBeInTheDocument();
  });

  it("sets aria-controls to listbox id when open", async () => {
    await renderAndOpenDropdown([personAlice]);
    const input = screen.getByLabelText("Person email");
    expect(input).toHaveAttribute("aria-controls", "test-input-listbox");
  });

  it("does not set aria-controls when dropdown is closed", () => {
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        id="test-input"
        aria-label="Person email"
      />
    );
    expect(screen.getByLabelText("Person email")).not.toHaveAttribute("aria-controls");
  });
});

// --- Selection ---

describe("PersonEmailAutocomplete - selection", () => {
  it("calls onSelect and onChange with person's email on mousedown", async () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    await renderAndOpenDropdown([personAlice], "ali", onChange, onSelect);

    fireEvent.mouseDown(screen.getByText("Alice Smith <alice@example.com>"));

    expect(onChange).toHaveBeenCalledWith("alice@example.com");
    expect(onSelect).toHaveBeenCalledWith(personAlice);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes dropdown after selection", async () => {
    await renderAndOpenDropdown([personAlice]);
    fireEvent.mouseDown(screen.getByText("Alice Smith <alice@example.com>"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

// --- Keyboard navigation ---

describe("PersonEmailAutocomplete - keyboard navigation", () => {
  it("ArrowDown moves active index to first item", async () => {
    await renderAndOpenDropdown([personAlice, personNoName]);
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });

  it("ArrowDown then ArrowDown moves to second item", async () => {
    await renderAndOpenDropdown([personAlice, personNoName]);
    const input = screen.getByLabelText("Person email");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowDown does not exceed last item", async () => {
    await renderAndOpenDropdown([personAlice]);
    const input = screen.getByLabelText("Person email");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // already at last
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowUp from first item stays at first item", async () => {
    await renderAndOpenDropdown([personAlice, personNoName]);
    const input = screen.getByLabelText("Person email");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // go to index 0
    fireEvent.keyDown(input, { key: "ArrowUp" });   // try to go above 0
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowUp when activeIndex is -1 moves to index 0", async () => {
    await renderAndOpenDropdown([personAlice, personNoName]);
    // No ArrowDown first — activeIndex starts at -1, ArrowUp clamps to max(0,-1+?) = 0
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter selects active option and closes dropdown", async () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    await renderAndOpenDropdown([personAlice], "ali", onChange, onSelect);
    const input = screen.getByLabelText("Person email");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("alice@example.com");
    expect(onSelect).toHaveBeenCalledWith(personAlice);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Enter does nothing when no active option", async () => {
    const onSelect = vi.fn();
    await renderAndOpenDropdown([personAlice], "ali", vi.fn(), onSelect);
    // No ArrowDown — activeIndex = -1
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("Escape closes the dropdown", async () => {
    await renderAndOpenDropdown([personAlice]);
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("aria-activedescendant is set when ArrowDown pressed", async () => {
    await renderAndOpenDropdown([personAlice]);
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "ArrowDown" });
    expect(screen.getByLabelText("Person email")).toHaveAttribute(
      "aria-activedescendant",
      "test-input-listbox-option-0"
    );
  });

  it("aria-activedescendant is absent when activeIndex is -1", async () => {
    await renderAndOpenDropdown([personAlice]);
    expect(screen.getByLabelText("Person email")).not.toHaveAttribute("aria-activedescendant");
  });

  it("onMouseEnter sets active index for hover highlight", async () => {
    await renderAndOpenDropdown([personAlice, personNoName]);
    const options = screen.getAllByRole("option");
    fireEvent.mouseEnter(options[1]);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });
});

// --- External onKeyDown passthrough ---

describe("PersonEmailAutocomplete - external onKeyDown passthrough", () => {
  it("calls externalOnKeyDown when dropdown is closed and Enter is pressed", () => {
    const externalOnKeyDown = vi.fn();
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        onKeyDown={externalOnKeyDown}
        aria-label="Person email"
      />
    );
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "Enter" });
    expect(externalOnKeyDown).toHaveBeenCalled();
  });

  it("calls externalOnKeyDown for unhandled keys when dropdown is open", async () => {
    const externalOnKeyDown = vi.fn();
    await renderAndOpenDropdown([personAlice], "ali", vi.fn(), vi.fn(), {
      onKeyDown: externalOnKeyDown,
    });
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "Tab" });
    expect(externalOnKeyDown).toHaveBeenCalled();
  });

  it("does NOT call externalOnKeyDown for ArrowDown when dropdown is open", async () => {
    const externalOnKeyDown = vi.fn();
    await renderAndOpenDropdown([personAlice], "ali", vi.fn(), vi.fn(), {
      onKeyDown: externalOnKeyDown,
    });
    fireEvent.keyDown(screen.getByLabelText("Person email"), { key: "ArrowDown" });
    expect(externalOnKeyDown).not.toHaveBeenCalled();
  });

  it("does NOT call externalOnKeyDown for Enter+active when dropdown is open", async () => {
    const externalOnKeyDown = vi.fn();
    await renderAndOpenDropdown([personAlice], "ali", vi.fn(), vi.fn(), {
      onKeyDown: externalOnKeyDown,
    });
    const input = screen.getByLabelText("Person email");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(externalOnKeyDown).not.toHaveBeenCalled();
  });
});

// --- Outside click ---

describe("PersonEmailAutocomplete - outside click", () => {
  it("closes dropdown when clicking outside the container", async () => {
    await renderAndOpenDropdown([personAlice]);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not close dropdown when clicking the input (inside container)", async () => {
    await renderAndOpenDropdown([personAlice]);
    fireEvent.mouseDown(screen.getByLabelText("Person email"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});

// --- onChange propagation and debounce ---

describe("PersonEmailAutocomplete - onChange propagation", () => {
  it("calls onChange when fireEvent.change is called on the input", () => {
    const onChange = vi.fn();
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={onChange}
        onSelect={vi.fn()}
        aria-label="Person email"
      />
    );
    fireEvent.change(screen.getByLabelText("Person email"), { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("debounces search — API is called after 300ms, not immediately", async () => {
    let callCount = 0;
    server.use(
      http.get(`${BASE}/api/admin/persons/search`, () => {
        callCount++;
        return HttpResponse.json([personAlice]);
      })
    );
    render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        aria-label="x"
      />
    );
    const input = screen.getByLabelText("x");
    fireEvent.change(input, { target: { value: "al" } });
    // Immediately after change — API should NOT have been called yet
    expect(callCount).toBe(0);
    // Wait for the 300ms debounce + async fetch to complete
    await waitFor(() => expect(callCount).toBe(1), { timeout: 1000 });
  });
});

// --- Listbox aria-label ---

describe("PersonEmailAutocomplete - listbox aria-label", () => {
  it("uses '<aria-label> suggestions' when aria-label is provided", async () => {
    await renderAndOpenDropdown([personAlice], "ali", vi.fn(), vi.fn(), {
      "aria-label": "Person email",
    });
    expect(
      screen.getByRole("listbox", { name: "Person email suggestions" })
    ).toBeInTheDocument();
  });

  it("uses 'Person suggestions' as default when no aria-label provided", async () => {
    server.use(
      http.get(`${BASE}/api/admin/persons/search`, () =>
        HttpResponse.json([personAlice])
      )
    );
    const { container } = render(
      <PersonEmailAutocomplete
        value=""
        onChange={vi.fn()}
        onSelect={vi.fn()}
        id="no-label-input"
      />
    );
    const input = container.querySelector("#no-label-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ali" } });
    await waitFor(
      () => screen.getByRole("listbox", { name: "Person suggestions" }),
      { timeout: 1000 }
    );
    expect(
      screen.getByRole("listbox", { name: "Person suggestions" })
    ).toBeInTheDocument();
  });
});
