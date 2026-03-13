import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { GeneralMeetingListItem } from "../../api/admin";
import StatusBadge from "./StatusBadge";
import Pagination from "./Pagination";

const PAGE_SIZE = 20;

interface GeneralMeetingTableProps {
  meetings: GeneralMeetingListItem[];
  isLoading?: boolean;
}

export default function GeneralMeetingTable({ meetings, isLoading }: GeneralMeetingTableProps) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [meetings.length]);

  const totalPages = Math.max(1, Math.ceil(meetings.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = meetings.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div>
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
          {isLoading && !meetings.length ? (
            <tr>
              <td colSpan={5} className="state-message">Loading General Meetings...</td>
            </tr>
          ) : meetings.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px 14px" }}>
                No General Meetings found.
              </td>
            </tr>
          ) : (
            visible.map((meeting) => (
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
            ))
          )}
        </tbody>
      </table>
      <Pagination
        page={safePage}
        totalPages={totalPages}
        totalItems={meetings.length}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}
