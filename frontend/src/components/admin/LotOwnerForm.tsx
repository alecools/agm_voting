import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addLotOwner,
  updateLotOwner,
  addEmailToLotOwner,
  removeEmailFromLotOwner,
  addOwnerEmailToLotOwner,
  updateOwnerEmail,
  removeOwnerEmailById,
  setLotOwnerProxy,
  removeLotOwnerProxy,
} from "../../api/admin";
import type { LotOwner, LotOwnerEmailEntry } from "../../types";
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
  const [formError, setFormError] = useState<string | null>(null);

  // Owner email management
  const [ownerEmails, setOwnerEmails] = useState<LotOwnerEmailEntry[]>(lotOwner.owner_emails);
  const [newOwnerEmail, setNewOwnerEmail] = useState("");
  const [newOwnerGivenName, setNewOwnerGivenName] = useState("");
  const [newOwnerSurname, setNewOwnerSurname] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailsModified, setEmailsModified] = useState(false);
  const [newOwnerPhone, setNewOwnerPhone] = useState("");
  // Inline edit state: which entry is being edited
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [editEmailValue, setEditEmailValue] = useState("");
  const [editGivenName, setEditGivenName] = useState("");
  const [editSurname, setEditSurname] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // Proxy management
  const [proxyEmail, setProxyEmail] = useState<string | null>(lotOwner.proxy_email ?? null);
  const [newProxyEmail, setNewProxyEmail] = useState("");
  const [proxyGivenName, setProxyGivenName] = useState(lotOwner.proxy_given_name ?? "");
  const [proxySurname, setProxySurname] = useState(lotOwner.proxy_surname ?? "");
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [proxyModified, setProxyModified] = useState(false);

  const queryClient = useQueryClient();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Reset state when lotOwner changes (e.g. if parent rerenders with new target)
  useEffect(() => {
    setUnitEntitlement(lotOwner.unit_entitlement.toString());
    setFinancialPosition(lotOwner.financial_position);
    setFormError(null);
    setOwnerEmails(lotOwner.owner_emails);
    setNewOwnerEmail("");
    setNewOwnerGivenName("");
    setNewOwnerSurname("");
    setNewOwnerPhone("");
    setEmailError(null);
    setEmailsModified(false);
    setEditingEmailId(null);
    setEditEmailValue("");
    setEditGivenName("");
    setEditSurname("");
    setEditPhone("");
    setEditError(null);
    setProxyEmail(lotOwner.proxy_email ?? null);
    setNewProxyEmail("");
    setProxyGivenName(lotOwner.proxy_given_name ?? "");
    setProxySurname(lotOwner.proxy_surname ?? "");
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

  const addOwnerEmailMutation = useMutation<
    LotOwner,
    Error,
    { email: string; given_name: string | null; surname: string | null; phone_number?: string | null }
  >({
    mutationFn: (data) => addOwnerEmailToLotOwner(lotOwner.id, data),
    onSuccess: (updated) => {
      setOwnerEmails(updated.owner_emails);
      setNewOwnerEmail("");
      setNewOwnerGivenName("");
      setNewOwnerSurname("");
      setEmailError(null);
      setEmailsModified(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", lotOwner.building_id] });
    },
    onError: (err) => {
      setEmailError(err.message);
    },
  });

  const updateOwnerEmailMutation = useMutation<
    LotOwner,
    Error,
    { emailId: string; email?: string | null; given_name?: string | null; surname?: string | null; phone_number?: string | null }
  >({
    mutationFn: ({ emailId, ...data }) => updateOwnerEmail(lotOwner.id, emailId, data),
    onSuccess: (updated) => {
      setOwnerEmails(updated.owner_emails);
      setEditingEmailId(null);
      setEditError(null);
      setEmailsModified(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", lotOwner.building_id] });
    },
    onError: (err) => {
      setEditError(err.message);
    },
  });

  const removeOwnerEmailMutation = useMutation<LotOwner, Error, string>({
    mutationFn: (emailId) => removeOwnerEmailById(lotOwner.id, emailId),
    onSuccess: (updated) => {
      setOwnerEmails(updated.owner_emails);
      setEmailError(null);
      setEmailsModified(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", lotOwner.building_id] });
    },
    onError: (err) => {
      setEmailError(err.message);
    },
  });

  const setProxyMutation = useMutation<LotOwner, Error, { email: string; givenName: string | null; surname: string | null }>({
    mutationFn: ({ email, givenName, surname }) => setLotOwnerProxy(lotOwner.id, email, givenName, surname),
    onSuccess: (updated) => {
      setProxyEmail(updated.proxy_email ?? null);
      setProxyGivenName(updated.proxy_given_name ?? "");
      setProxySurname(updated.proxy_surname ?? "");
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
      setProxyGivenName("");
      setProxySurname("");
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

  function handleAddOwnerEmail() {
    setEmailError(null);
    const trimmedEmail = newOwnerEmail.trim().toLowerCase();
    if (!trimmedEmail) {
      setEmailError("Email is required.");
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      setEmailError("Please enter a valid email address.");
      return;
    }
    addOwnerEmailMutation.mutate({
      email: trimmedEmail,
      given_name: newOwnerGivenName.trim() || null,
      surname: newOwnerSurname.trim() || null,
      phone_number: newOwnerPhone.trim() || null,
    });
  }

  function handleRemoveOwnerEmail(emailId: string) {
    setEmailError(null);
    removeOwnerEmailMutation.mutate(emailId);
  }

  function handleStartEdit(entry: LotOwnerEmailEntry) {
    setEditingEmailId(entry.id);
    setEditEmailValue(entry.email ?? "");
    setEditGivenName(entry.given_name ?? "");
    setEditSurname(entry.surname ?? "");
    setEditPhone(entry.phone_number ?? "");
    setEditError(null);
  }

  function handleCancelEdit() {
    setEditingEmailId(null);
    setEditPhone("");
    setEditError(null);
  }

  function handleSaveEdit(emailId: string) {
    setEditError(null);
    const trimmedEmail = editEmailValue.trim().toLowerCase();
    if (!trimmedEmail) {
      setEditError("Email is required.");
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      setEditError("Please enter a valid email address.");
      return;
    }
    updateOwnerEmailMutation.mutate({
      emailId,
      email: trimmedEmail,
      given_name: editGivenName.trim() || null,
      surname: editSurname.trim() || null,
      phone_number: editPhone.trim() || null,
    });
  }

  function handleSetProxy() {
    setProxyError(null);
    const trimmed = newProxyEmail.trim();
    if (!trimmed) { setProxyError("Proxy email is required."); return; }
    if (!isValidEmail(trimmed)) { setProxyError("Please enter a valid email address."); return; }
    setProxyMutation.mutate({
      email: trimmed,
      givenName: proxyGivenName.trim() || null,
      surname: proxySurname.trim() || null,
    });
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current) {
      onCancel();
    }
  }

  const isPending =
    editMutation.isPending ||
    addOwnerEmailMutation.isPending ||
    updateOwnerEmailMutation.isPending ||
    removeOwnerEmailMutation.isPending ||
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

        {/* Owner email list */}
        <div className="field" style={{ marginBottom: 20 }}>
          <label className="field__label">Owners (name + email)</label>
          <ul
            style={{ listStyle: "none", padding: 0, margin: "0 0 10px" }}
            aria-label="Owner email addresses"
          >
            {ownerEmails.map((entry) => (
              <li
                key={entry.id}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid var(--border-subtle)",
                  fontSize: "0.875rem",
                }}
              >
                {editingEmailId === entry.id ? (
                  // Inline edit form
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        className="field__input"
                        type="text"
                        placeholder="Given name"
                        value={editGivenName}
                        onChange={(e) => setEditGivenName(e.target.value)}
                        aria-label="Edit given name"
                      />
                      <input
                        className="field__input"
                        type="text"
                        placeholder="Surname"
                        value={editSurname}
                        onChange={(e) => setEditSurname(e.target.value)}
                        aria-label="Edit surname"
                      />
                    </div>
                    <input
                      className="field__input"
                      type="email"
                      placeholder="email@example.com"
                      value={editEmailValue}
                      onChange={(e) => setEditEmailValue(e.target.value)}
                      aria-label="Edit email"
                    />
                    <input
                      className="field__input"
                      type="tel"
                      placeholder="+61412345678 (optional)"
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      aria-label="Edit phone number"
                    />
                    {editError && (
                      <p className="field__error" role="alert" style={{ margin: 0 }}>{editError}</p>
                    )}
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn--primary"
                        style={{ padding: "3px 10px", fontSize: "0.75rem" }}
                        onClick={() => handleSaveEdit(entry.id)}
                        disabled={isPending}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        style={{ padding: "3px 10px", fontSize: "0.75rem" }}
                        onClick={handleCancelEdit}
                        disabled={isPending}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  // Display row
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>
                      {entry.given_name || entry.surname
                        ? `${entry.given_name ?? ""} ${entry.surname ?? ""}`.trim()
                        : <em style={{ color: "var(--text-muted)" }}>— no name —</em>
                      }
                      {" "}
                      <span style={{ color: "var(--text-secondary)" }}>{entry.email ?? ""}</span>
                      {entry.phone_number && (
                        <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                          {entry.phone_number}
                        </span>
                      )}
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        style={{ padding: "3px 10px", fontSize: "0.75rem" }}
                        onClick={() => handleStartEdit(entry)}
                        disabled={isPending}
                        aria-label={`Edit ${entry.email ?? "owner"}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        style={{ padding: "3px 10px", fontSize: "0.75rem" }}
                        onClick={() => handleRemoveOwnerEmail(entry.id)}
                        disabled={isPending}
                        aria-label={`Remove ${entry.email ?? "owner"}`}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* Add owner row */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                id="add-owner-given-name"
                className="field__input"
                type="text"
                placeholder="Given name (optional)"
                value={newOwnerGivenName}
                onChange={(e) => setNewOwnerGivenName(e.target.value)}
                aria-label="New owner given name"
              />
              <input
                id="add-owner-surname"
                className="field__input"
                type="text"
                placeholder="Surname (optional)"
                value={newOwnerSurname}
                onChange={(e) => setNewOwnerSurname(e.target.value)}
                aria-label="New owner surname"
              />
            </div>
            <input
              id="add-owner-phone"
              className="field__input"
              type="tel"
              placeholder="Phone number (optional)"
              value={newOwnerPhone}
              onChange={(e) => setNewOwnerPhone(e.target.value)}
              aria-label="New owner phone number"
            />
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="add-owner-email-input"
                className="field__input"
                type="email"
                placeholder="email@example.com"
                value={newOwnerEmail}
                onChange={(e) => setNewOwnerEmail(e.target.value)}
                aria-label="Add owner email"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddOwnerEmail();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleAddOwnerEmail}
                disabled={isPending}
                style={{ whiteSpace: "nowrap" }}
              >
                Add owner
              </button>
            </div>
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
              <span>
                {(proxyGivenName || proxySurname)
                  ? `${proxyGivenName} ${proxySurname}`.trim()
                  : <em style={{ color: "var(--text-muted)" }}>— no name —</em>
                }
                {" "}
                <span style={{ color: "var(--text-secondary)" }}>{proxyEmail}</span>
              </span>
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
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="field__input"
                  type="text"
                  placeholder="Given name (optional)"
                  value={proxyGivenName}
                  onChange={(e) => setProxyGivenName(e.target.value)}
                  aria-label="Proxy given name"
                />
                <input
                  className="field__input"
                  type="text"
                  placeholder="Surname (optional)"
                  value={proxySurname}
                  onChange={(e) => setProxySurname(e.target.value)}
                  aria-label="Proxy surname"
                />
              </div>
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
