import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listBuildings, createAGM } from "../../api/admin";
import type { AGMOut, AGMCreateRequest } from "../../api/admin";
import type { Building } from "../../types";
import MotionEditor, { type MotionFormEntry } from "./MotionEditor";
import MotionExcelUpload from "./MotionExcelUpload";

export default function CreateAGMForm() {
  const navigate = useNavigate();

  const { data: buildings = [] } = useQuery<Building[]>({
    queryKey: ["admin", "buildings"],
    queryFn: listBuildings,
  });

  const [buildingId, setBuildingId] = useState("");
  const [title, setTitle] = useState("");
  const [meetingAt, setMeetingAt] = useState("");
  const [votingClosesAt, setVotingClosesAt] = useState("");
  const [motions, setMotions] = useState<MotionFormEntry[]>([{ title: "", description: "", motion_type: "general" }]);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation<AGMOut, Error, AGMCreateRequest>({
    mutationFn: (data) => createAGM(data),
    onSuccess: (data) => { navigate(`/admin/agms/${data.id}`); },
    onError: (err) => { setFormError(err.message); },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!buildingId) { setFormError("Please select a building."); return; }
    if (!title.trim()) { setFormError("Title is required."); return; }
    if (!meetingAt) { setFormError("Meeting date/time is required."); return; }
    if (!votingClosesAt) { setFormError("Voting close date/time is required."); return; }
    if (new Date(votingClosesAt) <= new Date(meetingAt)) {
      setFormError("Voting close time must be after meeting time.");
      return;
    }
    if (motions.length === 0) { setFormError("At least one motion is required."); return; }
    for (let i = 0; i < motions.length; i++) {
      if (!motions[i].title.trim()) {
        setFormError(`Motion ${i + 1} title is required.`);
        return;
      }
    }

    mutation.mutate({
      building_id: buildingId,
      title: title.trim(),
      meeting_at: new Date(meetingAt).toISOString(),
      voting_closes_at: new Date(votingClosesAt).toISOString(),
      motions: motions.map((m, i) => ({
        title: m.title.trim(),
        description: m.description.trim() || null,
        order_index: i,
        motion_type: m.motion_type,
      })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="admin-form">
      <div className="field">
        <label className="field__label" htmlFor="agm-building">Building</label>
        <select
          id="agm-building"
          className="field__select"
          value={buildingId}
          onChange={(e) => setBuildingId(e.target.value)}
        >
          <option value="">-- Select a building --</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="agm-title">Title</label>
        <input
          id="agm-title"
          className="field__input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="agm-meeting-at">Meeting Date / Time</label>
        <input
          id="agm-meeting-at"
          className="field__input"
          type="datetime-local"
          value={meetingAt}
          onChange={(e) => setMeetingAt(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="agm-voting-closes-at">Voting Closes At</label>
        <input
          id="agm-voting-closes-at"
          className="field__input"
          type="datetime-local"
          value={votingClosesAt}
          onChange={(e) => setVotingClosesAt(e.target.value)}
        />
      </div>

      <MotionExcelUpload onMotionsLoaded={(loaded) => setMotions(loaded)} />

      <MotionEditor motions={motions} onChange={setMotions} />

      {formError && (
        <p className="field__error" style={{ marginBottom: 16 }}>{formError}</p>
      )}

      <div style={{ marginTop: 8 }}>
        <button type="submit" className="btn btn--primary" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating..." : "Create AGM"}
        </button>
      </div>
    </form>
  );
}
