import React from "react";
import { QRCodeCanvas } from "qrcode.react";

interface AgmQrCodeProps {
  agmId: string;
  logoUrl: string | null;
  size?: number;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}

export default function AgmQrCode({ agmId, logoUrl, size = 200, canvasRef }: AgmQrCodeProps) {
  const voterUrl = window.location.origin + "/vote/" + agmId;

  const imageSettings =
    logoUrl
      ? {
          src: logoUrl,
          height: Math.round(size * 0.2),
          width: Math.round(size * 0.2),
          excavate: true,
        }
      : undefined;

  return (
    <QRCodeCanvas
      value={voterUrl}
      size={size}
      level="H"
      imageSettings={imageSettings}
      ref={canvasRef as React.RefObject<HTMLCanvasElement>}
    />
  );
}
