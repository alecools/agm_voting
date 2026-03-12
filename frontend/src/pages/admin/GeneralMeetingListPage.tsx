import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listGeneralMeetings } from "../../api/admin";
import type { GeneralMeetingListItem } from "../../api/admin";
import GeneralMeetingTable from "../../components/admin/GeneralMeetingTable";

export default function GeneralMeetingListPage() {
  const navigate = useNavigate();

  const { data: meetings = [], isLoading, error } = useQuery<GeneralMeetingListItem[]>({
    queryKey: ["admin", "general-meetings"],
    queryFn: listGeneralMeetings,
  });

  if (isLoading) return <p className="state-message">Loading General Meetings...</p>;
  if (error) return <p className="state-message state-message--error">Failed to load General Meetings.</p>;

  return (
    <div>
      <div className="admin-page-header">
        <h1>General Meetings</h1>
        <button className="btn btn--primary" onClick={() => navigate("/admin/general-meetings/new")}>
          Create General Meeting
        </button>
      </div>
      <div className="admin-card">
        <GeneralMeetingTable meetings={meetings} />
      </div>
    </div>
  );
}
