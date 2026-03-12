import type { GeneralMeetingOut } from "../../api/voter";
import { GeneralMeetingListItem } from "./GeneralMeetingListItem";

interface GeneralMeetingListProps {
  meetings: GeneralMeetingOut[];
  onEnterVoting: (meetingId: string) => void;
  onViewSubmission: (meetingId: string) => void;
}

export function GeneralMeetingList({ meetings, onEnterVoting, onViewSubmission }: GeneralMeetingListProps) {
  if (meetings.length === 0) {
    return (
      <p className="state-message" style={{ padding: "24px 0 8px" }}>
        No General Meetings found for this building.
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {meetings.map((meeting) => (
        <li key={meeting.id}>
          <GeneralMeetingListItem
            meeting={meeting}
            onEnterVoting={onEnterVoting}
            onViewSubmission={onViewSubmission}
          />
        </li>
      ))}
    </ul>
  );
}
