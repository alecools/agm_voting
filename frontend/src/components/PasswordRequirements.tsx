/**
 * PasswordRequirements — real-time password requirements checklist.
 *
 * Displays four requirements (length, uppercase, lowercase, digit) each with
 * a visual check/cross indicator that updates as the user types. Met
 * requirements show a check in green; unmet show an x in muted grey.
 */

export interface PasswordReqs {
  minLength: boolean;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasDigit: boolean;
}

export function checkPasswordRequirements(password: string): PasswordReqs {
  return {
    minLength: password.length >= 8,
    hasUppercase: /[A-Z]/.test(password),
    hasLowercase: /[a-z]/.test(password),
    hasDigit: /[0-9]/.test(password),
  };
}

export function allRequirementsMet(reqs: PasswordReqs): boolean {
  return reqs.minLength && reqs.hasUppercase && reqs.hasLowercase && reqs.hasDigit;
}

interface Requirement {
  key: keyof PasswordReqs;
  label: string;
}

const REQUIREMENTS: Requirement[] = [
  { key: "minLength", label: "At least 8 characters" },
  { key: "hasUppercase", label: "At least one uppercase letter (A–Z)" },
  { key: "hasLowercase", label: "At least one lowercase letter (a–z)" },
  { key: "hasDigit", label: "At least one number (0–9)" },
];

interface PasswordRequirementsProps {
  reqs: PasswordReqs;
}

export default function PasswordRequirements({ reqs }: PasswordRequirementsProps) {
  return (
    <ul className="password-requirements" aria-label="Password requirements">
      {REQUIREMENTS.map(({ key, label }) => {
        const met = reqs[key];
        return (
          <li
            key={key}
            className={met ? "password-requirements__item password-requirements__item--met" : "password-requirements__item"}
            aria-label={`${label}: ${met ? "met" : "not met"}`}
          >
            <span className="password-requirements__icon" aria-hidden="true">
              {met ? "✓" : "✗"}
            </span>
            {label}
          </li>
        );
      })}
    </ul>
  );
}
