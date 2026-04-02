import { useEffect, useRef } from "react";
import AgmQrCode from "./AgmQrCode";

interface AgmQrCodeModalProps {
  agmId: string;
  logoUrl: string | null;
  onClose: () => void;
}

export default function AgmQrCodeModal({ agmId, logoUrl, onClose }: AgmQrCodeModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
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
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <AgmQrCode agmId={agmId} logoUrl={logoUrl} size={400} canvasRef={canvasRef} />

        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn--secondary" onClick={handleDownload}>
            Download PNG
          </button>
          <button type="button" className="btn btn--secondary" onClick={handlePrint}>
            Print
          </button>
        </div>
      </div>

      <style>{`
        @media print {
          body > *:not(.qr-modal__print-area) { display: none !important; }
          .qr-modal__print-area { position: static !important; box-shadow: none !important; }
        }
      `}</style>
    </div>
  );
}
