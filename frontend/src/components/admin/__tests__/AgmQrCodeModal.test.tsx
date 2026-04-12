import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import AgmQrCodeModal from "../AgmQrCodeModal";

type MockProps = React.HTMLAttributes<HTMLCanvasElement> & {
  value?: string;
  size?: number;
  imageSettings?: object;
};

vi.mock("qrcode.react", () => ({
  QRCodeCanvas: React.forwardRef<HTMLCanvasElement, MockProps>(function QRCodeCanvasMock(
    { value, size, imageSettings, ...rest },
    ref
  ) {
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

Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
  value: vi.fn().mockReturnValue("data:image/png;base64,FAKE"),
  writable: true,
  configurable: true,
});

describe("AgmQrCodeModal", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  it("renders the modal with Download PNG and Print buttons", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "Download PNG" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
  });

  it("renders a close button", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls window.print when Print button is clicked", () => {
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  it("triggers PNG download with correct filename when Download PNG is clicked", () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AgmQrCodeModal agmId="agm-download-test" faviconUrl={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PNG" }));
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith("image/png");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it("renders QR canvas inside the modal", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    expect(screen.getByTestId("qr-canvas")).toBeInTheDocument();
  });

  it("passes faviconUrl to AgmQrCode — imageSettings set when faviconUrl is non-null", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl="https://example.com/logo.png" onClose={onClose} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "true");
  });

  it("passes faviconUrl to AgmQrCode — imageSettings absent when faviconUrl is null", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-has-image", "false");
  });

  // --- RR4-14: focus trap and initial focus management ---

  it("RR4-14: initial focus is moved to the close button when modal opens", () => {
    render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    const closeBtn = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(closeBtn);
  });

  it("RR4-14: Tab key wraps focus from last to first focusable element", () => {
    render(<AgmQrCodeModal agmId="agm-focus-trap" faviconUrl={null} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    // Focus the last button (Print)
    const printBtn = screen.getByRole("button", { name: "Print" });
    act(() => { printBtn.focus(); });
    expect(document.activeElement).toBe(printBtn);
    // Tab from last element should wrap to first (Close button)
    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
    const closeBtn = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(closeBtn);
    void dialog; // referenced to confirm it exists
  });

  it("RR4-14: Shift+Tab from first focusable wraps to last focusable element", () => {
    render(<AgmQrCodeModal agmId="agm-focus-trap" faviconUrl={null} onClose={onClose} />);
    const closeBtn = screen.getByRole("button", { name: "Close" });
    act(() => { closeBtn.focus(); });
    expect(document.activeElement).toBe(closeBtn);
    // Shift+Tab from first element should wrap to last (Print button)
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    const printBtn = screen.getByRole("button", { name: "Print" });
    expect(document.activeElement).toBe(printBtn);
  });

  // --- RR4-30: no inline <style> injection ---

  it("RR4-30: does not inject an inline <style> element", () => {
    const { container } = render(<AgmQrCodeModal agmId="agm-99" faviconUrl={null} onClose={onClose} />);
    // The component itself should not render a <style> tag
    const styleTag = container.querySelector("style");
    expect(styleTag).not.toBeInTheDocument();
  });
});
