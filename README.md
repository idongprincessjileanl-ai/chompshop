# Chom Shop

An e-commerce platform for electronics (Arduino, sensors, PC parts) with **demand forecasting**, an **AI fraud check** for payments, and a **staff portal** for orders, riders, and reports.

**Stack:** HTML/CSS/JavaScript (frontend) · Node.js + Express (backend API) · MySQL 8 (database) · Docker + nginx (hosting) · GitHub Actions (CI/CD)

---

## Project structure

```
chomshop/
├── frontend/                  ← what the visitor sees in the browser
│   └── public/
│       ├── index.html         online store (customers)
│       ├── staff.html         staff / rider / admin portal
│       ├── logo.jpg, logo-chip.png, logo-clear.png
│       └── images/
│           ├── withbackground.jpg
│           └── products/      product pictures (named after each product)
│
├── backend/                   ← the API server and database
│   ├── server.js              Express API (auth, shop, orders, reports, admin)
│   ├── ai/fraud.js            AI fraud check (logistic regression + rules)
│   ├── database/              MySQL scripts 01 → 11 (run in order)
│   ├── scripts/               backup, restore, run-sql, link-images
│   ├── tests/api.test.js      API + security tests
│   ├── package.json
│   ├── .env.example           copy to .env and fill in your passwords
│   └── Dockerfile
│
├── docker/                    nginx load balancer + DB init script
├── docker-compose.yml         runs everything with Docker
├── .github/workflows/         CI/CD (tests on every push)
├── docs/OPERATIONS.md         security, hosting and operations guide
└── archive/                   old "Skyline Market" files (not used by the app)
```

The backend serves the frontend. `server.js` serves `frontend/public/` as the website, so one command runs the whole thing.

---

## Run it on your laptop

**You need:** Node.js 18+ and MySQL 8.

1. **Create the database.** Run the files in `backend/database/` in this order (MySQL Workbench, or the helper below):
   `01_02` → `03` → `04` → `05` → `06` → `08` → `09` → `10` → `11`
   (`07_test_queries.sql` is the classroom demo. Run it last, only when presenting.)

2. **Set up your passwords:**
   ```bash
   cd backend
   copy .env.example .env      # Windows   (Mac/Linux: cp .env.example .env)
   ```
   Open `backend/.env` and set `DB_PASSWORD` and `JWT_SECRET`.

3. **Install and start:**
   ```bash
   npm install
   npm start
   ```

4. **Link the product pictures** (once, and again whenever you add pictures):
   ```bash
   npm run link-images
   ```

5. Open **http://localhost:3001** (store) and **http://localhost:3001/staff.html** (staff portal).

### Handy commands (run inside `backend/`)

| Command | What it does |
|---|---|
| `npm start` | Start the server |
| `npm run run-sql -- database/11_saved_cart_and_ai_fraud.sql` | Run a SQL file without Workbench |
| `npm run link-images` | Match pictures in `frontend/public/images/products/` to products |
| `npm run backup` / `npm run restore` | Back up / restore the database |
| `npm test` | Run the API tests (server must be running) |

### Demo accounts (password `chomp123`)

| Role | Email |
|---|---|
| Customer | `customer1@example.com` … `customer60@example.com` |
| Inventory Staff | `staff1@chompcart.example` |
| Rider | `rider1@chompcart.example` |
| Admin | `admin@chompcart.example` |

---

## Run with Docker

```bash
cp backend/.env.example .env      # set DB_ROOT_PASSWORD and JWT_SECRET
docker compose up -d --build
```
Opens on **http://localhost** (nginx load balancer → 2 app copies → MySQL).

---

## Features

- **Shop:** product catalog, search, "frequently bought together", personalized recommendations, saved cart, checkout (GCash, Maya, Card, COD)
- **Demand forecasting:** weighted moving average of the last 8 weeks, plus restock suggestions
- **AI fraud check:** every order gets a LOW / MEDIUM / HIGH risk score with plain-language reasons
- **Delivery:** riders, proof-of-delivery photos, rider and product ratings
- **Security:** JWT login, bcrypt passwords, account lockout, role permissions, rate limiting, row-level security in MySQL, audit and error logs

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the full security, hosting and recovery guide.
