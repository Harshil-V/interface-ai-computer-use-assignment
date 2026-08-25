# Mock Core Banking Console (Part A)

A local, mock "Core Banking Console" used as the automation target for Part B of the
assignment (see `docs/2026-08-13-computer-use-automation-notes.md` at the repo root for
the full rationale). It is a pure client-side Vite + React + TypeScript app: no backend,
no real bank systems, fixture data only.

## Running

From the **repo root**:

```bash
npm install
npm run dev
```

Or from this directory:

```bash
npm install
npm run dev
```

Vite prints a local URL (default `http://localhost:5173`). No server process or
environment variables are required.

## Screens

1. **Member lookup** — member ID input + submit. Results (found / not found / validation
   error) render inline below the form.
2. **Member detail** — savings balance for a found member, reachable from the lookup
   results table.
3. **Open sub-account** — multi-field form (account type, initial deposit, nickname) →
   an explicit **confirmation** step → a success screen. Treated as an irreversible
   action: nothing is "created" until the confirmation step is accepted.

There is intentionally no login screen — see "Session model" below.

## Built-in fixture cases

| Input | Expected behavior |
|---|---|
| Member ID `12345` | Found; savings balance `$1,240.55` |
| Member ID `67890` | Found; savings balance `$84,302.19` (second member, distinct balance shape) |
| Member ID `99999` | "No member found" (business outcome, not an error/crash) |
| Empty submission | Validation message "Member ID is required", no lookup performed |
| Idle session past timeout | "Session expired" state on member-detail / open-sub-account screens |

The two valid members exist so the same capability can be replayed against both: matching
outputs from different inputs is what shows `memberId` is a real parameter, not a value
captured from one recorded run.

## Session model (replaces login)

There is no auth screen. A lightweight in-memory session starts the moment the app
loads. Any click or keypress counts as activity and resets the idle clock. After
`SESSION_IDLE_TIMEOUT_MS` (`src/domain/session.ts`, default 5 minutes) with no activity,
the session is considered expired: the member-detail and open-sub-account screens (and
the sub-account confirmation step) render a distinct "session expired" state instead of
their normal content. This is deliberately different from "member not found" — it
represents the session lapsing, not a business lookup result.

Expiry is **sticky**: once a session has expired (however it expired), continued clicks
and keypresses keep resetting the idle clock but no longer un-expire it. The only way
back to an active session is clicking **"Start a new session"** on the expired notice.
Without stickiness the ambient activity listeners would revive the session on the very
next click — including a click on the expired notice itself — so no session-guarded
screen could ever be reached in the expired state, whether by a person or by automation.

Because waiting out a real idle timeout is impractical for demos and automation, there
are three ways to force expiry immediately:

1. **Dev tools panel** — an always-available `<details>` disclosure at the bottom of the
   page ("Dev tools (demo / automation only)") with a "Force expire session" button and
   a live "Session status: active/expired" readout.
2. **URL query param** — loading the app with `?forceExpireSession=1` starts the session
   already expired (useful for scripting a fresh page load straight into the expired
   state).
3. **`window.__forceExpireSession()`** — a function attached to `window` for Playwright
   (or any script) to call directly, for Part B automation that drives the page without
   clicking through the dev tools UI.

All three call the same underlying logic (`src/domain/session.ts`), which is unit
tested independently of React.

## Accessibility

Every interactive and status-bearing element uses semantic HTML/ARIA so it can be
located via the accessibility tree (the primary locator strategy the Part B automation
agent is expected to use):

- Inputs use `<label htmlFor>` associations; the select and text inputs all have
  accessible names.
- All actions are real `<button>` elements (never a `div`/`span` with a click handler).
- Search results render as a `<table>` with a `<caption>` and column headers.
- Validation errors, the "not found" outcome, and the "session expired" state all use
  `role="alert"` so they're programmatically detectable as soon as they appear.
- The sub-account creation success message uses `role="status"` (a non-urgent
  confirmation, not an error).

## Testing

Pure logic — fixture lookup, session idle-expiry, and sub-account form validation — was
built test-first with Vitest (`src/domain/*.test.ts`). Component rendering/layout is not
unit tested, per the project's narrow TDD scope.

```bash
npm run test        # run once
npm run test:watch  # watch mode
```

## Build

```bash
npm run build
```

Type-checks with `tsc -b` and produces a static `dist/` bundle via `vite build`.
