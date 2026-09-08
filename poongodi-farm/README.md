# Poongodi Nature Farm

Full-stack family farm management system.

## Stack

- React + Vite frontend in `frontend/`
- Flask JSON API in `app.py`
- MySQL database in `database/farm_database.sql`
- Environment variables in `.env`

## Run

1. Create the database by importing `database/farm_database.sql` into MySQL.
2. Set the MySQL credentials and family login values in `.env`.
	For Google login, also set `FIREBASE_PROJECT_ID=prs-farms` and a comma-separated
	`GOOGLE_ALLOWED_EMAILS` list containing the authorized Google accounts.
3. Install backend packages:

```powershell
pip install -r requirements.txt
```

4. Start Flask:

```powershell
python app.py
```

5. In a second terminal, install and start React:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. During development, Vite proxies `/api` requests to Flask at `http://127.0.0.1:5000`. For a separately hosted API, add `VITE_API_URL` to `frontend/.env`.

## React pages

Dashboard, daily data entry, history with edit/delete, daily/weekly/monthly reports, profile/password management, admin family users, activity logs, responsive layout, and Tamil/English language toggle.
