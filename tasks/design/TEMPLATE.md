# Design: [Feature Name]

## Overview

One paragraph describing what this feature/fix does and why.

---

## Root Cause / Background

(For bug fixes: exact root cause with file + line number. For features: the user need being addressed.)

---

## Technical Design

### Database changes
(Schema changes, new tables, new columns, migrations needed — or "None")

### Backend changes
(New/modified endpoints, service functions, Pydantic schemas — with file paths)

### Frontend changes
(New/modified components, API calls, state — with file paths)

---

## Security Considerations

- **Authentication**: what auth is required on new endpoints?
- **Input validation**: what user inputs need sanitisation or length limits?
- **Session/cookies**: any changes to how sessions are stored or transmitted?
- **Secrets**: any new credentials or API keys needed?
- **Rate limiting**: any new endpoints that need rate limiting?
- **Data exposure**: does this feature expose any sensitive data? Is it scoped correctly?

If none of the above apply, write "No security implications" with a one-line justification.

---

## Files to Change

| File | Change |
|------|--------|
| `path/to/file.py` | Description of change |

---

## Test Cases

### Unit / Integration
- Happy path: ...
- Input validation: ...
- Error cases: ...

### E2E
- Scenario: ...

---

## Schema Migration Required
Yes / No
