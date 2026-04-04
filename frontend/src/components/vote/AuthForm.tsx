import React, { useState } from "react";

interface AuthFormProps {
  onRequestOtp: (email: string) => void;
  onVerify: (email: string, code: string) => void;
  isRequestingOtp: boolean;
  isVerifying: boolean;
  step: "email" | "code";
  otpEmail: string;
  error?: string;
}

export function AuthForm({
  onRequestOtp,
  onVerify,
  isRequestingOtp,
  isVerifying,
  step,
  otpEmail,
  error,
}: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailError, setEmailError] = useState("");
  const [codeError, setCodeError] = useState("");

  const handleRequestOtp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setEmailError("Email address is required");
      return;
    }
    setEmailError("");
    onRequestOtp(email.trim().toLowerCase());
  };

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setCodeError("Verification code is required");
      return;
    }
    setCodeError("");
    onVerify(otpEmail, code.trim());
  };

  const handleResend = () => {
    setCode("");
    setCodeError("");
    onRequestOtp(otpEmail);
  };

  // When an error arrives on step "code", clear the code input
  const prevError = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (step === "code" && error && error !== prevError.current) {
      setCode("");
    }
    prevError.current = error;
  }, [error, step]);

  return (
    <div className="auth-card">
      <div className="card">
        <div className="auth-card__header">
          {/* US-ACC-05: Step indicator — lets screen readers and sighted users know which step they are on */}
          <p
            className="auth-card__step-indicator"
            aria-live="polite"
            aria-current="step"
          >
            {step === "email" ? "Step 1 of 2: Enter your email" : "Step 2 of 2: Enter your code"}
          </p>
          <h1 className="auth-card__title">Verify your identity</h1>
          {step === "email" && (
            <p className="auth-card__hint">
              Enter your registered email address to receive a verification code.
            </p>
          )}
          {step === "code" && (
            <p className="auth-card__hint">
              We sent a verification code to {otpEmail}
            </p>
          )}
        </div>

        {step === "email" && (
          <form onSubmit={handleRequestOtp} noValidate>
            <p className="auth-card__required-legend">
              <span aria-hidden="true">*</span> Required field
            </p>
            <div className="field">
              <label className="field__label field__label--required" htmlFor="email">Email address</label>
              <input
                id="email"
                className="field__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!emailError}
                aria-describedby={emailError ? "email-error" : undefined}
                aria-required="true"
                required
                placeholder="your@email.com"
              />
              {emailError && (
                <span id="email-error" className="field__error" role="alert">
                  {emailError}
                </span>
              )}
            </div>

            {error && (
              <p className="field__error mt-8 mb-16" role="alert">
                {error}
              </p>
            )}

            <button
              className="btn btn--primary btn--full mt-16"
              type="submit"
              disabled={isRequestingOtp}
            >
              {isRequestingOtp ? "Sending..." : "Send Verification Code"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={handleVerify} noValidate>
            <p className="auth-card__required-legend">
              <span aria-hidden="true">*</span> Required field
            </p>
            <p
              className="auth-card__hint"
              role="status"
              aria-live="polite"
            >
              Verification code sent to {otpEmail}. Check your email — it may take a minute to arrive.
            </p>
            <div className="field">
              <label className="field__label field__label--required" htmlFor="otp-code">Verification code</label>
              <input
                id="otp-code"
                className="field__input"
                type="text"
                inputMode="numeric"
                maxLength={20}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={!!codeError}
                aria-describedby={codeError ? "otp-code-error" : undefined}
                aria-required="true"
                required
                placeholder="e.g. ABCD1234"
              />
              {codeError && (
                <span id="otp-code-error" className="field__error" role="alert">
                  {codeError}
                </span>
              )}
            </div>

            {error && (
              <p className="field__error mt-8 mb-16" role="alert">
                {error}
              </p>
            )}

            <button
              className="btn btn--primary btn--full mt-16"
              type="submit"
              disabled={isVerifying}
            >
              {isVerifying ? "Verifying..." : "Verify"}
            </button>

            <button
              type="button"
              className="btn btn--ghost btn--full mt-8"
              onClick={handleResend}
              disabled={isRequestingOtp}
            >
              {isRequestingOtp ? "Sending..." : "Resend code"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
