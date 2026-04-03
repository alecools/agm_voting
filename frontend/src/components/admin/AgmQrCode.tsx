import React from "react";
import { QRCodeCanvas } from "qrcode.react";

interface AgmQrCodeProps {
  agmId: string;
  logoUrl: string | null;
  size?: number;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** RR4-19: set to true to show a fallback error message instead of the canvas */
  hasError?: boolean;
}

export default function AgmQrCode({ agmId, logoUrl, size = 200, canvasRef, hasError = false }: AgmQrCodeProps) {
  const voterUrl = window.location.origin + "/vote/" + agmId + "/auth";

  const imageSettings =
    logoUrl
      ? {
          src: logoUrl,
          height: Math.round(size * 0.2),
          width: Math.round(size * 0.2),
          excavate: true,
        }
      : undefined;

  // RR4-19: show a user-visible error message when the canvas cannot render
  if (hasError) {
    return (
      <p className="state-message state-message--error" role="alert">
        QR code could not be rendered.
      </p>
    );
  }

  // RR4-19: null-safe ref — fall back to a local ref when none is provided
  const resolvedRef = canvasRef ?? React.createRef<HTMLCanvasElement>();

  return (
    // RR4-24: wrap in figure with figcaption for accessible name
    <figure style={{ margin: 0, display: "inline-block" }}>
      <QRCodeCanvas
        value={voterUrl}
        size={size}
        level="H"
        imageSettings={imageSettings}
        ref={resolvedRef as React.RefObject<HTMLCanvasElement>}
        aria-label={`QR code for meeting ${agmId}`}
      />
      <figcaption className="sr-only">QR code for meeting {agmId}</figcaption>
    </figure>
  );
}
