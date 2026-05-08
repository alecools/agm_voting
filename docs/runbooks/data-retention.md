# Data Retention Policy Runbook (US-VIL-07)

## Overview

This runbook documents how long meeting data is retained, how to archive old meetings, and GDPR considerations for voter personal data.

---

## Data Retained

| Table | Contains personal data | Retention |
|-------|----------------------|-----------|
| `buildings` | Manager email | Indefinite (operational) |
| `lot_owners` | Lot number, entitlement | Indefinite (operational) |
| `lot_owner_emails` | Email addresses | Retain while lot is active; purge on explicit request |
| `general_meetings` | Meeting title, dates | Minimum 7 years (audit trail) |
| `ballot_submissions` | Voter email, proxy email, ballot hash | Minimum 7 years |
| `votes` | Vote choices keyed to lot_owner_id | Minimum 7 years |
| `admin_login_attempts` | IP address | 24 hours (auto-expired by rate-limit logic) |
| `auth_otps` | Email (used for OTP delivery) | 24 hours (TTL enforced by application) |
| `otp_rate_limits` | Email + IP | 24 hours |
| `session_records` | No PII | N/A |

---

## Retention Periods

| Data | Minimum retention | Notes |
|------|-------------------|-------|
| Votes / ballots (`ballot_submissions`, `votes`) | 7 years | Australian body-corporate law |
| Meeting records (`general_meetings`) | 7 years | Same legal requirement |
| Sessions / OTPs (`auth_otps`, `otp_rate_limits`) | 30 days | Auto-expired by application TTL |
| Email delivery logs (`email_deliveries`) | 1 year | Sufficient for SMTP audit trail |
| Active lot owner emails (`lot_owner_emails`) | Until lot sold or erasure request | GDPR legitimate interest |

### Meeting ballot data (7-year minimum)

Under Australian body corporate law (and most equivalent legislation), the strata manager must retain meeting records and voting results for at least 7 years. `general_meetings`, `ballot_submissions`, and `votes` must not be deleted within this window.

**Enforcement:** The application does not auto-delete old meetings. An admin can delete a meeting via the admin portal only if it has no submitted ballots (enforced by the `delete_general_meeting` service function via database FK constraints).

### Voter email addresses

Email addresses are personal data under GDPR (Article 4). The legal basis for processing is legitimate interest (notifying lot owners of AGM outcomes) or performance of a contract (body corporate governance).

Voter emails in `lot_owner_emails` should be removed when:
- A lot owner sells their property and the email is no longer associated with any active lot
- A GDPR erasure request is received (Right to be Forgotten — subject to the 7-year retention exemption for legal records under Article 17(3)(b))

Voter emails in `ballot_submissions` and `votes` (retained for audit) may be anonymised after the 7-year retention period by replacing with a placeholder (e.g. `anonymised@<lot_id>`), preserving the vote record integrity.

---

## Archiving Old Meetings

There is no automated archiving process. Manual archiving steps:

1. **Archive the building** (admin portal → Building detail → Archive):
   - Sets `Building.is_archived = true`
   - Cascades to lot owners with no emails in another active building
   - Does NOT delete meeting or ballot data

2. **Export meeting results** before deletion (if desired):
   - Download the AGM report PDF from the admin portal
   - Export via admin API: `GET /api/admin/agms/{id}` returns the full detail JSON

3. **Delete a meeting** (admin portal → Meeting detail → Delete):
   - Only possible if the meeting has no submitted ballots
   - Permanently removes the meeting and all cascade data

4. **Archive meetings older than 7 years** (manual SQL — run with care):
   ```sql
   -- Review candidates first
   SELECT id, title, meeting_at, closed_at
   FROM general_meetings
   WHERE closed_at < NOW() - INTERVAL '7 years'
   ORDER BY closed_at;

   -- Anonymise voter PII in ballot_submissions (replace email with lot reference)
   UPDATE ballot_submissions
   SET voter_email = 'anonymised-' || lot_owner_id::text || '@retained',
       proxy_email = NULL
   WHERE general_meeting_id IN (
     SELECT id FROM general_meetings
     WHERE closed_at < NOW() - INTERVAL '7 years'
   );
   ```


### Test data cleanup

For removal of E2E test data from UAT, use the authoritative cleanup SQL documented in `CLAUDE.md` under "Test Data Conventions". Do not use ad-hoc DELETE statements — the authoritative approach deletes by exclusion of known real buildings to avoid accidental deletion of production data.

Automated enforcement of retention periods is tracked as a future enhancement.


---

## GDPR Considerations

### Legal basis
- **Processing during AGM:** Legitimate interest (body corporate governance) and contractual necessity
- **Email notifications:** Legitimate interest (legal obligation to notify lot owners of meeting outcomes)

### Data subject rights

| Right | Response |
|-------|----------|
| Right of access | Provide CSV export of all ballot data for the requesting lot owner |
| Right to rectification | Correct email address in `lot_owner_emails`; note ballot records cannot be altered (legal integrity) |
| Right to erasure | Remove from `lot_owner_emails`; anonymise in `ballot_submissions` / `votes` after 7-year period |
| Right to portability | Provide JSON/CSV export of submitted ballots |
| Right to object | Remove from mailing list; cannot erase ballot record within retention period |

### Data location
All data is stored in Neon PostgreSQL (cloud, AWS us-east-1 region). Neon complies with SOC 2 Type II. See Neon's privacy policy at https://neon.tech/privacy-policy for GDPR transfer mechanisms.

### Contact
For GDPR requests, contact the building manager (email stored in `buildings.manager_email`) or the system administrator.
