# Selected source files

These are source snapshots from Farm Voice Logger, selected for portfolio review on 2026-11-24. They were copied without functional changes. They retain dependencies from the original monorepo and do not run independently.

| Public path | Original path | What to inspect |
|---|---|---|
| `backend/routes/ai.ts` | `artifacts/api-server/src/routes/ai.ts` | Hebrew transcription, structured extraction and validation |
| `backend/middleware/auth.ts` | `artifacts/api-server/src/middleware/auth.ts` | JWT verification and role middleware |
| `backend/routes/records.ts` | `artifacts/api-server/src/routes/records.ts` | Record creation, approval and audit calls |
| `frontend/offlineQueue.ts` | `artifacts/farm-voice-logger/src/lib/offlineQueue.ts` | Local queue storage |
| `frontend/syncEngine.ts` | `artifacts/farm-voice-logger/src/lib/syncEngine.ts` | Retry behavior and synchronization events |

## Dependencies intentionally not included

- Express, jsonwebtoken, OpenAI SDK and Drizzle dependencies and package manifests.
- Workspace packages `@workspace/db`, `@workspace/api-zod`, `@workspace/api-client-react` and `@workspace/integrations-openai-ai-server`.
- Database schemas, generated API clients, server bootstrap and route mounting.
- Audit, operational event and analytics modules.
- The React application, deployment configuration and secrets.

No install/build command is supplied because those missing dependencies prevent this curated set from running as an application. The full project requires its own controlled development environment.

See [review notes](../docs/REVIEW_NOTES.md) for known limitations, including retry-related record loss, request-provided approval state and output validation. Source presence alone does not prove runtime behavior or complete enforcement of the intended workflow.

AI development tools assisted the original implementation; Idan Ben Hanan led process definition and the step-by-step build in the course project.
