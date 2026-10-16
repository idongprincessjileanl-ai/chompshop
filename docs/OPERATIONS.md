# Chomp Shop: Security, Hosting and Operations Guide

This guide covers the production requirements and where each one lives in the code.

> **Folder layout:** the API is in `backend/`, the website in `frontend/public/`. Paths below like `server.js`, `database/`, `scripts/`, `ai/`, `logs/`, `backups/` and `tests/` are inside `backend/`. Run every `npm` / `node` command from inside `backend/`.

| Requirement | Where it is |
|---|---|
| Database backend & storing data | MySQL `chompcart`, 22 tables (`database/01` to `11`) |
| Saved cart per customer | `cart_items` + `rls_cart_items` + `sp_cart_save` (`database/11`), `GET/PUT /api/me/cart` |
| AI fraud check (payments) | `ai/fraud.js` (logistic regression + rules), `payment_risk` table, Staff Portal → AI Fraud Check |
| Auth & permissions | `server.js` → *AUTH*; roles Customer, Rider, Inventory Staff, Admin |
| Rate limiting | `server.js` → *RATE LIMITING*; `docker/nginx.conf` (`limit_req`) |
| RLS enabled | `database/10_security_rls.sql` (functions, `rls_*` views, triggers, DB accounts) |
| RLS policies tied to the logged-in user ID | `app_user_id()` = the user ID from the login token, set on every query |
| Error tracking & logs | `logs/app-YYYY-MM-DD.log`, `error_log` and `audit_log` tables, Staff Portal → System |
| Recovery | Transactions, auto-restart, health checks, `npm run backup` / `npm run restore` |
| Cloud hosting | `backend/Dockerfile`, `docker-compose.yml` |
| Load balancing & scaling | `docker/nginx.conf` + `APP_REPLICAS` / `--scale app=N` |
| CI/CD | `.github/workflows/ci-cd.yml`, `tests/api.test.js` |

---

## 1. Run it on your laptop

1. Run the SQL files in this order: `01_02` → `03` → `04` → `05` → `06` → `08` → `09` → `10` → `11`.
   (`07` is the classroom demo; run it last, only when presenting.)
2. Copy `backend/.env.example` to `backend/.env` and fill in your MySQL password.
3. Install and start:
   ```
   cd backend
   npm install
   node server.js
   ```
4. Open `http://localhost:3001` (store) and `http://localhost:3001/staff.html` (staff portal).

### Demo accounts (password `chomp123`)

| Role | Email |
|---|---|
| Customer | `customer1@example.com` … `customer60@example.com` |
| Inventory Staff | `staff1@chompcart.example`, `staff2@chompcart.example` |
| Rider | `rider1@chompcart.example` … `rider5@chompcart.example` |
| Admin | `admin@chompcart.example` |

On first start the server replaces the placeholder passwords from the SQL files with a real bcrypt hash of `DEMO_PASSWORD`.

---

## 2. Auth and permissions

* Passwords are stored only as **bcrypt** hashes.
* `POST /api/auth/login` returns a **JWT** (valid `TOKEN_HOURS`, default 8) holding the user ID and role. The browser sends it as `Authorization: Bearer …`.
* **5 wrong passwords lock the account for 15 minutes** (`users.failed_logins`, `users.locked_until`).
* Every route checks the role:

| Who | Can do |
|---|---|
| Visitor | Browse products, search, suppliers, sign up, log in |
| Customer | Check out, see **own** orders and receipts, rate riders and products of **own** delivered orders |
| Rider | See and deliver **own** assigned orders (proof photo), see own ratings |
| Inventory Staff | Confirm payments, assign riders, cancel, reports, forecasts, suppliers |
| Admin | Everything above, plus System (logs, health) and the API tester |

The customer ID is never taken from the request: checkout always uses the logged-in user.

## 3. Rate limiting

| Limit | Value | Layer |
|---|---|---|
| All API calls | 300 per minute per IP (`RATE_LIMIT_PER_MIN`) | Express |
| Login | 10 per 15 minutes per IP | Express + nginx (10/min) |
| Sign-up | 5 per hour per IP | Express |
| Checkout | 10 per minute per IP | Express |
| Reviews / ratings | 30 per hour per IP | Express |
| Uploads | 30 per 10 minutes per IP | Express |
| All API calls through the load balancer | 20 per second per IP (burst 40) | nginx |

Responses include standard `RateLimit` headers; going over returns **HTTP 429**. With several app copies, nginx enforces one shared limit for all of them.

## 4. Row-Level Security (RLS) in MySQL

PostgreSQL has `CREATE POLICY`; MySQL does not. File `10_security_rls.sql` builds the same protection:

1. **Who is logged in.** For every request, the API runs `SET @app_user_id = <user id from the token>, @app_role = <role>` on the database connection, and clears it afterwards.
2. **Functions.** `app_user_id()`, `app_role()` and `app_is_staff()` read those values inside SQL.
3. **Policies (views).** Each `rls_*` view only returns rows the user may see:
   ```sql
   CREATE VIEW rls_orders AS
   SELECT o.* FROM orders o
   WHERE app_is_staff()                        -- staff: every order
      OR o.user_id = app_user_id()             -- customer: own orders
      OR (app_role() = 'Rider' AND EXISTS (...assigned to this rider...));
   ```
   Policies: `rls_orders`, `rls_order_items`, `rls_payments`, `rls_customer_addresses`, `rls_users`, `rls_deliveries`, `rls_driver_ratings`, `rls_my_reviews`.
4. **Write policies (triggers).** A customer cannot insert an order, review or rating for another user ID; a rider cannot update another rider's delivery.
5. **Database accounts.** `chomp_customer` (used for visitors and customers) can only `SELECT` the `rls_*` views and public catalog, `EXECUTE sp_place_order`, and insert reviews/ratings. It **cannot read `orders`, `users` or `payments` directly**, so even a bug in the API cannot leak another customer's data. `chomp_staff` can read/write data but cannot drop or alter tables.

Try it in MySQL Workbench:
```sql
SET @app_user_id = 4, @app_role = 'Customer';
SELECT COUNT(*), COUNT(DISTINCT user_id) FROM rls_orders;   -- only user 4
SET @app_user_id = NULL, @app_role = NULL;
SELECT COUNT(*) FROM rls_orders;                            -- 0 when not logged in
```

> Change the passwords of `chomp_customer` and `chomp_staff` in `10_security_rls.sql` and in `.env` before going live.

## 5. Logs, error tracking and recovery

* **Request log:** every API call is one JSON line (time, request ID, method, path, status, duration, user, IP) in the console and `logs/app-YYYY-MM-DD.log` (kept 14 days).
* **Request IDs:** every response has an `X-Request-Id` header; error messages show a short `ref` so a user can report it.
* **Error tracking:** server errors (5xx) are saved to the `error_log` table with the stack trace (not in production) and shown in **Staff Portal → System** (Admin).
* **Audit trail:** logins, failed logins, checkouts, status changes, shipping, deliveries, edits → `audit_log`.
* **Health check:** `GET /api/health` checks the database; Docker and nginx use it to skip broken copies.
* **Crash safety:** an uncaught error is logged and the process exits; Docker (`restart: unless-stopped`) or PM2 starts it again. `SIGTERM` finishes requests in progress before stopping (no dropped orders during deploys).
* **Data safety:** checkout and status changes run inside transactions (`sp_place_order`, `sp_update_order_status`), so a failure rolls everything back.

### Backups

* Laptop: `npm run backup` → `backups/chompcart-YYYY-MM-DD_HHMM.sql` (keeps the newest 14).
* Docker: the `backup` service saves one every 24 hours and keeps 7 days.

### Restore (disaster recovery)

```
npm run restore            # shows which backup will be used
npm run restore -- --yes   # replaces the database with the newest backup
npm run restore -- --yes backups/chompcart-2026-10-14_0200.sql
```
Then restart the server. Docker: `docker compose exec -T db mysql -uroot -p<password> < backups/<file>.sql`.

**Recovery checklist:** (1) check `/api/health` and Staff Portal → System; (2) read `logs/` or `docker compose logs app` for the request ID; (3) if data is damaged, restore the latest backup; (4) restart: `docker compose restart app`.

---

## 6. Cloud hosting, load balancing and scaling (Docker)

Works on any Linux cloud server (VM) with Docker installed.

```
cp backend/.env.example .env        # set DB_ROOT_PASSWORD, JWT_SECRET (long random text), passwords
docker compose up -d --build
```

What starts:

```
visitors ──► nginx (port 80, load balancer + rate limits)
                 ├──► app #1 ─┐
                 └──► app #2 ─┼──► MySQL (data volume)
backup (daily mysqldump) ─────┘
```

* **Load balancing:** nginx sends each request to the least busy app copy, skips copies that fail, and retries on another copy.
* **Scaling:** `docker compose up -d --scale app=4` then `docker compose restart nginx`. The app is stateless (login is a token, photos are on a shared volume), so any copy can serve any visitor.
* **Database:** the first start loads all SQL files automatically (`docker/initdb.sh`). For bigger traffic, move MySQL to a managed cloud database and point `DB_HOST` to it.
* **HTTPS:** put the server behind your cloud provider's load balancer or add a certificate (for example with Certbot) in front of nginx, then set `NODE_ENV=production`.

## 7. CI/CD (GitHub Actions)

`.github/workflows/ci-cd.yml` runs on every push and pull request:

1. **Test:** starts MySQL, loads files 01–10, starts the API, runs `tests/api.test.js` (health, login, permissions, **RLS: customer 2 cannot open customer 1's order**, rider isolation, checkout).
2. **Build:** on `main`, builds the Docker image and publishes it to `ghcr.io/<owner>/<repo>`.
3. **Deploy:** if the repository secret `DEPLOY_HOOK_URL` is set (from your hosting service), it triggers a deploy of the new image.

To use it: push the project to GitHub (the `.gitignore` keeps `.env`, logs and backups out), and the workflow runs by itself.

Run the same tests on your laptop while the server is running:
```
set BASE_URL=http://localhost:3001     (PowerShell: $env:BASE_URL="http://localhost:3001")
npm test
```
