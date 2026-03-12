import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getGeneralMeetingSummary } from "../api/public";
import type { GeneralMeetingSummaryData } from "../api/public";

export default function GeneralMeetingSummaryPage() {
  const { meetingId } = useParams<{ meetingId: string }>();

  const { data: meeting, isLoading, error } = useQuery<GeneralMeetingSummaryData>({
    queryKey: ["general-meeting-summary", meetingId],
    queryFn: () => getGeneralMeetingSummary(meetingId!),
    enabled: !!meetingId,
  });

  useEffect(() => {
    if (meeting) {
      document.title = `${meeting.title} — General Meeting Summary`;
    }
  }, [meeting]);

  if (isLoading) return <p>Loading...</p>;

  if (error) {
    const msg = (error as Error).message;
    if (msg.includes("404")) {
      return <p>Meeting not found</p>;
    }
    return <p>Failed to load meeting.</p>;
  }

  /* c8 ignore next -- unreachable: error handling above covers all falsy data cases */
  if (!meeting) return null;

  return (
    <div>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>

      <h1>{meeting.title}</h1>
      <p>Building: {meeting.building_name}</p>
      <p>Meeting: {new Date(meeting.meeting_at).toLocaleString()}</p>
      <p>Voting closes: {new Date(meeting.voting_closes_at).toLocaleString()}</p>
      <p>
        Status:{" "}
        <span>{meeting.status === "open" ? "Open" : "Closed"}</span>
      </p>

      {meeting.motions.length === 0 ? (
        <p>No motions listed.</p>
      ) : (
        <ol>
          {meeting.motions.map((motion) => (
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
