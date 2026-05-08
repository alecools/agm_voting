import { useState, useEffect, useRef, useCallback } from "react";
import { saveDraft } from "../api/voter";
import type { VoteChoice } from "../types";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseAutoSaveResult {
  status: SaveStatus;
  saveNow: () => void;
}

export function useAutoSave(
  meetingId: string,
  motionId: string,
  choice: VoteChoice | null,
  _session?: string
): UseAutoSaveResult {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestChoice = useRef(choice);
  latestChoice.current = choice;
  const isFirstMount = useRef(true);

  const doSave = useCallback(() => {
    setStatus("saving");
    saveDraft(meetingId, { motion_id: motionId, choice: latestChoice.current })
      .then(() => {
        setStatus("saved");
      })
      .catch(() => {
        setStatus("error");
      });
  }, [meetingId, motionId]);

  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      doSave();
    }, 400);

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [choice, doSave]); // doSave added — safe because it is a stable useCallback

  const saveNow = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    doSave();
  }, [doSave]);

  return { status, saveNow };
}
