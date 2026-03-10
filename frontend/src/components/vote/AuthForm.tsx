import React, { useState } from "react";

interface AuthFormProps {
  agmTitle: string;
  buildingName: string;
  onSubmit: (lotNumber: string, email: string) => void;
  isLoading: boolean;
  error?: string;
}

export function AuthForm({
  agmTitle,
  buildingName,
  onSubmit,
  isLoading,
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
    <div>
      <h1>{agmTitle}</h1>
      <p>{buildingName}</p>
      <form onSubmit={handleSubmit} noValidate>
        <div>
          <label htmlFor="lot-number">Lot number</label>
          <input
            id="lot-number"
            type="text"
            value={lotNumber}
            onChange={(e) => setLotNumber(e.target.value)}
            aria-invalid={!!lotError}
            aria-describedby={lotError ? "lot-number-error" : undefined}
          />
          {lotError && (
            <span id="lot-number-error" role="alert">
              {lotError}
            </span>
          )}
        </div>
        <div>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!emailError}
            aria-describedby={emailError ? "email-error" : undefined}
          />
          {emailError && (
            <span id="email-error" role="alert">
              {emailError}
            </span>
          )}
        </div>
        {error && (
          <p role="alert" style={{ color: "red" }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={isLoading}>
          {isLoading ? "Verifying..." : "Continue"}
        </button>
      </form>
    </div>
  );
}
