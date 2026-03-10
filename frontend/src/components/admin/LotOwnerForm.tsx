import React, { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { addLotOwner, updateLotOwner } from "../../api/admin";
import type { LotOwner } from "../../types";
import type { LotOwnerCreateRequest, LotOwnerUpdateRequest } from "../../api/admin";

interface LotOwnerFormProps {
  buildingId: string;
  editTarget: LotOwner | null;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function LotOwnerForm({
  buildingId,
  editTarget,
  onSuccess,
  onCancel,
}: LotOwnerFormProps) {
  const isEdit = editTarget !== null;

  const [lotNumber, setLotNumber] = useState(editTarget?.lot_number ?? "");
  const [email, setEmail] = useState(editTarget?.email ?? "");
  const [unitEntitlement, setUnitEntitlement] = useState(
    editTarget?.unit_entitlement.toString() ?? ""
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setLotNumber(editTarget?.lot_number ?? "");
    setEmail(editTarget?.email ?? "");
    setUnitEntitlement(editTarget?.unit_entitlement.toString() ?? "");
    setFormError(null);
  }, [editTarget]);

  const addMutation = useMutation<LotOwner, Error, LotOwnerCreateRequest>({
    mutationFn: (data) => addLotOwner(buildingId, data),
    onSuccess: () => {
      setLotNumber("");
      setEmail("");
      setUnitEntitlement("");
      setFormError(null);
      onSuccess();
    },
    onError: (err) => {
      setFormError(err.message);
    },
  });

  const editMutation = useMutation<LotOwner, Error, LotOwnerUpdateRequest>({
    mutationFn: (data) => updateLotOwner(editTarget!.id, data),
    onSuccess: () => {
      setFormError(null);
      onSuccess();
    },
    onError: (err) => {
      setFormError(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = parseInt(unitEntitlement, 10);
    if (!unitEntitlement.trim() || isNaN(parsed)) {
      setFormError("Unit entitlement must be a valid integer.");
      return;
    }
    if (parsed < 0) {
      setFormError("Unit entitlement must be >= 0.");
      return;
    }

    if (isEdit) {
      const updateData: LotOwnerUpdateRequest = {};
      if (email !== editTarget!.email) updateData.email = email;
      if (parsed !== editTarget!.unit_entitlement) updateData.unit_entitlement = parsed;
      if (Object.keys(updateData).length === 0) {
        setFormError("No changes detected.");
        return;
      }
      editMutation.mutate(updateData);
    } else {
      if (!lotNumber.trim()) {
        setFormError("Lot number is required.");
        return;
      }
      if (!email.trim()) {
        setFormError("Email is required.");
        return;
      }
      addMutation.mutate({ lot_number: lotNumber, email, unit_entitlement: parsed });
    }
  }

  const isPending = addMutation.isPending || editMutation.isPending;

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: 16, maxWidth: 400 }}>
      <h3>{isEdit ? "Edit Lot Owner" : "Add Lot Owner"}</h3>

      {!isEdit && (
        <div style={fieldStyle}>
          <label htmlFor="lot-number">Lot Number</label>
          <input
            id="lot-number"
            type="text"
            value={lotNumber}
            onChange={(e) => setLotNumber(e.target.value)}
            style={inputStyle}
          />
        </div>
      )}

      <div style={fieldStyle}>
        <label htmlFor="lot-email">Email</label>
        <input
          id="lot-email"
          type="text"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={inputStyle}
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="lot-entitlement">Unit Entitlement</label>
        <input
          id="lot-entitlement"
          type="number"
          value={unitEntitlement}
          onChange={(e) => setUnitEntitlement(e.target.value)}
          style={inputStyle}
        />
      </div>

      {formError && (
        <p style={{ color: "#721c24", marginTop: 8 }}>
          {formError}
        </p>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : isEdit ? "Save Changes" : "Add Lot Owner"}
        </button>
        <button type="button" onClick={onCancel} disabled={isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  marginBottom: 12,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #ced4da",
  borderRadius: 4,
  marginTop: 4,
};
