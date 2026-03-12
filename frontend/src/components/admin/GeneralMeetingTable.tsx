import { useNavigate } from "react-router-dom";
import type { GeneralMeetingListItem } from "../../api/admin";
import StatusBadge from "./StatusBadge";

interface GeneralMeetingTableProps {
  meetings: GeneralMeetingListItem[];
}

export default function GeneralMeetingTable({ meetings }: GeneralMeetingTableProps) {
  const navigate = useNavigate();

  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Building</th>
          <th>Title</th>
          <th>Status</th>
          <th>Meeting At</th>
          <th>Voting Closes At</th>
        </tr>
      </thead>
      <tbody>
        {meetings.map((meeting) => (
          <tr
            key={meeting.id}
            style={{ cursor: "pointer" }}
            onClick={() => navigate(`/admin/general-meetings/${meeting.id}`)}
          >
            <td style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>{meeting.building_name}</td>
            <td style={{ fontWeight: 600 }}>{meeting.title}</td>
            <td><StatusBadge status={meeting.status} /></td>
            <td style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>
              {new Date(meeting.meeting_at).toLocaleString()}
            </td>
            <td style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>
              {new Date(meeting.voting_closes_at).toLocaleString()}
            </td>
          </tr>
        ))}
        {meetings.length === 0 && (
          <tr>
            <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px 14px" }}>
              No General Meetings found.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
