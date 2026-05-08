/**
 * SubmitSection — extracted from VotingPage (US-CQM-03).
 *
 * Renders the submit ballot button or "all voted" state at the bottom of the
 * voting form. Fully controlled: all state and callbacks live in VotingPage.
 *
 * RR3-39: submit button uses aria-disabled when disabled so screen readers
 * announce the state even when the button is visually greyed out.
 */

interface SubmitSectionProps {
  unvotedCount: number;
  isClosed: boolean;
  showSidebar: boolean;
  allSubmitted: boolean;
  isPending: boolean;
  onSubmitClick: () => void;
  onViewSubmission: () => void;
}

export function SubmitSection({
  unvotedCount,
  isClosed,
  showSidebar,
  allSubmitted,
  isPending,
  onSubmitClick,
  onViewSubmission,
}: SubmitSectionProps) {
  if (isClosed) return null;

  // All motions already submitted to the server — show view-only state.
  if (unvotedCount === 0 && !showSidebar && allSubmitted) {
    return (
      <div className="submit-section">
        <p className="state-message" data-testid="all-voted-message">
          You have voted on all motions.
        </p>
        <button type="button" className="btn btn--primary" onClick={onViewSubmission}>
          View Submission
        </button>
      </div>
    );
  }

  // Pending submission: single-lot voter, ballot not yet submitted.
  // Show Submit ballot whether or not all interactive motions are answered.
  if (!showSidebar && !allSubmitted) {
    return (
      <div className="submit-section">
        {/* RR3-39: aria-disabled announces disabled state to screen readers even when
            the button is not HTML-disabled (i.e. still accepts keyboard focus). */}
        <button
          type="button"
          className="btn btn--primary"
          onClick={onSubmitClick}
          disabled={isPending}
          aria-disabled={isPending ? "true" : undefined}
        >
          {isPending ? "Submitting…" : "Submit ballot"}
        </button>
      </div>
    );
  }

  if (unvotedCount > 0) {
    return (
      <div className="submit-section">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onSubmitClick}
          disabled={isPending}
          aria-disabled={isPending ? "true" : undefined}
        >
          {isPending ? "Submitting…" : "Submit ballot"}
        </button>
      </div>
    );
  }

  return null;
}
