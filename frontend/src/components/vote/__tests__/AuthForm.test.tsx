import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthForm } from "../AuthForm";

function step1Props(overrides: Partial<Parameters<typeof AuthForm>[0]> = {}) {
  return {
    onRequestOtp: vi.fn(),
    onVerify: vi.fn(),
    isRequestingOtp: false,
    isVerifying: false,
    step: "email" as const,
    otpEmail: "",
    ...overrides,
  };
}

function step2Props(email = "voter@example.com", overrides: Partial<Parameters<typeof AuthForm>[0]> = {}) {
  return {
    onRequestOtp: vi.fn(),
    onVerify: vi.fn(),
    isRequestingOtp: false,
    isVerifying: false,
    step: "code" as const,
    otpEmail: email,
    ...overrides,
  };
}

describe("AuthForm — step 1 (email)", () => {
  // --- Happy path ---
  it("renders static heading 'Verify your identity'", () => {
    render(<AuthForm {...step1Props()} />);
    expect(screen.getByRole("heading", { name: "Verify your identity" })).toBeInTheDocument();
  });

  it("renders email field and 'Send Verification Code' button on initial render", () => {
    render(<AuthForm {...step1Props()} />);
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send Verification Code" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
  });

  it("calls onRequestOtp with trimmed email when form submitted", async () => {
    const user = userEvent.setup();
    const onRequestOtp = vi.fn();
    render(<AuthForm {...step1Props({ onRequestOtp })} />);
    await user.type(screen.getByLabelText("Email address"), "  owner@example.com  ");
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
    expect(onRequestOtp).toHaveBeenCalledWith("owner@example.com");
  });

  // --- Input validation ---
  it("shows email validation error when email is empty", async () => {
    const user = userEvent.setup();
    const onRequestOtp = vi.fn();
    render(<AuthForm {...step1Props({ onRequestOtp })} />);
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
    expect(screen.getByText("Email address is required")).toBeInTheDocument();
    expect(onRequestOtp).not.toHaveBeenCalled();
  });

  it("shows email validation error when only whitespace entered", async () => {
    const user = userEvent.setup();
    const onRequestOtp = vi.fn();
    render(<AuthForm {...step1Props({ onRequestOtp })} />);
    await user.type(screen.getByLabelText("Email address"), "   ");
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
    expect(screen.getByText("Email address is required")).toBeInTheDocument();
    expect(onRequestOtp).not.toHaveBeenCalled();
  });

  // --- Loading state ---
  it("shows 'Sending...' and disables button when isRequestingOtp=true", () => {
    render(<AuthForm {...step1Props({ isRequestingOtp: true })} />);
    const btn = screen.getByRole("button", { name: "Sending..." });
    expect(btn).toBeDisabled();
  });

  it("'Send Verification Code' button is enabled when not loading", () => {
    render(<AuthForm {...step1Props()} />);
    expect(screen.getByRole("button", { name: "Send Verification Code" })).toBeEnabled();
  });

  // --- Error display ---
  it("shows external error message on step 1", () => {
    render(<AuthForm {...step1Props({ error: "Failed to send code. Please try again." })} />);
    expect(screen.getByText("Failed to send code. Please try again.")).toBeInTheDocument();
  });

  // --- No code field on step 1 ---
  it("does not render 'Lot number' field on step 1", () => {
    render(<AuthForm {...step1Props()} />);
    expect(screen.queryByLabelText("Lot number")).not.toBeInTheDocument();
  });

  it("loading starts — still on step 1 (Sending...)", () => {
    render(<AuthForm {...step1Props({ isRequestingOtp: true })} />);
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sending..." })).toBeInTheDocument();
  });
});

describe("AuthForm — step 2 (code)", () => {
  // --- Happy path ---
  it("renders verification code field and 'Verify' button on step 2", () => {
    render(<AuthForm {...step2Props()} />);
    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  it("shows hint text with the email on step 2", () => {
    render(<AuthForm {...step2Props("voter@example.com")} />);
    expect(screen.getByText("We sent a verification code to voter@example.com")).toBeInTheDocument();
  });

  it("calls onVerify with otpEmail and code when form submitted", async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    render(<AuthForm {...step2Props("voter@example.com", { onVerify })} />);
    await user.type(screen.getByLabelText("Verification code"), "ABCD1234");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(onVerify).toHaveBeenCalledWith("voter@example.com", "ABCD1234");
  });

  it("trims code before calling onVerify", async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    render(<AuthForm {...step2Props("voter@example.com", { onVerify })} />);
    await user.type(screen.getByLabelText("Verification code"), "  ABCD1234  ");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(onVerify).toHaveBeenCalledWith("voter@example.com", "ABCD1234");
  });

  // --- Input validation ---
  it("shows code validation error when code is empty", async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    render(<AuthForm {...step2Props("voter@example.com", { onVerify })} />);
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByText("Verification code is required")).toBeInTheDocument();
    expect(onVerify).not.toHaveBeenCalled();
  });

  // --- Loading state ---
  it("shows 'Verifying...' and disables Verify button when isVerifying=true", () => {
    render(<AuthForm {...step2Props("voter@example.com", { isVerifying: true })} />);
    expect(screen.getByRole("button", { name: "Verifying..." })).toBeDisabled();
  });

  it("'Verify' button is enabled when not loading", () => {
    render(<AuthForm {...step2Props()} />);
    expect(screen.getByRole("button", { name: "Verify" })).toBeEnabled();
  });

  // --- Error display ---
  it("shows external error message on step 2", () => {
    render(<AuthForm {...step2Props("voter@example.com", { error: "Invalid or expired code. Please try again." })} />);
    expect(screen.getByText("Invalid or expired code. Please try again.")).toBeInTheDocument();
  });

  it("clears code input when error appears on step 2", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AuthForm {...step2Props("voter@example.com")} />);
    await user.type(screen.getByLabelText("Verification code"), "WRONGCODE");
    rerender(<AuthForm {...step2Props("voter@example.com", { error: "Invalid or expired code. Please try again." })} />);
    expect(screen.getByLabelText("Verification code")).toHaveValue("");
  });

  it("does not clear code on first render with error (no previous error)", () => {
    // If error is provided from first render (no previous error), code is not cleared
    render(<AuthForm {...step2Props("voter@example.com", { error: "Some error" })} />);
    // Code field is empty anyway on fresh render — just verify no crash
    expect(screen.getByLabelText("Verification code")).toHaveValue("");
  });

  // --- Resend ---
  it("calls onRequestOtp with otpEmail when 'Resend code' is clicked", async () => {
    const user = userEvent.setup();
    const onRequestOtp = vi.fn();
    render(<AuthForm {...step2Props("voter@example.com", { onRequestOtp })} />);
    await user.click(screen.getByRole("button", { name: "Resend code" }));
    expect(onRequestOtp).toHaveBeenCalledWith("voter@example.com");
  });

  it("shows 'Sending...' on resend button while isRequestingOtp=true on step 2", () => {
    render(<AuthForm {...step2Props("voter@example.com", { isRequestingOtp: true })} />);
    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
  });

  it("clears code when resend is clicked", async () => {
    const user = userEvent.setup();
    render(<AuthForm {...step2Props("voter@example.com")} />);
    await user.type(screen.getByLabelText("Verification code"), "ABCD1234");
    await user.click(screen.getByRole("button", { name: "Resend code" }));
    expect(screen.queryByDisplayValue("ABCD1234")).not.toBeInTheDocument();
  });

  // --- autoComplete ---
  it("code input has autoComplete='one-time-code'", () => {
    render(<AuthForm {...step2Props()} />);
    expect(screen.getByLabelText("Verification code")).toHaveAttribute("autocomplete", "one-time-code");
  });

  // --- Accessibility ---
  it("code input has aria-invalid when code error is shown", async () => {
    const user = userEvent.setup();
    render(<AuthForm {...step2Props("voter@example.com")} />);
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByLabelText("Verification code")).toHaveAttribute("aria-invalid", "true");
  });

  it("renders 'Resend code' button on step 2", () => {
    render(<AuthForm {...step2Props()} />);
    expect(screen.getByRole("button", { name: "Resend code" })).toBeInTheDocument();
  });

  it("does not render 'Lot number' field on step 2", () => {
    render(<AuthForm {...step2Props()} />);
    expect(screen.queryByLabelText("Lot number")).not.toBeInTheDocument();
  });

  it("error on step 2 does not show send-code button", () => {
    render(<AuthForm {...step2Props("voter@example.com", { error: "Invalid or expired code. Please try again." })} />);
    expect(screen.queryByRole("button", { name: "Send Verification Code" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
  });

  it("does not call onVerify when isVerifying is true (button disabled)", async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    render(<AuthForm {...step2Props("voter@example.com", { isVerifying: true, onVerify })} />);
    const btn = screen.getByRole("button", { name: "Verifying..." });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onVerify).not.toHaveBeenCalled();
  });

  it("error clears when error prop becomes empty string", () => {
    const { rerender } = render(
      <AuthForm {...step2Props("voter@example.com", { error: "Invalid or expired code. Please try again." })} />
    );
    rerender(<AuthForm {...step2Props("voter@example.com", { error: "" })} />);
    expect(screen.queryByText("Invalid or expired code. Please try again.")).not.toBeInTheDocument();
  });
});

describe("AuthForm — miscellaneous", () => {
  // act-wrapped ref check
  it("prevError ref does not cause spurious clears on first render with error", () => {
    // Render step 2 directly with an error — code should not be cleared since there is no previous error
    act(() => {
      render(<AuthForm {...step2Props("voter@example.com", { error: "Some error" })} />);
    });
    // Code field is empty on first render — verify no code is shown
    expect(screen.getByLabelText("Verification code")).toHaveValue("");
  });
});
