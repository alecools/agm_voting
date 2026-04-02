import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AgmQrCode from "../AgmQrCode";

// qrcode.react renders a <canvas> element; jsdom doesn't support canvas rendering,
// but we can still assert that the element is present and the library is called
// with the expected props by mocking the module.
vi.mock("qrcode.react", () => ({
  QRCodeCanvas: vi.fn(({ value, size, imageSettings, ref: _ref, ...rest }: {
    value: string;
    size: number;
    imageSettings?: object;
    ref?: unknown;
    [key: string]: unknown;
  }) => (
    <canvas
      data-testid="qr-canvas"
      data-value={value}
      data-size={size}
      data-has-image={imageSettings ? "true" : "false"}
      {...rest}
    />
  )),
}));

describe("AgmQrCode", () => {
  it("renders a canvas element", () => {
    render(<AgmQrCode agmId="agm-123" logoUrl={null} />);
    expect(screen.getByTestId("qr-canvas")).toBeInTheDocument();
  });

  it("encodes the voter URL in the QR value", () => {
    render(<AgmQrCode agmId="agm-abc" logoUrl={null} />);
    const canvas = screen.getByTestId("qr-canvas");
    expect(canvas).toHaveAttribute("data-value", window.location.origin + "/vote/agm-abc");
  });

  it("uses the provided size", () => {
    render(<AgmQrCode agmId="agm-123" logoUrl={null} size={120} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-size", "120");
  });

  it("sets imageSettings when logoUrl is non-empty", () => {
    render(<AgmQrCode agmId="agm-123" logoUrl="https://example.com/logo.png" size={200} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "true");
  });

  it("does not set imageSettings when logoUrl is null", () => {
    render(<AgmQrCode agmId="agm-123" logoUrl={null} size={200} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "false");
  });

  it("does not set imageSettings when logoUrl is empty string", () => {
    render(<AgmQrCode agmId="agm-123" logoUrl="" size={200} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "false");
  });
});
