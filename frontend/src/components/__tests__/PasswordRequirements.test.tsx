import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PasswordRequirements, {
  checkPasswordRequirements,
  allRequirementsMet,
} from "../PasswordRequirements";

// --- Helper functions ---

describe("checkPasswordRequirements", () => {
  // --- Happy path ---

  it("returns all true for a password meeting all requirements", () => {
    const reqs = checkPasswordRequirements("MyPass1!");
    expect(reqs.minLength).toBe(true);
    expect(reqs.hasUppercase).toBe(true);
    expect(reqs.hasLowercase).toBe(true);
    expect(reqs.hasDigit).toBe(true);
  });

  // --- Individual requirements ---

  it("minLength is false for a 7-character password", () => {
    expect(checkPasswordRequirements("Abc123!").minLength).toBe(false);
  });

  it("minLength is true for exactly 8 characters", () => {
    expect(checkPasswordRequirements("Abcde12!").minLength).toBe(true);
  });

  it("hasUppercase is false when no uppercase letter", () => {
    expect(checkPasswordRequirements("mypass1!").hasUppercase).toBe(false);
  });

  it("hasUppercase is true when at least one uppercase letter", () => {
    expect(checkPasswordRequirements("Mypass1!").hasUppercase).toBe(true);
  });

  it("hasLowercase is false when no lowercase letter", () => {
    expect(checkPasswordRequirements("MYPASS1!").hasLowercase).toBe(false);
  });

  it("hasLowercase is true when at least one lowercase letter", () => {
    expect(checkPasswordRequirements("MYPASs1!").hasLowercase).toBe(true);
  });

  it("hasDigit is false when no digit", () => {
    expect(checkPasswordRequirements("MyPassAB!").hasDigit).toBe(false);
  });

  it("hasDigit is true when at least one digit", () => {
    expect(checkPasswordRequirements("MyPassA1!").hasDigit).toBe(true);
  });

  // --- Boundary values ---

  it("returns all false for empty string", () => {
    const reqs = checkPasswordRequirements("");
    expect(reqs.minLength).toBe(false);
    expect(reqs.hasUppercase).toBe(false);
    expect(reqs.hasLowercase).toBe(false);
    expect(reqs.hasDigit).toBe(false);
  });

  it("minLength is false for 7 chars, true for 8 chars", () => {
    expect(checkPasswordRequirements("abcdefg").minLength).toBe(false);
    expect(checkPasswordRequirements("abcdefgh").minLength).toBe(true);
  });
});

describe("allRequirementsMet", () => {
  it("returns true when all requirements are met", () => {
    expect(allRequirementsMet({ minLength: true, hasUppercase: true, hasLowercase: true, hasDigit: true })).toBe(true);
  });

  it("returns false when minLength is not met", () => {
    expect(allRequirementsMet({ minLength: false, hasUppercase: true, hasLowercase: true, hasDigit: true })).toBe(false);
  });

  it("returns false when hasUppercase is not met", () => {
    expect(allRequirementsMet({ minLength: true, hasUppercase: false, hasLowercase: true, hasDigit: true })).toBe(false);
  });

  it("returns false when hasLowercase is not met", () => {
    expect(allRequirementsMet({ minLength: true, hasUppercase: true, hasLowercase: false, hasDigit: true })).toBe(false);
  });

  it("returns false when hasDigit is not met", () => {
    expect(allRequirementsMet({ minLength: true, hasUppercase: true, hasLowercase: true, hasDigit: false })).toBe(false);
  });

  it("returns false when all requirements are unmet", () => {
    expect(allRequirementsMet({ minLength: false, hasUppercase: false, hasLowercase: false, hasDigit: false })).toBe(false);
  });
});

// --- PasswordRequirements component ---

describe("PasswordRequirements component", () => {
  // --- Happy path ---

  it("renders all four requirement items", () => {
    render(<PasswordRequirements reqs={{ minLength: false, hasUppercase: false, hasLowercase: false, hasDigit: false }} />);
    expect(screen.getByText("At least 8 characters")).toBeInTheDocument();
    expect(screen.getByText("At least one uppercase letter (A–Z)")).toBeInTheDocument();
    expect(screen.getByText("At least one lowercase letter (a–z)")).toBeInTheDocument();
    expect(screen.getByText("At least one number (0–9)")).toBeInTheDocument();
  });

  it("shows ✗ icons for all unmet requirements", () => {
    render(<PasswordRequirements reqs={{ minLength: false, hasUppercase: false, hasLowercase: false, hasDigit: false }} />);
    const icons = document.querySelectorAll(".password-requirements__icon");
    expect(icons).toHaveLength(4);
    icons.forEach((icon) => expect(icon.textContent).toBe("✗"));
  });

  it("shows ✓ icons for all met requirements", () => {
    render(<PasswordRequirements reqs={{ minLength: true, hasUppercase: true, hasLowercase: true, hasDigit: true }} />);
    const icons = document.querySelectorAll(".password-requirements__icon");
    icons.forEach((icon) => expect(icon.textContent).toBe("✓"));
  });

  // --- Individual requirement states ---

  it("minLength item gets --met class when minLength is true", () => {
    render(<PasswordRequirements reqs={{ minLength: true, hasUppercase: false, hasLowercase: false, hasDigit: false }} />);
    // The first list item should have the met class
    const items = document.querySelectorAll(".password-requirements__item");
    expect(items[0]).toHaveClass("password-requirements__item--met");
    expect(items[1]).not.toHaveClass("password-requirements__item--met");
    expect(items[2]).not.toHaveClass("password-requirements__item--met");
    expect(items[3]).not.toHaveClass("password-requirements__item--met");
  });

  it("hasUppercase item gets --met class when hasUppercase is true", () => {
    render(<PasswordRequirements reqs={{ minLength: false, hasUppercase: true, hasLowercase: false, hasDigit: false }} />);
    const items = document.querySelectorAll(".password-requirements__item");
    expect(items[0]).not.toHaveClass("password-requirements__item--met");
    expect(items[1]).toHaveClass("password-requirements__item--met");
    expect(items[2]).not.toHaveClass("password-requirements__item--met");
    expect(items[3]).not.toHaveClass("password-requirements__item--met");
  });

  it("hasLowercase item gets --met class when hasLowercase is true", () => {
    render(<PasswordRequirements reqs={{ minLength: false, hasUppercase: false, hasLowercase: true, hasDigit: false }} />);
    const items = document.querySelectorAll(".password-requirements__item");
    expect(items[2]).toHaveClass("password-requirements__item--met");
  });

  it("hasDigit item gets --met class when hasDigit is true", () => {
    render(<PasswordRequirements reqs={{ minLength: false, hasUppercase: false, hasLowercase: false, hasDigit: true }} />);
    const items = document.querySelectorAll(".password-requirements__item");
    expect(items[3]).toHaveClass("password-requirements__item--met");
  });

  it("all items have --met class when all requirements are met", () => {
    render(<PasswordRequirements reqs={{ minLength: true, hasUppercase: true, hasLowercase: true, hasDigit: true }} />);
    const items = document.querySelectorAll(".password-requirements__item");
    expect(items).toHaveLength(4);
    items.forEach((item) => expect(item).toHaveClass("password-requirements__item--met"));
  });

  // --- Accessibility ---

  it("has aria-live='polite' for screen reader announcements", () => {
    render(<PasswordRequirements reqs={{ minLength: false, hasUppercase: false, hasLowercase: false, hasDigit: false }} />);
    const list = document.querySelector(".password-requirements");
    expect(list).toHaveAttribute("aria-live", "polite");
  });

  it("has accessible label on the list", () => {
    render(<PasswordRequirements reqs={{ minLength: false, hasUppercase: false, hasLowercase: false, hasDigit: false }} />);
    expect(screen.getByRole("list", { name: "Password requirements" })).toBeInTheDocument();
  });
});
