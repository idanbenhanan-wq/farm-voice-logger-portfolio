# Scope, evidence and known limitations

Review date: **2026-11-24**.

## What this repository proves

The public portfolio contains five selected TypeScript source files read from the course MVP. They show implementation approaches for AI extraction, role checks, record handling and local queuing. They are source snapshots for review, not a complete runnable system.

A fresh repository was created; the original private repository's commit history, other branches, databases, seed accounts and operational files were not imported.

## Historical evidence

An internal demo readiness report dated 2026-09-19 states that the following passed in development using demo data:

- Operator and manager login.
- Processing a Hebrew audio file into a transcript and extracted fields.
- Manual correction, saving and opening the record.
- Manager approval and an audit entry.
- Local record storage during a disconnection and later synchronization.

This is a summary of an internal historical report, not independent verification. The source report is not included as a public test artefact. No current application run, build, automated test, penetration test or field pilot was performed when preparing this portfolio.

## Static review findings

These findings describe visible code, with impact assessments identified as review conclusions. External workspace schemas and full deployment configuration are not included.

| Finding | Evidence | Review conclusion and next step |
|---|---|---|
| A queued record is removed after its retry count reaches three | `code/frontend/syncEngine.ts`, `item.retries >= MAX_RETRIES` calls `removeFromQueue` | Potential loss of an unsynchronized record. Retain failed items with a visible error state and manual retry/export. |
| Record creation assigns approval status from parsed request data when supplied | `code/backend/routes/records.ts`, `approvalStatus: body.data.approvalStatus ?? "pending"` | A possible approval bypass depends on the external request schema. Verify schema acceptance; enforce initial pending status on the server and test operator attempts to set approval state. |
| Model JSON is parsed without an explicit output schema in the shown route | `code/backend/routes/ai.ts`, `JSON.parse(content)` | Validate types, allowed values and required fields before consuming model output. JSON formatting alone does not validate business meaning. |
| The model can provide `missingFields` and a confidence value | `extracted.missingFields ?? missingFields`, `confidenceScore` | Recompute required-field gaps in application code. Treat confidence as a model-reported hint, not calibrated accuracy. |
| Dose checks use `parseFloat`; the shown code does not explicitly reject NaN or enforce units | `code/backend/routes/records.ts` and `ai.ts` | Test nonnumeric strings, units, partial parses and catalog mismatches; enforce a typed numeric amount with explicit units. |
| Tokens are verified and role claims are read from the JWT | `code/backend/middleware/auth.ts` | Demonstrates a role check, not a security certification. Review runtime claim validation, accepted algorithms and behavior after role changes or account deactivation. |
| Queue contents are stored under one localStorage key | `code/frontend/offlineQueue.ts` | Review access on shared devices, per-user separation, corrupted storage and logout behavior. |
| Creation, audit writing and operational event writing are separate awaited operations | `code/backend/routes/records.ts` | Test partial failure after database insertion and retry duplication. Define transactions or durable event handling and idempotency. |

The findings are recorded without silently changing the sampled source. They are not evidence that each scenario has been exploited or reproduced.

## Review before publication

The five source files were read in full and checked for common API token patterns, private key headers, password-bearing connection strings, literal password assignments and email addresses. No matches were found by those checks. This is a limited review of the files actually published, not a claim that the entire private project or its history is free of secrets.

No customer records, recorded audio, transcripts, user database, access tokens, seed accounts, logs or environment files were selected.

## Priority before an organizational pilot

1. Close record-loss and approval-state gaps.
2. Validate AI output and enforce deterministic required-field and numeric checks.
3. Test denied roles, duplicate submissions, external-service failures and offline recovery.
4. Define retention, backup, restoration, cost limits and support ownership.
5. Measure quality, cost and adoption against a manual baseline.

This portfolio makes no claim of regulatory compliance, measured ROI or production readiness.
