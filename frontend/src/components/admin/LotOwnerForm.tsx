import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addLotOwner, updateLotOwner, addEmailToLotOwner, removeEmailFromLotOwner, setLotOwnerProxy, removeLotOwnerProxy } from "../../api/admin";
import type { LotOwner } from "../../types";
import type { LotOwnerCreateRequest, LotOwnerUpdateRequest } from "../../api/admin";
import { isValidEmail } from "../../utils/validation";

interface LotOwnerFormProps {
  buildingId: string;
  editTarget: LotOwner | null;
  onSuccess: () => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Edit modal — centred dialog with email management
// ---------------------------------------------------------------------------
function EditModal({
  lotOwner,
  onSuccess,
  onCancel,
}: {
  lotOwner: LotOwner;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [unitEntitlement, setUnitEntitlement] = useState(
    lotOwner.unit_entitlement.toString()
  );
  const [financialPosition, setFinancialPosition] = useState(
    lotOwner.financial_position
  );
  const [givenName, setGivenName] = useState(lotOwner.given_name ?? "");
  const [surname, setSurname] = useState(lotOwner.surname ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  // Email management
  const [emails, setEmails] = useState<string[]>(lotOwner.emails);
  const [newEmail, setNewEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailsModified, setEmailsModified] = useState(false);

  // Proxy management
  const [proxyEmail, setProxyEmail] = useState<string | null>(lotOwner.proxy_email ?? null);
  const [newProxyEmail, setNewProxyEmail] = useState("");
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [proxyModified, setProxyModified] = useState(false);

  const queryClient = useQueryClient();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Reset state when lotOwner changes (e.g. if parent rerenders with new target)
  useEffect(() => {
    setUnitEntitlement(lotOwner.unit_entitlement.toString());
    setFinancialPosition(lotOwner.financial_position);
    setGivenName(lotOwner.given_name ?? "");
    setSurname(lotOwner.surname ?? "");
    setFormError(null);
    setEmails(lotOwner.emails);
    setNewEmail("");
    setEmailError(null);
    setEmailsModified(false);
    setProxyEmail(lotOwner.proxy_email ?? null);
    setNewProxyEmail("");
    setProxyError(null);
    setProxyModified(false);
  }, [lotOwner]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCancel();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const editMutation = useMutation<LotOwner, Error, LotOwnerUpdateRequest>({
    mutationFn: (data) => updateLotOwner(lotOwner.id, data),
    onSuccess: () => {
      setFormError(null);
      onSuccess();
    },
    onError: (err) => {
      setFormError(err.message);
    },
  });

  const addEmailMutation = useMutation<LotOwner, Error, string>({
    mutationFn: (email) => addEmailToLotOwner(lotOwner.id, email),
    onSuccess: (updated) => {
      setEmails(updated.emails);
      setNewEmail("");
      setEmailError(null);
      setEmailsModified(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", lotOwner.building_id] });
    },
    onError: (err) => {
      setEmailError(err.message);
    },
  });

  const removeEmailMutation = useMutation<LotOwner, Error, string>({
    mutationFn: (email) => removeEmailFromLotOwner(lotOwner.id, email),
    onSuccess: (updated) => {
      setEmails(updated.emails);
      setEmailError(null);
      setEmailsModified(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", lotOwner.building_id] });
    },
    onError: (err) => {
      setEmailError(err.message);
    },
  });

  const setProxyMutation = useMutation<LotOwner, Error, string>({
    mutationFn: (email) => setLotOwnerProxy(lotOwner.id, email),
    onSuccess: (updated) => {
      setProxyEmail(updated.proxy_email ?? null);
      setNewProxyEmail("");
      setProxyError(null);
      setProxyModified(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", lotOwner.building_id] });
    },
    onError: (err) => {
      setProxyError(err.message);
    },
  });

  const removeProxyMutation = useMutation<LotOwner, Error, void>({
    mutationFn: () => removeLotOwnerProxy(lotOwner.id),
    onSuccess: () => {
      setProxyEmail(null);
      setProxyError(null);
      setProxyModified(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", lotOwner.building_id] });
    },
    onError: (err) => {
      setProxyError(err.message);
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

    const updateData: LotOwnerUpdateRequest = {};
    if (parsed !== lotOwner.unit_entitlement) updateData.unit_entitlement = parsed;
    if (financialPosition !== lotOwner.financial_position)
      updateData.financial_position = financialPosition;
    const trimmedGivenName = givenName.trim() || null;
    const trimmedSurname = surname.trim() || null;
    if (trimmedGivenName !== (lotOwner.given_name ?? null)) updateData.given_name = trimmedGivenName;
    if (trimmedSurname !== (lotOwner.surname ?? null)) updateData.surname = trimmedSurname;

    if (Object.keys(updateData).length === 0) {
      if (emailsModified || proxyModified) {
        onSuccess();
        return;
      }
      setFormError("No changes detected.");
      return;
    }
    editMutation.mutate(updateData);
  }

  function handleAddEmail() {
    setEmailError(null);
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) {
      setEmailError("Email is required.");
      return;
    }
    if (!isValidEmail(trimmed)) {
      setEmailError("Please enter a valid email address.");
      return;
    }
    addEmailMutation.mutate(trimmed);
  }

  function handleRemoveEmail(email: string) {
    setEmailError(null);
    removeEmailMutation.mutate(email);
  }

  function handleSetProxy() {
    setProxyError(null);
    const trimmed = newProxyEmail.trim();
    if (!trimmed) { setProxyError("Proxy email is required."); return; }
    if (!isValidEmail(trimmed)) { setProxyError("Please enter a valid email address."); return; }
    setProxyMutation.mutate(trimmed);
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) {
      onCancel();
    }
  }

  const isPending =
    editMutation.isPending ||
    addEmailMutation.isPending ||
    removeEmailMutation.isPending ||
    setProxyMutation.isPending ||
    removeProxyMutation.isPending;

  return (
    <div
      className="dialog-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-modal-title"
    >
      <div
        className="dialog"
        style={{ maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}
      >
        <h3
          id="edit-modal-title"
          className="admin-card__title"
          style={{ marginBottom: 20 }}
        >
          Edit Lot Owner
        </h3>

        {/* Email list */}
        <div className="field" style={{ marginBottom: 20 }}>
          <label className="field__label">Email Addresses</label>
          <ul
            style={{ listStyle: "none", padding: 0, margin: "0 0 10px" }}
            aria-label="Email addresses"
          >
            {emails.map((email) => (
              <li
                key={email}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 0",
                  borderBottom: "1px solid var(--border-subtle, #e5e7eb)",
                  fontSize: "0.875rem",
                }}
              >
                <span>{email}</span>
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ padding: "3px 10px", fontSize: "0.75rem" }}
                  onClick={() => handleRemoveEmail(email)}
                  disabled={isPending}
                  aria-label={`Remove ${email}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          {/* Add email */}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="add-email-input"
              className="field__input"
              type="email"
              placeholder="new@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              aria-label="Add email"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddEmail();
                }
              }}
            />
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleAddEmail}
              disabled={isPending}
              style={{ whiteSpace: "nowrap" }}
            >
              Add email
            </button>
          </div>
          {emailError && (
            <p className="field__error" style={{ marginTop: 6 }} role="alert">
              {emailError}
            </p>
          )}
        </div>

        {/* Proxy nomination */}
        <div className="field" style={{ marginBottom: 20 }}>
          <label className="field__label">Proxy</label>
          {proxyEmail ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", fontSize: "0.875rem" }}>
              <span>{proxyEmail}</span>
              <button
                type="button"
                className="btn btn--secondary"
                style={{ padding: "3px 10px", fontSize: "0.75rem" }}
                onClick={() => { setProxyError(null); removeProxyMutation.mutate(); }}
                disabled={isPending}
              >
                Remove proxy
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="set-proxy-input"
                className="field__input"
                type="email"
                placeholder="proxy@example.com"
                value={newProxyEmail}
                onChange={(e) => setNewProxyEmail(e.target.value)}
                aria-label="Set proxy email"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSetProxy(); } }}
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleSetProxy}
                disabled={isPending}
                style={{ whiteSpace: "nowrap" }}
              >
                Set proxy
              </button>
            </div>
          )}
          {proxyError && (
            <p className="field__error" style={{ marginTop: 6 }} role="alert">{proxyError}</p>
          )}
        </div>

        {/* Edit form */}
        <form onSubmit={handleSubmit} className="admin-form">
          {/* US-ACC-08: required field legend */}
          <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
            <span aria-hidden="true">*</span> Required field
          </p>
          <div className="field">
            <label className="field__label" htmlFor="edit-given-name">
              Given Name (optional)
            </label>
            <input
              id="edit-given-name"
              className="field__input"
              type="text"
              value={givenName}
              onChange={(e) => setGivenName(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-surname">
              Surname (optional)
            </label>
            <input
              id="edit-surname"
              className="field__input"
              type="text"
              value={surname}
              onChange={(e) => setSurname(e.target.value)}
            />
          </div>

          <div className="field">
            {/* US-ACC-08: visible * marker + aria-required */}
            <label className="field__label field__label--required" htmlFor="lot-entitlement">
              Unit Entitlement
            </label>
            <input
              id="lot-entitlement"
              className="field__input"
              type="number"
              value={unitEntitlement}
              onChange={(e) => setUnitEntitlement(e.target.value)}
              aria-required="true"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="lot-financial-position">
              Financial Position
            </label>
            <select
              id="lot-financial-position"
              className="field__input"
              value={financialPosition}
              onChange={(e) => setFinancialPosition(e.target.value as "normal" | "in_arrear")}
            >
              <option value="normal">Normal</option>
              <option value="in_arrear">In Arrear</option>
            </select>
          </div>

          {formError && (
            <p className="field__error" style={{ marginBottom: 12 }} role="alert">
              {formError}
            </p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={isPending}
            >
              {editMutation.isPending ? "Saving..." : "Save Changes"}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onCancel}
              disabled={isPending}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add form — centred dialog modal (same pattern as EditModal)
// ---------------------------------------------------------------------------
function AddForm({
  buildingId,
  onSuccess,
  onCancel,
}: {
  buildingId: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [lotNumber, setLotNumber] = useState("");
  const [givenName, setGivenName] = useState("");
  const [surname, setSurname] = useState("");
  const [email, setEmail] = useState("");
  const [unitEntitlement, setUnitEntitlement] = useState("");
  const [financialPosition, setFinancialPosition] = useState("normal");
  const [formError, setFormError] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCancel();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const addMutation = useMutation<LotOwner, Error, LotOwnerCreateRequest>({
    mutationFn: (data) => addLotOwner(buildingId, data),
    onSuccess: () => {
      setLotNumber("");
      setGivenName("");
      setSurname("");
      setEmail("");
      setUnitEntitlement("");
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
    if (!lotNumber.trim()) {
      setFormError("Lot number is required.");
      return;
    }
    if (email.trim() && !isValidEmail(email)) {
      setFormError("Please enter a valid email address.");
      return;
    }

    addMutation.mutate({
      lot_number: lotNumber,
      given_name: givenName.trim() || null,
      surname: surname.trim() || null,
      emails: email.trim() ? [email.trim().toLowerCase()] : [],
      unit_entitlement: parsed,
      financial_position: financialPosition,
    });
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) {
      onCancel();
    }
  }

  return (
    <div
      className="dialog-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-modal-title"
    >
      <div
        className="dialog"
        style={{ maxWidth: 480 }}
      >
        <h3
          id="add-modal-title"
          className="admin-card__title"
          style={{ marginBottom: 20 }}
        >
          Add Lot Owner
        </h3>

        <form onSubmit={handleSubmit} className="admin-form">
          {/* US-ACC-08: required field legend */}
          <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
            <span aria-hidden="true">*</span> Required field
          </p>
          <div className="field">
            {/* US-ACC-08: visible * marker + aria-required on required inputs */}
            <label className="field__label field__label--required" htmlFor="lot-number">
              Lot Number
            </label>
            <input
              id="lot-number"
              className="field__input"
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              aria-required="true"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="add-given-name">
              Given Name (optional)
            </label>
            <input
              id="add-given-name"
              className="field__input"
              type="text"
              value={givenName}
              onChange={(e) => setGivenName(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="add-surname">
              Surname (optional)
            </label>
            <input
              id="add-surname"
              className="field__input"
              type="text"
              value={surname}
              onChange={(e) => setSurname(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="lot-email">
              Email
            </label>
            <input
              id="lot-email"
              className="field__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="field__hint">Leave blank if no email address</span>
          </div>

          <div className="field">
            <label className="field__label field__label--required" htmlFor="lot-entitlement">
              Unit Entitlement
            </label>
            <input
              id="lot-entitlement"
              className="field__input"
              type="number"
              value={unitEntitlement}
              onChange={(e) => setUnitEntitlement(e.target.value)}
              aria-required="true"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="lot-financial-position">
              Financial Position
            </label>
            <select
              id="lot-financial-position"
              className="field__input"
              value={financialPosition}
              onChange={(e) => setFinancialPosition(e.target.value as "normal" | "in_arrear")}
            >
              <option value="normal">Normal</option>
              <option value="in_arrear">In Arrear</option>
            </select>
          </div>

          {formError && (
            <p className="field__error" style={{ marginBottom: 12 }} role="alert">
              {formError}
            </p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={addMutation.isPending}
            >
              {addMutation.isPending ? "Saving..." : "Add Lot Owner"}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onCancel}
              disabled={addMutation.isPending}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component — renders AddForm inline or EditModal centred
// ---------------------------------------------------------------------------
export default function LotOwnerForm({
  buildingId,
  editTarget,
  onSuccess,
  onCancel,
}: LotOwnerFormProps) {
  if (editTarget !== null) {
    return (
      <EditModal
        lotOwner={editTarget}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />
    );
  }
  return (
    <AddForm
      buildingId={buildingId}
      onSuccess={onSuccess}
      onCancel={onCancel}
    />
  );
}
