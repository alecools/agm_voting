import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchMyBallot } from "../../api/voter";

const CHOICE_LABELS: Record<string, string> = {
  yes: "Yes",
  no: "No",
  abstained: "Abstained",
};

export function ConfirmationPage() {
  const { agmId } = useParams<{ agmId: string }>();
  const navigate = useNavigate();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["my-ballot", agmId],
    queryFn: () => fetchMyBallot(agmId!),
    enabled: !!agmId,
    retry: false,
  });

  if (isLoading) {
    return <p>Loading your submission...</p>;
  }

  if (isError) {
    const err = error as Error;
    if (err.message.includes("404")) {
      return <p>You did not submit a ballot for this meeting.</p>;
    }
    return <p role="alert">Failed to load your ballot. Please try again.</p>;
  }

  /* c8 ignore next 3 */
  if (!data) {
    return null;
  }

  const sortedVotes = [...data.votes].sort((a, b) => a.order_index - b.order_index);

  return (
    <div>
      <h1>Vote Confirmation</h1>
      <p>
        <strong>Building:</strong> {data.building_name}
      </p>
      <p>
        <strong>AGM:</strong> {data.agm_title}
      </p>
      <p>
        <strong>Voter:</strong> {data.voter_email}
      </p>
      <h2>Your votes</h2>
      <ul>
        {sortedVotes.map((v) => (
          <li key={v.motion_id}>
            <strong>{v.motion_title}:</strong> {CHOICE_LABELS[v.choice] ?? v.choice}
          </li>
        ))}
      </ul>
      <button onClick={() => navigate("/")} style={{ marginTop: 16 }}>
        Back to Home
      </button>
    </div>
  );
}
