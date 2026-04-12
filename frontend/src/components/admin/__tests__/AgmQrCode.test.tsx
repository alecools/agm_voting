import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AgmQrCode from "../AgmQrCode";

// qrcode.react renders a <canvas> element; jsdom doesn't support canvas rendering,
// but we can still assert that the element is present and the library is called
// with the expected props by mocking the module.
vi.mock("qrcode.react", () => ({
  QRCodeCanvas: React.forwardRef<HTMLCanvasElement, {
    value: string;
    size: number;
    imageSettings?: object;
    [key: string]: unknown;
  }>(function QRCodeCanvasMock({ value, size, imageSettings, ...rest }, ref) {
    return (
      <canvas
        ref={ref}
        data-testid="qr-canvas"
        data-value={value}
        data-size={size}
        data-has-image={imageSettings ? "true" : "false"}
        {...rest}
      />
    );
  }),
}));

describe("AgmQrCode", () => {
  it("renders a canvas element", () => {
    render(<AgmQrCode agmId="agm-123" faviconUrl={null} />);
    expect(screen.getByTestId("qr-canvas")).toBeInTheDocument();
  });

  it("encodes the voter URL in the QR value", () => {
    render(<AgmQrCode agmId="agm-abc" faviconUrl={null} />);
    const canvas = screen.getByTestId("qr-canvas");
    expect(canvas).toHaveAttribute("data-value", window.location.origin + "/vote/agm-abc/auth");
  });

  it("uses the provided size", () => {
    render(<AgmQrCode agmId="agm-123" faviconUrl={null} size={120} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-size", "120");
  });

  it("sets imageSettings when faviconUrl is non-empty", () => {
    render(<AgmQrCode agmId="agm-123" faviconUrl="https://example.com/logo.png" size={200} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "true");
  });

  it("does not set imageSettings when faviconUrl is null", () => {
    render(<AgmQrCode agmId="agm-123" faviconUrl={null} size={200} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "false");
  });

  it("does not set imageSettings when faviconUrl is empty string", () => {
    render(<AgmQrCode agmId="agm-123" faviconUrl="" size={200} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "false");
  });

  // --- RR4-24: accessible name on canvas ---

  it("RR4-24: canvas has aria-label for accessible name", () => {
    render(<AgmQrCode agmId="agm-xyz" faviconUrl={null} />);
    const canvas = screen.getByTestId("qr-canvas");
    expect(canvas).toHaveAttribute("aria-label");
    expect(canvas.getAttribute("aria-label")).toMatch(/agm-xyz/i);
  });

  it("RR4-24: renders a figcaption with the meeting ID for screen readers", () => {
    render(<AgmQrCode agmId="agm-xyz" faviconUrl={null} />);
    expect(screen.getByText(/agm-xyz/i)).toBeInTheDocument();
  });

  it("RR4-24: canvas is wrapped in a figure element", () => {
    const { container } = render(<AgmQrCode agmId="agm-fig" faviconUrl={null} />);
    expect(container.querySelector("figure")).toBeInTheDocument();
  });

  // --- RR4-19: null canvas ref error state ---

  it("RR4-19: renders normally when no canvasRef is provided", () => {
    render(<AgmQrCode agmId="agm-no-ref" faviconUrl={null} />);
    expect(screen.getByTestId("qr-canvas")).toBeInTheDocument();
  });

  it("RR4-19: shows error alert when hasError prop is true", () => {
    render(<AgmQrCode agmId="agm-err" faviconUrl={null} hasError={true} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("QR code could not be rendered");
    // Canvas must not be rendered in error state
    expect(screen.queryByTestId("qr-canvas")).not.toBeInTheDocument();
  });

  it("RR4-19: does not show error when hasError is false (default)", () => {
    render(<AgmQrCode agmId="agm-no-err" faviconUrl={null} hasError={false} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("qr-canvas")).toBeInTheDocument();
  });
});
