import { useEffect, useRef } from "react";
import AgmQrCode from "./AgmQrCode";

interface AgmQrCodeModalProps {
  agmId: string;
  faviconUrl: string | null;
  onClose: () => void;
}

export default function AgmQrCodeModal({ agmId, faviconUrl, onClose }: AgmQrCodeModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // RR4-14: move initial focus to close button when modal opens
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // RR4-14: focus trap — cycle Tab/Shift+Tab within the dialog
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleDownload() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `agm-qr-${agmId}.png`;
    link.click();
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="QR Code"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "var(--r-lg)",
          padding: 32,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
          boxShadow: "var(--shadow-lg)",
        }}
        className="qr-modal__print-area"
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
          <h2 style={{ margin: 0, fontSize: "1.125rem" }}>Scan to vote</h2>
          {/* RR4-14: ref on close button so initial focus can be set */}
          <button
            ref={closeButtonRef}
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <AgmQrCode agmId={agmId} faviconUrl={faviconUrl} size={400} canvasRef={canvasRef} />

        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn--secondary" onClick={handleDownload}>
            Download PNG
          </button>
          <button type="button" className="btn btn--secondary" onClick={handlePrint}>
            Print
          </button>
        </div>
      </div>
      {/* RR4-30: print CSS is now in index.css @media print — no inline <style> injection */}
    </div>
  );
}
