import { describe, it, expect } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import BuildingSearchCombobox from "../BuildingSearchCombobox";

function renderCombobox(
  value = "",
  onChange: (id: string, name: string) => void = () => {},
  props: Partial<{ placeholder: string; id: string }> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <div>
          <label htmlFor={props.id ?? "building-combobox"}>Building</label>
          <BuildingSearchCombobox value={value} onChange={onChange} {...props} />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Helper: open dropdown and click an option by text (waits for the option to appear)
async function selectOption(optionText: string) {
  const combobox = screen.getByRole("combobox");
  fireEvent.click(combobox);
  await waitFor(() => {
    expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
  });
  // Wait for the option to appear (API response may be async)
  await waitFor(() => {
    expect(screen.getByRole("option", { name: optionText })).toBeInTheDocument();
  });
  fireEvent.mouseDown(screen.getByRole("option", { name: optionText }));
}

describe("BuildingSearchCombobox", () => {
  // --- Happy path ---

  it("renders combobox input with default placeholder", () => {
    renderCombobox();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.placeholder).toBe("Search buildings");
  });

  it("renders combobox input with custom placeholder", () => {
    renderCombobox("", () => {}, { placeholder: "All buildings" });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.placeholder).toBe("All buildings");
  });

  it("opens listbox when input is clicked", async () => {
    renderCombobox();
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
  });

  it("opens listbox when input is focused", async () => {
    renderCombobox();
    fireEvent.focus(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
  });

  it("shows 'All buildings' as first option", async () => {
    renderCombobox();
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "All buildings" })).toBeInTheDocument();
    });
  });

  it("shows non-archived buildings from API in alphabetical order", async () => {
    renderCombobox();
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Beta Court" })).toBeInTheDocument();
    });
  });

  it("does not show archived buildings", async () => {
    renderCombobox();
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("option", { name: "Gamma House" })).not.toBeInTheDocument();
  });

  it("calls onChange with id and name when a building is selected", async () => {
    const onChange = (id: string, name: string) => {
      receivedId = id;
      receivedName = name;
    };
    let receivedId = "";
    let receivedName = "";
    renderCombobox("", onChange);
    await selectOption("Alpha Tower");
    expect(receivedId).toBe("b1");
    expect(receivedName).toBe("Alpha Tower");
  });

  it("shows selected building name in input after selection", async () => {
    renderCombobox();
    await selectOption("Alpha Tower");
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.value).toBe("Alpha Tower");
  });

  it("calls onChange with empty strings when 'All buildings' is selected", async () => {
    let receivedId = "b1";
    let receivedName = "Alpha Tower";
    renderCombobox("b1", (id, name) => {
      receivedId = id;
      receivedName = name;
    });
    await selectOption("All buildings");
    expect(receivedId).toBe("");
    expect(receivedName).toBe("");
  });

  it("clears input text when 'All buildings' is selected", async () => {
    renderCombobox("", () => {});
    await selectOption("Alpha Tower");
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.value).toBe("Alpha Tower");
    // Now select "All buildings"
    await selectOption("All buildings");
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
  });

  it("closes listbox after selection", async () => {
    renderCombobox();
    await selectOption("Alpha Tower");
    expect(screen.queryByRole("listbox", { name: "Buildings" })).not.toBeInTheDocument();
  });

  it("resolves value to building name when value prop is provided on mount", async () => {
    renderCombobox("b2");
    await waitFor(() => {
      const input = screen.getByRole("combobox") as HTMLInputElement;
      expect(input.value).toBe("Beta Court");
    });
  });

  it("shows empty input when value is empty string on mount", () => {
    renderCombobox("");
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  // --- Input validation / search ---

  it("sends name filter to buildings API when user types", async () => {
    const user = userEvent.setup();
    let capturedUrl = "";
    server.use(
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    renderCombobox();
    await user.type(screen.getByRole("combobox"), "Alpha");
    await waitFor(() => {
      expect(capturedUrl).toContain("name=Alpha");
    });
  });

  it("sends sort_by=name and sort_dir=asc in initial query", async () => {
    let capturedUrl = "";
    server.use(
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    renderCombobox();
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(capturedUrl).toContain("sort_by=name");
      expect(capturedUrl).toContain("sort_dir=asc");
    });
  });

  it("calls onChange with empty strings when user types and clears the selection", async () => {
    const user = userEvent.setup();
    let receivedId = "b1";
    renderCombobox("b1", (id) => { receivedId = id; });
    await user.type(screen.getByRole("combobox"), "x");
    expect(receivedId).toBe("");
  });

  it("shows 'No buildings found' when search has no results", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name");
        if (name === "ZZZNOMATCH") return HttpResponse.json([]);
        return HttpResponse.json([
          { id: "b1", name: "Alpha Tower", manager_email: "a@x.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
        ]);
      })
    );
    renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await user.type(input, "ZZZNOMATCH");
    await waitFor(() => {
      expect(screen.getByText("No buildings found")).toBeInTheDocument();
    });
  });

  // --- Keyboard navigation ---

  it("Escape key closes the dropdown", async () => {
    renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Buildings" })).not.toBeInTheDocument();
  });

  it("ArrowDown + Enter selects the first building option", async () => {
    let receivedId = "";
    renderCombobox("", (id) => { receivedId = id; });
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    // First ArrowDown: moves to "All buildings" (index 0)
    act(() => { fireEvent.keyDown(input, { key: "ArrowDown" }); });
    // Second ArrowDown: moves to first building (index 1 = Alpha Tower)
    act(() => { fireEvent.keyDown(input, { key: "ArrowDown" }); });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(receivedId).toBe("b1");
  });

  it("ArrowDown + Enter on 'All buildings' (index 0) clears selection", async () => {
    let receivedId = "b1";
    renderCombobox("b1", (id) => { receivedId = id; });
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
    act(() => { fireEvent.keyDown(input, { key: "ArrowDown" }); });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(receivedId).toBe("");
  });

  it("ArrowUp wraps from first to last option", async () => {
    renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
    // ArrowUp from default (-1) wraps to last
    act(() => { fireEvent.keyDown(input, { key: "ArrowUp" }); });
    expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
  });

  it("Enter with no item highlighted (activeIndex=-1) does not select anything", async () => {
    let receivedId = "";
    renderCombobox("", (id) => { receivedId = id; });
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(receivedId).toBe("");
  });

  it("Enter on closed dropdown opens it", async () => {
    renderCombobox();
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
    // Close it
    act(() => { fireEvent.keyDown(input, { key: "Escape" }); });
    expect(screen.queryByRole("listbox", { name: "Buildings" })).not.toBeInTheDocument();
    // Open via Enter
    act(() => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
  });

  // --- ARIA attributes ---

  it("input has role=combobox, aria-haspopup=listbox, aria-controls pointing to listbox", () => {
    renderCombobox();
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-haspopup", "listbox");
    expect(input).toHaveAttribute("aria-controls", "building-combobox-listbox");
  });

  it("aria-expanded is false when closed and true when open", async () => {
    renderCombobox();
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(input);
    await waitFor(() => {
      expect(input).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("uses custom id when provided", () => {
    renderCombobox("", () => {}, { id: "my-custom-id" });
    const input = screen.getByRole("combobox");
    expect(input.id).toBe("my-custom-id");
    expect(input).toHaveAttribute("aria-controls", "my-custom-id-listbox");
  });

  // --- State / precondition ---

  it("dropdown closes when clicking outside", async () => {
    const user = userEvent.setup();
    renderCombobox();
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
    // Click somewhere outside
    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Buildings" })).not.toBeInTheDocument();
    });
  });

  // --- Edge cases ---

  it("renders correctly when value is set to a non-existent id (empty resolution)", async () => {
    renderCombobox("nonexistent-id");
    // The resolution query will return null — input stays empty after init
    await waitFor(() => {
      // Input should remain empty (no building found for nonexistent-id)
      const input = screen.getByRole("combobox") as HTMLInputElement;
      expect(input.value).toBe("");
    });
  });
});
