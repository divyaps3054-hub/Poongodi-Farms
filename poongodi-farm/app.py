import os
import json
from urllib.parse import urlencode
from urllib.request import urlopen
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from functools import wraps

import mysql.connector
from dotenv import load_dotenv
from flask import Flask, flash, jsonify, redirect, render_template, request, session, url_for
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()
app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "change-this-secret-key")
CORS(app, supports_credentials=True, origins=os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").split(","))


@app.errorhandler(mysql.connector.Error)
def handle_database_error(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Database connection failed. Update DB_PASSWORD in poongodi-farm/.env and restart Flask."}), 503
    raise error


def db():
    return mysql.connector.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "poongodi_farm"),
    )


def query(sql, params=(), one=False, commit=False):
    connection = db()
    cursor = connection.cursor(dictionary=True)
    try:
        cursor.execute(sql, params)
        result = cursor.fetchone() if one else cursor.fetchall()
        if commit:
            connection.commit()
        return result
    finally:
        cursor.close()
        connection.close()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if session.get("role") != "admin":
            flash("Admin access required.", "error")
            return redirect(url_for("dashboard"))
        return view(*args, **kwargs)
    return wrapped


def number(value, default=Decimal("0")):
    try:
        return Decimal(str(value or default))
    except (InvalidOperation, ValueError):
        return default


def activity(action):
    query("INSERT INTO activity_logs (user_id, action) VALUES (%s, %s)", (session["user_id"], action), commit=True)


def record_values(form):
    values = {
        "record_date": form.get("record_date") or date.today().isoformat(),
        "quail_available": number(form.get("quail_available")),
        "quail_price": number(form.get("quail_price")),
        "quail_sold": number(form.get("quail_sold")),
        "nattu_available": number(form.get("nattu_available")),
        "nattu_price": number(form.get("nattu_price")),
        "nattu_sold": number(form.get("nattu_sold")),
        "meat_available": number(form.get("meat_available")),
        "meat_price": number(form.get("meat_price")),
        "meat_sold": number(form.get("meat_sold")),
        "mortality": number(form.get("mortality")),
        "medicine": number(form.get("medicine")),
        "tray_stickers": number(form.get("tray_stickers")),
        "expenses": number(form.get("expenses")),
        "notes": form.get("notes", "").strip(),
    }
    for key in ("quail_available", "quail_price", "quail_sold", "nattu_available", "nattu_price", "nattu_sold", "meat_available", "meat_price", "meat_sold", "mortality", "medicine", "tray_stickers", "expenses"):
        if values[key] < 0:
            raise ValueError("Negative values are not allowed.")
    if values["quail_sold"] > values["quail_available"] or values["nattu_sold"] > values["nattu_available"] or values["meat_sold"] > values["meat_available"]:
        raise ValueError("Sold quantity cannot exceed available stock.")
    return values


def totals(rows):
    result = {"quail_sold": 0, "nattu_sold": 0, "meat_sold": 0, "sales": 0, "expenses": 0}
    for row in rows:
        result["quail_sold"] += float(row["quail_sold"])
        result["nattu_sold"] += float(row["nattu_sold"])
        result["meat_sold"] += float(row["meat_sold"])
        result["sales"] += float(row["quail_sales"] + row["nattu_sales"] + row["meat_sales"])
        result["expenses"] += float(row["expenses"] + row.get("medicine", 0) + row.get("tray_stickers", 0))
    result["net"] = result["sales"] - result["expenses"]
    return result


def api_user():
    if not session.get("user_id"):
        return None
    return {"id": session["user_id"], "name": session["name"], "email": session["email"], "role": session["role"]}


@app.get("/api/session")
def api_session():
    return jsonify({"user": api_user()})


@app.get("/api/profiles")
def api_profiles():
    return jsonify({"profiles": query("SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name")})


@app.post("/api/login")
def api_login():
    payload = request.get_json(silent=True) or {}
    email = payload.get("email", "").strip().lower()
    password = payload.get("password", "")
    profile_id = payload.get("profile_id")
    user = query("SELECT * FROM users WHERE email = %s AND is_active = 1", (email,), one=True)
    common_email = os.getenv("FAMILY_EMAIL", "family@poongodifarm.local").lower()
    valid = user and check_password_hash(user["password_hash"], password)
    if email == common_email and password == os.getenv("FAMILY_PASSWORD", "change-me"):
        user = query("SELECT * FROM users WHERE id = %s AND is_active = 1", (profile_id,), one=True) if profile_id else query("SELECT * FROM users WHERE is_active = 1 ORDER BY id LIMIT 1", one=True)
        valid = bool(user)
    if not valid:
        return jsonify({"error": "Invalid family login details."}), 401
    session.update(user_id=user["id"], name=user["name"], role=user["role"], email=user["email"])
    activity("logged in")
    return jsonify({"user": api_user()})


@app.post("/api/login/google")
def api_google_login():
    payload = request.get_json(silent=True) or {}
    token = payload.get("id_token", "")
    profile_id = payload.get("profile_id")
    if not token:
        return jsonify({"error": "Google ID token is required."}), 400
    try:
        query_string = urlencode({"id_token": token}).encode()
        with urlopen("https://oauth2.googleapis.com/tokeninfo", data=query_string, timeout=8) as response:
            token_info = json.load(response)
        allowed_emails = {email.strip().lower() for email in os.getenv("GOOGLE_ALLOWED_EMAILS", "").split(",") if email.strip()}
        email = token_info.get("email", "").lower()
        if token_info.get("aud") != os.getenv("FIREBASE_PROJECT_ID", "prs-farms") or token_info.get("email_verified") != "true":
            return jsonify({"error": "Google account verification failed."}), 401
        if not allowed_emails:
            return jsonify({"error": "GOOGLE_ALLOWED_EMAILS is not configured."}), 503
        if email not in allowed_emails:
            return jsonify({"error": "This Google account is not authorized for the farm."}), 403
        user = query("SELECT * FROM users WHERE email=%s AND is_active=1", (email,), one=True)
        if not user and profile_id:
            user = query("SELECT * FROM users WHERE id=%s AND is_active=1", (profile_id,), one=True)
        if not user:
            return jsonify({"error": "No matching family profile was found."}), 403
        session.update(user_id=user["id"], name=user["name"], role=user["role"], email=user["email"])
        activity("logged in with Google")
        return jsonify({"user": api_user()})
    except Exception:
        return jsonify({"error": "Google login verification is unavailable."}), 502


@app.post("/api/logout")
def api_logout():
    if session.get("user_id"):
        activity("logged out")
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/dashboard")
@login_required
def api_dashboard():
    rows = query("SELECT * FROM daily_records WHERE record_date = %s ORDER BY id DESC", (date.today(),))
    history = query("SELECT r.*, u.name AS updated_by_name FROM daily_records r JOIN users u ON u.id = r.updated_by ORDER BY record_date DESC, id DESC LIMIT 50")
    stock = rows[0] if rows else {"quail_available": 0, "quail_sold": 0, "nattu_available": 0, "nattu_sold": 0, "meat_available": 0, "meat_sold": 0}
    return jsonify({"today": totals(rows), "stock": stock, "history": history})


@app.get("/api/records")
@login_required
def api_records():
    return jsonify(query("SELECT r.*, u.name AS updated_by_name FROM daily_records r JOIN users u ON u.id = r.updated_by ORDER BY record_date DESC, id DESC LIMIT 100"))


@app.post("/api/records")
@login_required
def api_create_record():
    try:
        values = record_values(request.get_json(silent=True) or {})
        query("""INSERT INTO daily_records (record_date, quail_available, quail_price, quail_sold, nattu_available,
            nattu_price, nattu_sold, meat_available, meat_price, meat_sold, mortality, medicine, tray_stickers, expenses, notes, updated_by)
            VALUES (%(record_date)s, %(quail_available)s, %(quail_price)s, %(quail_sold)s, %(nattu_available)s,
            %(nattu_price)s, %(nattu_sold)s, %(meat_available)s, %(meat_price)s, %(meat_sold)s, %(mortality)s, %(medicine)s, %(tray_stickers)s, %(expenses)s,
            %(notes)s, %(updated_by)s)""", {**values, "updated_by": session["user_id"]}, commit=True)
        activity("added a daily record")
        record_id = query("SELECT id FROM daily_records WHERE updated_by=%s ORDER BY id DESC LIMIT 1", (session["user_id"],), one=True)["id"]
        return jsonify({"ok": True, "id": record_id}), 201
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.put("/api/records/<int:record_id>")
@login_required
def api_update_record(record_id):
    try:
        values = record_values(request.get_json(silent=True) or {})
        values.update({"updated_by": session["user_id"], "id": record_id})
        query("""UPDATE daily_records SET record_date=%(record_date)s, quail_available=%(quail_available)s,
            quail_price=%(quail_price)s, quail_sold=%(quail_sold)s, nattu_available=%(nattu_available)s,
            nattu_price=%(nattu_price)s, nattu_sold=%(nattu_sold)s, meat_available=%(meat_available)s,
            meat_price=%(meat_price)s, meat_sold=%(meat_sold)s, mortality=%(mortality)s, medicine=%(medicine)s,
            tray_stickers=%(tray_stickers)s, expenses=%(expenses)s, notes=%(notes)s,
            updated_by=%(updated_by)s, updated_at=NOW() WHERE id=%(id)s""", values, commit=True)
        activity("edited a sales record")
        return jsonify({"ok": True, "id": record_id})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.delete("/api/records/<int:record_id>")
@login_required
def api_delete_record(record_id):
    query("DELETE FROM daily_records WHERE id = %s", (record_id,), commit=True)
    activity("deleted a sales record")
    return jsonify({"ok": True})


@app.get("/api/reports")
@login_required
def api_reports():
    period = request.args.get("period", "daily")
    today = date.today()
    start = today if period == "daily" else today - timedelta(days=6 if period == "weekly" else 29)
    return jsonify({"period": period, "report": totals(query("SELECT * FROM daily_records WHERE record_date BETWEEN %s AND %s", (start, today)))})


@app.get("/api/profile")
@login_required
def api_profile():
    return jsonify({"user": query("SELECT id, name, email, profile_photo, role FROM users WHERE id=%s", (session["user_id"],), one=True)})


@app.put("/api/profile")
@login_required
def api_update_profile():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or session["name"]).strip()
    profile_image = payload.get("profileImage")
    if not name:
        return jsonify({"error": "Name is required."}), 400
    if profile_image is not None and not isinstance(profile_image, str):
        return jsonify({"error": "Profile image must be a string."}), 400
    query("UPDATE users SET name=%s, profile_photo=%s WHERE id=%s", (name, profile_image, session["user_id"]), commit=True)
    session["name"] = name
    return jsonify({"user": query("SELECT id, name, email, profile_photo, role FROM users WHERE id=%s", (session["user_id"],), one=True)})


@app.post("/api/profile/upload")
@login_required
def api_upload_profile():
    return api_update_profile()


@app.put("/api/profile/password")
@login_required
def api_change_password():
    password = (request.get_json(silent=True) or {}).get("password", "")
    if len(password) < 6:
        return jsonify({"error": "Password must contain at least 6 characters."}), 400
    query("UPDATE users SET password_hash=%s WHERE id=%s", (generate_password_hash(password), session["user_id"]), commit=True)
    activity("changed password")
    return jsonify({"ok": True})


@app.get("/api/admin")
@login_required
@admin_required
def api_admin():
    return jsonify({
        "members": query("SELECT id, name, email, role, is_active, created_at FROM users ORDER BY name"),
        "logs": query("SELECT a.*, u.name FROM activity_logs a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100"),
    })


@app.post("/api/admin/users")
@login_required
@admin_required
def api_add_user():
    payload = request.get_json(silent=True) or {}
    if not payload.get("name") or not payload.get("email") or len(payload.get("password", "")) < 6:
        return jsonify({"error": "Name, email and a 6-character password are required."}), 400
    query("INSERT INTO users (name, email, password_hash, role) VALUES (%s,%s,%s,%s)", (payload["name"], payload["email"].lower(), generate_password_hash(payload["password"]), payload.get("role", "member")), commit=True)
    activity("added a family member")
    return jsonify({"ok": True}), 201


@app.route("/", methods=["GET"])
@login_required
def dashboard():
    today_rows = query("SELECT * FROM daily_records WHERE record_date = %s ORDER BY id DESC", (date.today(),))
    history = query("SELECT r.*, u.name AS updated_by_name FROM daily_records r JOIN users u ON u.id = r.updated_by ORDER BY record_date DESC, id DESC LIMIT 20")
    today = totals(today_rows)
    stock = today_rows[0] if today_rows else {"quail_available": 0, "quail_sold": 0, "nattu_available": 0, "nattu_sold": 0, "meat_available": 0, "meat_sold": 0}
    return render_template("index.html", today=today, stock=stock, history=history, active="dashboard")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user = query("SELECT * FROM users WHERE email = %s AND is_active = 1", (email,), one=True)
        common_email = os.getenv("FAMILY_EMAIL", "family@poongodifarm.local").lower()
        common_password = os.getenv("FAMILY_PASSWORD", "change-me")
        valid = user and check_password_hash(user["password_hash"], password)
        if email == common_email and password == common_password:
            selected_id = request.form.get("profile_id")
            user = query("SELECT * FROM users WHERE id = %s AND is_active = 1", (selected_id,), one=True) if selected_id else query("SELECT * FROM users WHERE is_active = 1 ORDER BY id LIMIT 1", one=True)
            valid = bool(user)
        if valid:
            session.update(user_id=user["id"], name=user["name"], role=user["role"], email=user["email"])
            activity("logged in")
            return redirect(url_for("dashboard"))
        flash("Invalid family login details.", "error")
    profiles = query("SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name")
    return render_template("login.html", profiles=profiles)


@app.route("/logout")
def logout():
    if session.get("user_id"):
        activity("logged out")
    session.clear()
    return redirect(url_for("login"))


@app.route("/records/new", methods=["GET", "POST"])
@login_required
def new_record():
    if request.method == "POST":
        try:
            values = record_values(request.form)
            query("""INSERT INTO daily_records
                (record_date, quail_available, quail_price, quail_sold, nattu_available, nattu_price, nattu_sold,
                 meat_available, meat_price, meat_sold, expenses, notes, updated_by)
                VALUES (%(record_date)s, %(quail_available)s, %(quail_price)s, %(quail_sold)s, %(nattu_available)s,
                 %(nattu_price)s, %(nattu_sold)s, %(meat_available)s, %(meat_price)s, %(meat_sold)s,
                 %(expenses)s, %(notes)s, %(updated_by)s)""", {**values, "updated_by": session["user_id"]}, commit=True)
            activity("added a daily record")
            flash("Daily record saved.", "success")
            return redirect(url_for("dashboard"))
        except (ValueError, mysql.connector.Error) as error:
            flash(str(error), "error")
    return render_template("index.html", form_mode="new", active="entry")


@app.route("/records/<int:record_id>/edit", methods=["GET", "POST"])
@login_required
def edit_record(record_id):
    record = query("SELECT * FROM daily_records WHERE id = %s", (record_id,), one=True)
    if not record:
        return redirect(url_for("dashboard"))
    if request.method == "POST":
        try:
            values = record_values(request.form)
            query("""UPDATE daily_records SET record_date=%(record_date)s, quail_available=%(quail_available)s, quail_price=%(quail_price)s,
                quail_sold=%(quail_sold)s, nattu_available=%(nattu_available)s, nattu_price=%(nattu_price)s, nattu_sold=%(nattu_sold)s,
                meat_available=%(meat_available)s, meat_price=%(meat_price)s, meat_sold=%(meat_sold)s, expenses=%(expenses)s,
                notes=%(notes)s, updated_by=%(updated_by)s, updated_at=NOW() WHERE id=%(id)s""", {**values, "updated_by": session["user_id"], "id": record_id}, commit=True)
            activity("edited a sales record")
            flash("Record updated.", "success")
            return redirect(url_for("dashboard"))
        except (ValueError, mysql.connector.Error) as error:
            flash(str(error), "error")
    return render_template("index.html", form_mode="edit", record=record, active="entry")


@app.post("/records/<int:record_id>/delete")
@login_required
def delete_record(record_id):
    query("DELETE FROM daily_records WHERE id = %s", (record_id,), commit=True)
    activity("deleted a sales record")
    flash("Record deleted.", "success")
    return redirect(url_for("dashboard"))


@app.route("/reports")
@login_required
def reports():
    period = request.args.get("period", "daily")
    today = date.today()
    start = today if period == "daily" else today - timedelta(days=6 if period == "weekly" else 29)
    rows = query("SELECT * FROM daily_records WHERE record_date BETWEEN %s AND %s", (start, today))
    return render_template("index.html", report=totals(rows), period=period, active="reports")


@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    if request.method == "POST":
        new_password = request.form.get("password", "")
        if len(new_password) < 6:
            flash("Password must contain at least 6 characters.", "error")
        else:
            query("UPDATE users SET password_hash=%s WHERE id=%s", (generate_password_hash(new_password), session["user_id"]), commit=True)
            activity("changed password")
            flash("Password changed.", "success")
    user = query("SELECT * FROM users WHERE id=%s", (session["user_id"],), one=True)
    return render_template("profile.html", user=user)


@app.route("/admin/users", methods=["GET", "POST"])
@login_required
@admin_required
def users():
    if request.method == "POST":
        password = request.form.get("password", "")
        query("INSERT INTO users (name, email, password_hash, role) VALUES (%s,%s,%s,%s)", (request.form["name"], request.form["email"].lower(), generate_password_hash(password), request.form.get("role", "member")), commit=True)
        activity("added a family member")
        flash("Family member added.", "success")
    members = query("SELECT id, name, email, role, is_active, created_at FROM users ORDER BY name")
    logs = query("SELECT a.*, u.name FROM activity_logs a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 50")
    return render_template("index.html", members=members, logs=logs, active="admin")


@app.context_processor
def globals_for_templates():
    return {"current_year": datetime.now().year}


if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG", "1") == "1")
