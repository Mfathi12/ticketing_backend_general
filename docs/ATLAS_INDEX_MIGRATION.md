# Atlas index migration (latency phase)

New compound indexes are declared in Mongoose schemas (`schema.index(...)`). After deploying application code, **create the same indexes on your Atlas cluster** so existing databases pick them up.

## Option A — rely on Mongoose startup (dev / single deploy)

When the app connects, Mongoose will attempt to create indexes defined on schemas. Ensure the deployment user has `createIndex` permission on the target database.

## Option B — Atlas / mongosh (production recommended)

Run in `mongosh` against your database (replace `ticketing_db` if different):

```javascript
// Tickets
db.tickets.createIndex({ company: 1, project: 1 }, { name: "company_1_project_1" });
db.tickets.createIndex({ company: 1, status: 1 }, { name: "company_1_status_1" });
db.tickets.createIndex({ company: 1, handler: 1 }, { name: "company_1_handler_1" });
db.tickets.createIndex({ company: 1, requested_to_email: 1 }, { name: "company_1_requested_to_email_1" });
db.tickets.createIndex({ company: 1, updatedAt: -1 }, { name: "company_1_updatedAt_-1" });

// Notifications (keep existing { user: 1, createdAt: -1 } unless you drop it after validation)
db.notifications.createIndex(
  { user: 1, company: 1, read: 1, createdAt: -1 },
  { name: "user_1_company_1_read_1_createdAt_-1" }
);

// Users
db.users.createIndex({ "companies.company": 1 }, { name: "companies.company_1" });

// Projects
db.projects.createIndex({ company: 1, assigned_users: 1 }, { name: "company_1_assigned_users_1" });

// Chat — conversations (optional improvement for company-scoped participant queries)
db.conversations.createIndex({ company: 1, participants: 1 }, { name: "company_1_participants_1" });
```

## Verify

```javascript
db.tickets.getIndexes();
db.notifications.getIndexes();
```

Use `explain("executionStats")` on heavy `find` / `countDocuments` after build to confirm index use.

## Existing ticket unique index

The compound unique `{ ticket: 1, project: 1 }` must remain. If an old single-field unique on `ticket` still exists, run `npm run fix-indexes` or follow `scripts/fixTicketIndexes.js`.
