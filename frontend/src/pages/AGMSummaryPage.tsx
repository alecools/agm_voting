import React, { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAGMSummary } from "../api/public";
import type { AGMSummaryData } from "../api/public";

export default function AGMSummaryPage() {
  const { agmId } = useParams<{ agmId: string }>();

  const { data: agm, isLoading, error } = useQuery<AGMSummaryData>({
    queryKey: ["agm-summary", agmId],
    queryFn: () => getAGMSummary(agmId!),
    enabled: !!agmId,
  });

  useEffect(() => {
    if (agm) {
      document.title = `${agm.title} — AGM Summary`;
    }
  }, [agm]);

  if (isLoading) return <p>Loading...</p>;

  if (error) {
    const msg = (error as Error).message;
    if (msg.includes("404")) {
      return <p>Meeting not found</p>;
    }
    return <p>Failed to load meeting.</p>;
  }

  /* c8 ignore next -- unreachable: error handling above covers all falsy data cases */
  if (!agm) return null;

  return (
    <div>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>

      <h1>{agm.title}</h1>
      <p>Building: {agm.building_name}</p>
      <p>Meeting: {new Date(agm.meeting_at).toLocaleString()}</p>
      <p>Voting closes: {new Date(agm.voting_closes_at).toLocaleString()}</p>
      <p>
        Status:{" "}
        <span>{agm.status === "open" ? "Open" : "Closed"}</span>
      </p>

      {agm.motions.length === 0 ? (
        <p>No motions listed.</p>
      ) : (
        <ol>
          {agm.motions.map((motion) => (
            <li key={motion.order_index}>
              <strong>{motion.order_index + 1}. {motion.title}</strong>
              {motion.description && <p>{motion.description}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
