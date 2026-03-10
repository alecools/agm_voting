import React, { useState } from "react";

interface ShareSummaryLinkProps {
  agmId: string;
}

export default function ShareSummaryLink({ agmId }: ShareSummaryLinkProps) {
  const url = window.location.origin + "/agm/" + agmId + "/summary";
  const [buttonText, setButtonText] = useState("Copy link");

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(url);
    } catch {
      // clipboard unavailable or failed — fall through to reset below
    }
    setButtonText("Link copied!");
    setTimeout(() => {
      setButtonText("Copy link");
    }, 2000);
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
      <button onClick={handleCopy}>{buttonText}</button>
    </div>
  );
}
