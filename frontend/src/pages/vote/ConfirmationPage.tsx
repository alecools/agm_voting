import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchMyBallot } from "../../api/voter";
import type { BallotVoteItem } from "../../api/voter";
import { useBranding } from "../../context/BrandingContext";

const CHOICE_LABELS: Record<string, string> = {
  yes: "For",
  no: "Against",
  abstained: "Abstained",
  not_eligible: "Not eligible",
  selected: "Selected",
};

const OPTION_CHOICE_LABELS: Record<string, string> = {
  for: "For",
  against: "Against",
  abstained: "Abstained",
};

function renderChoiceLabel(vote: BallotVoteItem): string {
  if (vote.is_multi_choice) {
    if (vote.choice === "not_eligible") return "Not eligible";
    // Use option_choices if present (Slice 3 format)
    if (vote.option_choices && vote.option_choices.length > 0) {
      return vote.option_choices
        .map((oc) => `${oc.option_text}: ${OPTION_CHOICE_LABELS[oc.choice] ?? oc.choice}`)
        .join(", ");
    }
    // Fallback to selected_options (backward compat for legacy abstain rows)
    if (vote.choice === "abstained" || !vote.selected_options || vote.selected_options.length === 0) return "Abstained";
    return vote.selected_options.map((o) => o.text).join(", ");
  }
  return CHOICE_LABELS[vote.choice] ?? vote.choice;
}

export function ConfirmationPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const { config } = useBranding();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["my-ballot", meetingId],
    queryFn: () => fetchMyBallot(meetingId!),
    enabled: !!meetingId,
    retry: false,
  });

  if (isLoading) {
    return (
      <main className="voter-content">
        <p className="state-message">Loading your submission...</p>
      </main>
    );
  }

  if (isError) {
    const err = error as Error;
    if (err.message.includes("404")) {
      return (
        <main className="voter-content">
          <p className="state-message">You did not submit a ballot for this meeting.</p>
        </main>
      );
    }
    return (
      <main className="voter-content">
        <p className="state-message state-message--error" role="alert">
          Failed to load your ballot. Please try again.
        </p>
      </main>
    );
  }

  /* c8 ignore next 3 */
  if (!data) {
    return null;
  }

  // Collect all votes across submitted lots, deduplicated by motion_id (first lot wins)
  const allVotes: (BallotVoteItem & { lot_number: string })[] = [];
  for (const lot of data.submitted_lots) {
    for (const v of lot.votes) {
      if (!allVotes.find((x) => x.motion_id === v.motion_id && x.lot_number === lot.lot_number)) {
        allVotes.push({ ...v, lot_number: lot.lot_number });
      }
    }
  }
  const sortedVotes = [...allVotes].sort((a, b) => a.display_order - b.display_order);
  const isMultiLot = data.submitted_lots.length > 1;

  function renderSubmitterInfo(lot: { submitter_email: string; proxy_email?: string | null }) {
    if (lot.proxy_email) {
      return (
        <p className="vote-meta__submitter">
          Submitted via proxy by {lot.proxy_email}
        </p>
      );
    }
    return (
      <p className="vote-meta__submitter">
        This ballot was submitted by {lot.submitter_email}
      </p>
    );
  }

  return (
    <main className="voter-content">
      <div className="card">
        <div className="confirmation">
          <div className="confirmation__check" aria-hidden="true">✓</div>
          <h1 className="confirmation__title">Ballot submitted</h1>
          <p className="confirmation__subtitle">
            Your votes have been recorded. Thank you for participating.
          </p>
        </div>

        <div className="vote-meta">
          <div className="vote-meta__row">
            <span className="vote-meta__label">Building</span>
            <span className="vote-meta__value">{data.building_name}</span>
          </div>
          <div className="vote-meta__row">
            <span className="vote-meta__label">Meeting</span>
            <span className="vote-meta__value">{data.meeting_title}</span>
          </div>
          <div className="vote-meta__row">
            <span className="vote-meta__label">Voter</span>
            <span className="vote-meta__value">{data.voter_email}</span>
          </div>
        </div>

        <div className="vote-summary">
          <p className="vote-summary__heading">Your votes</p>
          {isMultiLot
            ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {data.submitted_lots.map((lot) => (
                  <li key={lot.lot_owner_id} style={{ marginBottom: "12px" }}>
                    <p style={{ fontWeight: 600, marginBottom: "4px" }}>Lot {lot.lot_number}</p>
                    {renderSubmitterInfo(lot)}
                    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                      {[...lot.votes].sort((a, b) => a.display_order - b.display_order).map((v) => (
                        <li className="vote-item" key={v.motion_id}>
                          <span className="vote-item__motion">Motion {v.motion_number?.trim() || v.display_order}. {v.motion_title}</span>
                          <span className={`vote-item__choice vote-item__choice--${v.choice}`}>
                            {renderChoiceLabel(v)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )
            : (
              <>
                {data.submitted_lots.length === 1 && renderSubmitterInfo(data.submitted_lots[0])}
                {/* RR4-37: wrap <li> elements in a <ul> to ensure valid semantic HTML */}
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {sortedVotes.map((v) => (
                    <li className="vote-item" key={v.motion_id}>
                      <span className="vote-item__motion">Motion {v.motion_number?.trim() || v.display_order}. {v.motion_title}</span>
                      <span className={`vote-item__choice vote-item__choice--${v.choice}`}>
                        {renderChoiceLabel(v)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )
          }
        </div>

        <div className="submit-section" style={{ borderTop: "none", marginTop: "24px", paddingTop: "0" }}>
          <button
            className="btn btn--secondary"
            onClick={() => {
              if (data.remaining_lot_owner_ids.length > 0) {
                sessionStorage.setItem(
                  `meeting_lots_${meetingId}`,
                  JSON.stringify(data.remaining_lot_owner_ids)
                );
              }
              navigate(`/vote/${meetingId}/voting`);
            }}
          >
            {data.remaining_lot_owner_ids.length > 0 ? "Vote for remaining lots" : "View my votes"}
          </button>
          <button className="btn btn--ghost" onClick={() => navigate("/")}>
            ← Back to home
          </button>
        </div>
        {config.support_email && (
          <p className="support-contact">
            Need help? Contact{" "}
            <a href={`mailto:${config.support_email}`}>{config.support_email}</a>
          </p>
        )}
      </div>
    </main>
  );
}
