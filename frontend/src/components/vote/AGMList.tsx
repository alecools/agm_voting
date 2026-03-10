import React from "react";
import type { AGMOut } from "../../api/voter";
import { AGMListItem } from "./AGMListItem";

interface AGMListProps {
  agms: AGMOut[];
  onEnterVoting: (agmId: string) => void;
  onViewSubmission: (agmId: string) => void;
}

export function AGMList({ agms, onEnterVoting, onViewSubmission }: AGMListProps) {
  if (agms.length === 0) {
    return <p>No AGMs found for this building.</p>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {agms.map((agm) => (
        <li key={agm.id}>
          <AGMListItem
            agm={agm}
            onEnterVoting={onEnterVoting}
            onViewSubmission={onViewSubmission}
          />
        </li>
      ))}
    </ul>
  );
}
