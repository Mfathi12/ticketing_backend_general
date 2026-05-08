# API contract snapshot (regression checklist)

This document inventories HTTP response shapes observed from `res.json(...)` / `res.status(...).json(...)` patterns in the backend. **Do not** change field names, nesting, array-vs-object semantics, or status codes for these routes without coordinated client updates.

## Global rules (forbidden without explicit contract bump)

- Do not rename or remove top-level JSON keys returned today.
- Do not change list endpoints from “full array” to paginated wrappers unless all clients ship together.
- Do not alter `401` / `403` / `404` message strings if clients match them literally (prefer additive fields only when allowed).
- Do not change `req.user` shape or JWT resolution behavior from `middleware/auth.js`.
- Subscription / Paymob routes: preserve `subscription` object keys where returned today.

## Tickets (`routes/ticketRoutes.js`)

| Method / path | Status | Body shape (indicative) |
|---------------|--------|-------------------------|
| `POST /add-ticket` | 201 | `{ message, ticket }` — `ticket` is hydrated ticket doc (media URLs, virtuals). |
| `PUT /edit-ticket/:ticketId` | 200 | `{ message, ticket }` |
| `POST /ticket/:ticketId/reply` | 201 | `{ message, reply }` — nested `userId` may be populated object with overridden `name`. |
| `GET /my-tickets` | 200 | `{ tickets }` — array of ticket objects **without** `images` key (stripped). |
| `GET /my-active-tickets` | 200 | `{ tickets, count }` |
| `GET /search/:ticketPattern` | 200 | `{ tickets }` |
| `GET /ticket/:ticketId/comments` | 200 | `{ ticket: { _id, ticket, project, status, priority }, comments, count }` |
| `GET /:ticketId` | 200 | `{ ticket }` hydrated |
| `GET /filter/status/:status` | 200 | `{ tickets }` hydrated |
| `GET /` (company all) | 200 | `{ tickets }` hydrated; 403 if not owner/admin/manager. |

**Forbidden:** Dropping `allComments` / virtual behavior where clients rely on it; changing `my-tickets` to omit fields other than `images` unless intentional and shipped everywhere.

## Notifications (`routes/notificationRoutes.js`)

| Method / path | Body |
|---------------|------|
| `GET /` | `{ notifications, pagination: { page, limit, total, pages }, unreadCount }` |
| `PATCH /read` | `{ message, modifiedCount }` |
| `PATCH /:id/read` | `{ notification }` (localized) |
| `GET /unread-count` | `{ unreadCount }` |

## Chat (`routes/chatRoutes.js`)

| Method / path | Notes |
|---------------|------|
| `POST /conversation` | `{ conversation }` with display names attached |
| Message send / file routes | `{ message }` — structure preserved with hydration |
| `GET /conversations` | `{ conversations }` |
| Others | See route file for `{ message }` / reaction payloads |

## Projects (`routes/projectRoutes.js`)

| Method / path | Body |
|---------------|------|
| List / detail | `{ projects }` or project-shaped objects with ticket counts as implemented today |
| Notes | `{ notes }`, `{ note }`, delete `{ message }` |

## Auth (`routes/authRoutes.js`)

Login / register / OTP / password reset: preserve `message` and token/user payloads as today; see grep `res.json` in file for exact keys.

## Subscription (`routes/subscriptionRoutes.js`)

- `GET /plans` → `{ plans }`
- `GET /me` → plan fields + `notice` nullable
- Paymob flows → `checkoutUrl`, `subscription` objects, `message` keys as today

## Platform admin, attendance, upload, users, version, landing

Snapshot rule: any route returning `res.json({ ... })` is contract-bound. Before changing, grep `res.json` in the relevant `routes/*.js` file and update clients or treat as breaking.

## Quick verification command

From repo root:

```bash
rg "res\\.json\\(" routes -g "*.js"
```

Use this list as the checklist before merging performance or refactor work.
