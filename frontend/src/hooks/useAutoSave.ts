import { useState, useEffect, useRef, useCallback } from "react";
import { saveDraft } from "../api/voter";
import type { VoteChoice } from "../types";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseAutoSaveResult {
  status: SaveStatus;
  saveNow: () => void;
}

export function useAutoSave(
  agmId: string,
  motionId: string,
  choice: VoteChoice | null,
  _session?: string
): UseAutoSaveResult {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestChoice = useRef(choice);
  latestChoice.current = choice;

  const doSave = useCallback(() => {
    setStatus("saving");
    saveDraft(agmId, { motion_id: motionId, choice: latestChoice.current })
      .then(() => {
        setStatus("saved");
      })
      .catch(() => {
        setStatus("error");
      });
  }, [agmId, motionId]);

  useEffect(() => {
    // Don't auto-save on first mount when idle
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice]);

  const saveNow = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    doSave();
  }, [doSave]);

  return { status, saveNow };
}
