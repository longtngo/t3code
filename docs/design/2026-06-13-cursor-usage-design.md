# Cursor account usage — design

**Date:** 2026-06-13  
**Status:** Implemented on `feat/cursor-usage-ui`

## Goal

Show Cursor account usage in the branch toolbar with labels and metrics that match what Cursor's dashboard API actually provides — not Claude's 5h/7d/extra windows.

## Approach

1. **Server:** Poll Cursor's internal dashboard API (`GetCurrentPeriodUsage` on `api2.cursor.sh`), with enterprise fallback (`GET /auth/usage`). Resolve auth from env → CLI keychain → Cursor Desktop SQLite. Mirror Claude adapter's background poller + on-demand refresh.
2. **Contract:** Extend `AccountUsageUpdatedPayload` with optional `cursor` block (`auto`, `api`, `total`, `onDemand`, `onDemandScope`, `requests`). Claude payloads omit `cursor`; backward compatible.
3. **Web:** Refactor usage projection to a segment list. Claude keeps 5h/7d/extra + pace markers. Cursor renders api/plan/pool/reqs with billing-cycle reset copy and no pace (billing cycles are not fixed 5h/7d windows).

## Alternatives considered

| Alternative                                    | Rejection                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Map Cursor into Claude 5h/7d slots             | Misleading labels; rejected after UI adaptation task             |
| Provider-specific UI only (no contract change) | Can't carry structured Cursor fields through activities reliably |
| Browser session cookie auth                    | Unavailable to Node server; community pattern uses local JWT     |

## Tradeoffs

- Cursor API is undocumented and may change.
- Auto usage at 0% is hidden in UI (only non-zero detail segments shown).
- Pace comparison disabled for Cursor (no meaningful fixed window length).

## Follow-ups deferred

- Mobile usage meter (web-only today).
- Live token refresh persistence back to keychain/SQLite (read-only poll today).
