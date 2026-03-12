import React from "react";
import type { GeneralMeetingOut } from "../../api/voter";

function formatLocalDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

interface GeneralMeetingListItemProps {
  meeting: GeneralMeetingOut;
  onEnterVoting: (meetingId: string) => void;
  onViewSubmission: (meetingId: string) => void;
}

export function GeneralMeetingListItem({ meeting, onEnterVoting, onViewSubmission }: GeneralMeetingListItemProps) {
  return (
    <div className="agm-item" data-testid={`agm-item-${meeting.id}`}>
      <div className="agm-item__header">
        <h3 className="agm-item__title">{meeting.title}</h3>
        <span
          className={`status-badge status-badge--${meeting.status}`}
          data-testid="status-badge"
        >
          {meeting.status === "open" ? "Open" : "Closed"}
        </span>
      </div>
      <div className="agm-item__meta">
        <span>
          <strong>Meeting:</strong>{" "}
          {formatLocalDateTime(meeting.meeting_at)}
        </span>
        <span>
          <strong>Voting closes:</strong>{" "}
          {formatLocalDateTime(meeting.voting_closes_at)}
        </span>
      </div>
      {meeting.status === "open" ? (
        <button className="btn btn--primary" onClick={() => onEnterVoting(meeting.id)}>
          Enter Voting
        </button>
      ) : (
        <button className="btn btn--secondary" onClick={() => onViewSubmission(meeting.id)}>
          View My Submission
        </button>
      )}
    </div>
  );
}
