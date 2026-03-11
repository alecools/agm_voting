import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import CreateAGMForm from "../CreateAGMForm";

vi.mock("../../../utils/parseMotionsExcel");
import { parseMotionsExcel } from "../../../utils/parseMotionsExcel";
const mockParse = vi.mocked(parseMotionsExcel);

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CreateAGMForm />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  // Wait for buildings to load
  await waitFor(() => {
    expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
  });
  await user.selectOptions(screen.getByLabelText("Building"), "b1");
  await user.type(screen.getByLabelText("Title", { selector: "#agm-title" }), "Test AGM");
  await user.type(screen.getByLabelText("Meeting Date / Time"), "2025-06-01T10:00");
  await user.type(screen.getByLabelText("Voting Closes At"), "2025-06-01T12:00");
}

describe("CreateAGMForm", () => {
  it("renders all form fields", async () => {
    renderComponent();
    expect(screen.getByLabelText("Building")).toBeInTheDocument();
    expect(screen.getByLabelText("Title", { selector: "#agm-title" })).toBeInTheDocument();
    expect(screen.getByLabelText("Meeting Date / Time")).toBeInTheDocument();
    expect(screen.getByLabelText("Voting Closes At")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create AGM" })).toBeInTheDocument();
  });

  it("loads buildings into dropdown", async () => {
    renderComponent();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Beta Court" })).toBeInTheDocument();
    });
  });

  it("shows error when building not selected", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.type(screen.getByLabelText("Title", { selector: "#agm-title" }), "Test AGM");
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(screen.getByText("Please select a building.")).toBeInTheDocument();
  });

  it("shows error when title is empty", async () => {
    const user = userEvent.setup();
    renderComponent();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Building"), "b1");
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(screen.getByText("Title is required.")).toBeInTheDocument();
  });

  it("shows error when meeting time is empty", async () => {
    const user = userEvent.setup();
    renderComponent();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Building"), "b1");
    await user.type(screen.getByLabelText("Title", { selector: "#agm-title" }), "Test AGM");
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(screen.getByText("Meeting date/time is required.")).toBeInTheDocument();
  });

  it("shows error when voting close time is empty", async () => {
    const user = userEvent.setup();
    renderComponent();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Building"), "b1");
    await user.type(screen.getByLabelText("Title", { selector: "#agm-title" }), "Test AGM");
    await user.type(screen.getByLabelText("Meeting Date / Time"), "2025-06-01T10:00");
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(screen.getByText("Voting close date/time is required.")).toBeInTheDocument();
  });

  it("shows error when voting close is before meeting time", async () => {
    const user = userEvent.setup();
    renderComponent();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Building"), "b1");
    await user.type(screen.getByLabelText("Title", { selector: "#agm-title" }), "Test AGM");
    await user.type(screen.getByLabelText("Meeting Date / Time"), "2025-06-01T12:00");
    await user.type(screen.getByLabelText("Voting Closes At"), "2025-06-01T10:00");
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(screen.getByText("Voting close time must be after meeting time.")).toBeInTheDocument();
  });

  it("shows error when no motions are present", async () => {
    const user = userEvent.setup();
    renderComponent();
    await fillAndSubmit(user);
    // Remove the default motion
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(screen.getByText("At least one motion is required.")).toBeInTheDocument();
  });

  it("shows error when motion title is empty", async () => {
    const user = userEvent.setup();
    renderComponent();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Building"), "b1");
    await user.type(screen.getByLabelText("Title", { selector: "#agm-title" }), "Test AGM");
    await user.type(screen.getByLabelText("Meeting Date / Time"), "2025-06-01T10:00");
    await user.type(screen.getByLabelText("Voting Closes At"), "2025-06-01T12:00");
    // Default motion has empty title — don't fill it
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(screen.getByText("Motion 1 title is required.")).toBeInTheDocument();
  });

  it("submits form and navigates to AGM detail on success", async () => {
    const user = userEvent.setup();
    renderComponent();
    await fillAndSubmit(user);
    await user.type(screen.getByLabelText("Title", { selector: "#motion-title-0" }), "First Motion");
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/agms/agm-new");
    });
  });

  it("renders the Download template link in the form", () => {
    renderComponent();
    const link = screen.getByRole("link", { name: "Download template" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/agm_motions_template.xlsx");
  });

  it("renders the Upload motions (Excel) input in the form", () => {
    renderComponent();
    expect(screen.getByLabelText("Upload motions (Excel)")).toBeInTheDocument();
  });

  it("pre-populates motions after successful Excel parse", async () => {
    const motions = [
      { title: "Imported Motion 1", description: "" },
      { title: "Imported Motion 2", description: "" },
    ];
    mockParse.mockResolvedValue({ motions });

    const user = userEvent.setup();
    renderComponent();

    const file = new File([""], "motions.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await user.upload(screen.getByLabelText("Upload motions (Excel)"), file);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Imported Motion 1")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Imported Motion 2")).toBeInTheDocument();
    });
  });

  it("shows 409 conflict error from server", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/agms", () => {
        return HttpResponse.json(
          { detail: "An open AGM already exists for this building" },
          { status: 409 }
        );
      })
    );
    const user = userEvent.setup();
    renderComponent();
    await fillAndSubmit(user);
    await user.type(screen.getByLabelText("Title", { selector: "#motion-title-0" }), "First Motion");
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });
});
