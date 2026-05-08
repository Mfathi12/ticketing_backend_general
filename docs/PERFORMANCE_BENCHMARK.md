# Performance benchmark (repeatable)

## HTTP harness

From the backend repo (with a running API and valid JWT + company header):

```bash
cd d:/ticketing_backend_general-1
set BASE_URL=http://localhost:9091
set AUTH_TOKEN=<paste JWT>
set X_COMPANY_ID=<active company ObjectId>
set ITERATIONS=50
set CONCURRENCY=5
node scripts/performance-benchmark.js
```

The script prints **p50** / **p95** latency (ms) for:

- `GET /api/tickets/my-tickets`
- `GET /api/tickets/my-active-tickets`
- `GET /api/notifications` (page 1, limit 20)
- `GET /api/notifications/unread-count`

It also emits a JSON blob you can store as a before/after snapshot.

**Note:** Ticket CRUD benchmarks require a known `ticketId` and are best added to the same script once you have fixtures; the harness focuses on the heaviest list endpoints first.

## MongoDB `explain` (Atlas / mongosh)

After deploying indexes, validate plans for typical queries:

```javascript
// my-tickets style (adjust ObjectId strings)
db.tickets.find({ company: ObjectId("...") }).sort({ updatedAt: -1 }).limit(5).explain("executionStats");

// my-active-tickets style
db.tickets.find({
  company: ObjectId("..."),
  $and: [
    { $or: [{ handler: "user@example.com" }, { requested_to_email: "user@example.com" }] },
    { status: { $nin: ["resolved", "closed"] } }
  ]
}).explain("executionStats");

// notifications list
db.notifications.find({ user: ObjectId("..."), company: ObjectId("...") })
  .sort({ createdAt: -1 })
  .limit(20)
  .explain("executionStats");
```

Look for `winningPlan.inputStage.stage` / `IXSCAN` vs `COLLSCAN` and compare `executionStats.totalDocsExamined` before vs after index builds.

## Sample result slot (fill on each run)

| Run | Date | Dataset notes | my-tickets p50 | my-tickets p95 | my-active p50 | my-active p95 | notif list p50 | notif list p95 |
|-----|------|---------------|----------------|----------------|---------------|---------------|----------------|----------------|
| Before indexes | | | | | | | | |
| After indexes + batching | | | | | | | | |

## Local smoke (2026-05-08)

- `npm run perf:benchmark` without `AUTH_TOKEN` / `X_COMPANY_ID` exits with usage message (expected).
- Unit tests: `node --test tests/paymobSubscriptionPlanService.test.js` — pass.
- Full `node --test` may still pick up `scripts/subscription-e2e-test.js` (requires live MongoDB); scope unit tests to `tests/` when CI has no Atlas.
