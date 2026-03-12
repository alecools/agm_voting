import { useState } from "react";

interface ShareSummaryLinkProps {
  meetingId: string;
}

export default function ShareSummaryLink({ meetingId }: ShareSummaryLinkProps) {
  const url = window.location.origin + "/general-meeting/" + meetingId + "/summary";
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(url);
    } catch {
      // clipboard unavailable — still show feedback
    }
    setCopied(true);
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <a href={url} target="_blank" rel="noopener noreferrer" className="share-link__url">
        {url}
      </a>
      <div style={{ position: "relative" }}>
        <button
          type="button"
          className="share-link__btn"
          onClick={handleCopy}
          aria-label="Copy link"
          title="Copy link"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </button>
        {copied && (
          <span
            className="share-link__toast"
            onAnimationEnd={() => setCopied(false)}
          >
            Link copied
          </span>
        )}
      </div>
    </div>
  );
}
