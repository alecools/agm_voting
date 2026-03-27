import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { listBuildings, createGeneralMeeting } from "../../api/admin";
import type { GeneralMeetingOut, GeneralMeetingCreateRequest } from "../../api/admin";
import type { Building } from "../../types";
import MotionEditor, { type MotionFormEntry } from "./MotionEditor";
import MotionExcelUpload from "./MotionExcelUpload";

export default function CreateGeneralMeetingForm() {
  const navigate = useNavigate();

  const { data: buildings = [] } = useQuery<Building[]>({
    queryKey: ["admin", "buildings"],
    queryFn: listBuildings,
  });

  const activeBuildings = buildings.filter((b) => !b.is_archived);

  const [buildingId, setBuildingId] = useState("");
  const [title, setTitle] = useState("");
  const [meetingAt, setMeetingAt] = useState("");
  const [votingClosesAt, setVotingClosesAt] = useState("");
  const [motions, setMotions] = useState<MotionFormEntry[]>([{ title: "", description: "", motion_number: "", motion_type: "general" }]);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation<GeneralMeetingOut, Error, GeneralMeetingCreateRequest>({
    mutationFn: (data) => createGeneralMeeting(data),
    onSuccess: (data) => { navigate(`/admin/general-meetings/${data.id}`); },
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
        display_order: i + 1,
        motion_number: m.motion_number?.trim() || null,
        motion_type: m.motion_type,
      })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="admin-form" noValidate>
      <p className="field__hint" style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
        <span aria-hidden="true">*</span> Required field
      </p>
      <div className="field">
        <label className="field__label field__label--required" htmlFor="agm-building">Building</label>
        <select
          id="agm-building"
          className="field__select"
          value={buildingId}
          onChange={(e) => setBuildingId(e.target.value)}
          aria-required="true"
          required
        >
          <option value="">-- Select a building --</option>
          {activeBuildings.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label field__label--required" htmlFor="agm-title">Title</label>
        <input
          id="agm-title"
          className="field__input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-required="true"
          required
        />
      </div>

      <div className="field">
        <label className="field__label field__label--required" htmlFor="agm-meeting-at">Meeting Date / Time</label>
        <input
          id="agm-meeting-at"
          className="field__input"
          type="datetime-local"
          value={meetingAt}
          onChange={(e) => setMeetingAt(e.target.value)}
          aria-required="true"
          required
        />
      </div>

      <div className="field">
        <label className="field__label field__label--required" htmlFor="agm-voting-closes-at">Voting Closes At</label>
        <input
          id="agm-voting-closes-at"
          className="field__input"
          type="datetime-local"
          value={votingClosesAt}
          onChange={(e) => setVotingClosesAt(e.target.value)}
          aria-required="true"
          required
        />
      </div>

      <MotionExcelUpload onMotionsLoaded={(loaded) => setMotions(loaded)} />

      <MotionEditor motions={motions} onChange={setMotions} />

      {formError && (
        <p className="field__error" style={{ marginBottom: 16 }}>{formError}</p>
      )}

      <div style={{ marginTop: 8 }}>
        <button type="submit" className="btn btn--primary" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating..." : "Create General Meeting"}
        </button>
      </div>
    </form>
  );
}
