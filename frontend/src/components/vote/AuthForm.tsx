import React, { useState } from "react";

interface AuthFormProps {
  agmTitle: string;
  buildingName: string;
  onSubmit: (lotNumber: string, email: string) => void;
  isLoading: boolean;
  /** True while the meeting context (building_id) is still being fetched. Disables the button without showing "Verifying..." */
  isContextLoading?: boolean;
  error?: string;
}

export function AuthForm({
  agmTitle,
  buildingName,
  onSubmit,
  isLoading,
  isContextLoading = false,
  error,
}: AuthFormProps) {
  const [lotNumber, setLotNumber] = useState("");
  const [email, setEmail] = useState("");
  const [lotError, setLotError] = useState("");
  const [emailError, setEmailError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let valid = true;

    if (!lotNumber.trim()) {
      setLotError("Lot number is required");
      valid = false;
    } else {
      setLotError("");
    }

    if (!email.trim()) {
      setEmailError("Email address is required");
      valid = false;
    } else {
      setEmailError("");
    }

    if (!valid) return;

    onSubmit(lotNumber.trim(), email.trim());
  };

  return (
    <div className="auth-card">
      <div className="card">
        <div className="auth-card__header">
          {buildingName && (
            <p className="auth-card__building">{buildingName}</p>
          )}
          <h1 className="auth-card__title">{agmTitle}</h1>
          <p className="auth-card__hint">
            Enter your lot number and registered email to continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="lot-number">Lot number</label>
            <input
              id="lot-number"
              className="field__input"
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              aria-invalid={!!lotError}
              aria-describedby={lotError ? "lot-number-error" : undefined}
              placeholder="e.g. 12"
            />
            {lotError && (
              <span id="lot-number-error" className="field__error" role="alert">
                {lotError}
              </span>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="email">Email address</label>
            <input
              id="email"
              className="field__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!emailError}
              aria-describedby={emailError ? "email-error" : undefined}
              placeholder="your@email.com"
            />
            {emailError && (
              <span id="email-error" className="field__error" role="alert">
                {emailError}
              </span>
            )}
          </div>

          {error && (
            <p className="field__error mt-8" role="alert" style={{ marginBottom: "16px" }}>
              {error}
            </p>
          )}

          <button className="btn btn--primary btn--full mt-16" type="submit" disabled={isLoading || isContextLoading}>
            {isLoading ? "Verifying..." : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
