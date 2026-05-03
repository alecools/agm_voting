import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "../../lib/auth-client";
import { getSubscription, updateSubscription } from "../../api/subscription";
import type { SubscriptionResponse } from "../../api/subscription";
import { listBuildings } from "../../api/admin";
import type { BuildingArchiveOut } from "../../api/admin";
import { unarchiveBuilding } from "../../api/subscription";
import type { Building } from "../../types";

export default function ControlRoomPage() {
  const navigate = useNavigate();
  const { data: sessionData, isPending: sessionPending } = authClient.useSession();

  // Redirect non-operators to /admin
  useEffect(() => {
    if (sessionPending) return;
    const isServerAdmin = (sessionData as { user?: { role?: string } } | null)?.user?.role === "admin";
    if (!isServerAdmin) {
      navigate("/admin", { replace: true });
    }
  }, [sessionData, sessionPending, navigate]);

  // ---------------------------------------------------------------------------
  // Subscription section
  // ---------------------------------------------------------------------------
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState("");
  const [tierName, setTierName] = useState("");
  const [buildingLimitInput, setBuildingLimitInput] = useState("");
  const [subSaving, setSubSaving] = useState(false);
  const [subSaveSuccess, setSubSaveSuccess] = useState(false);
  const [subSaveError, setSubSaveError] = useState("");

  useEffect(() => {
    getSubscription()
      .then((data) => {
        setSubscription(data);
        setTierName(data.tier_name ?? "");
        setBuildingLimitInput(data.building_limit !== null ? String(data.building_limit) : "");
      })
      .catch(() => {
        setSubError("Failed to load subscription settings.");
      })
      .finally(() => {
        setSubLoading(false);
      });
  }, []);

  async function handleSubSave(e: React.FormEvent) {
    e.preventDefault();
    setSubSaveError("");
    setSubSaveSuccess(false);
    setSubSaving(true);
    try {
      const limit = buildingLimitInput.trim() === "" ? null : parseInt(buildingLimitInput, 10);
      const updated = await updateSubscription({
        tier_name: tierName.trim() || null,
        building_limit: limit,
      });
      setSubscription(updated);
      setSubSaveSuccess(true);
      setTimeout(() => setSubSaveSuccess(false), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save subscription.";
      setSubSaveError(message);
    } finally {
      setSubSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Archived buildings section
  // ---------------------------------------------------------------------------
  const [archivedBuildings, setArchivedBuildings] = useState<Building[]>([]);
  const [archLoading, setArchLoading] = useState(true);
  const [archError, setArchError] = useState("");
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);

  useEffect(() => {
    listBuildings({ is_archived: true, limit: 1000 })
      .then((buildings) => {
        setArchivedBuildings(buildings);
      })
      .catch(() => {
        setArchError("Failed to load archived buildings.");
      })
      .finally(() => {
        setArchLoading(false);
      });
  }, []);

  async function handleUnarchive(buildingId: string) {
    setUnarchivingId(buildingId);
    try {
      await unarchiveBuilding(buildingId);
      setArchivedBuildings((prev) => prev.filter((b) => b.id !== buildingId));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to unarchive building.";
      setArchError(message);
    } finally {
      setUnarchivingId(null);
    }
  }

  // Don't render page content until session check completes
  if (sessionPending) {
    return <p className="state-message">Loading…</p>;
  }

  const isServerAdmin = (sessionData as { user?: { role?: string } } | null)?.user?.role === "admin";
  if (!isServerAdmin) {
    return null;
  }

  return (
    <div>
      <div className="admin-page-header">
        <h1>Control Room</h1>
      </div>

      {/* Subscription Settings */}
      <div className="admin-card">
        <div className="admin-card__header">
          <p className="admin-card__title">Subscription Settings</p>
        </div>
        <div className="admin-card__body">
          {subLoading && <p className="state-message">Loading…</p>}
          {subError && !subLoading && (
            <p className="state-message state-message--error">{subError}</p>
          )}
          {!subLoading && !subError && (
            <form onSubmit={(e) => { void handleSubSave(e); }} className="admin-form">
              <div className="field">
                <label className="field__label" htmlFor="ctrl-tier-name">Tier name</label>
                <select
                  id="ctrl-tier-name"
                  className="field__select"
                  value={tierName}
                  onChange={(e) => setTierName(e.target.value)}
                >
                  <option value="">— select tier —</option>
                  <option value="Free">Free</option>
                  <option value="Starter">Starter</option>
                  <option value="Growth">Growth</option>
                  <option value="Expansion">Expansion</option>
                  <option value="Enterprise">Enterprise</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="ctrl-building-limit">
                  Building limit (leave blank for unlimited)
                </label>
                <input
                  id="ctrl-building-limit"
                  className="field__input"
                  type="number"
                  min={1}
                  value={buildingLimitInput}
                  onChange={(e) => setBuildingLimitInput(e.target.value)}
                  placeholder="Unlimited"
                />
              </div>
              {subSaveSuccess && (
                <p role="status" className="state-message state-message--success">
                  Subscription settings saved.
                </p>
              )}
              {subSaveError && (
                <p className="field__error">{subSaveError}</p>
              )}
              <button
                type="submit"
                className="btn btn--primary"
                disabled={subSaving}
              >
                {subSaving ? "Saving…" : "Save"}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Archived Buildings */}
      <div className="admin-card">
        <div className="admin-card__header">
          <p className="admin-card__title">Archived Buildings</p>
        </div>
        <div className="admin-card__body">
          {archLoading && <p className="state-message">Loading…</p>}
          {archError && !archLoading && (
            <p className="state-message state-message--error">{archError}</p>
          )}
          {!archLoading && !archError && archivedBuildings.length === 0 && (
            <p className="state-message">No archived buildings.</p>
          )}
          {!archLoading && !archError && archivedBuildings.length > 0 && (
            <div className="admin-table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Building Name</th>
                    <th scope="col">Lots</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {archivedBuildings.map((building) => (
                    <tr key={building.id}>
                      <td>{building.name}</td>
                      <td>{(building as Building & { lot_count?: number }).lot_count ?? "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--admin"
                          disabled={unarchivingId === building.id}
                          onClick={() => { void handleUnarchive(building.id); }}
                        >
                          {unarchivingId === building.id ? "Unarchiving…" : "Unarchive"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
