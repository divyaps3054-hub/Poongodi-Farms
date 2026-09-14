const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ||
  "141270882885-jtusd34ofr0pfpbro6udqqgol6gepfsp.apps.googleusercontent.com";
const FRONTEND_URL = process.env.FRONTEND_URL ||
  "https://divyaps3054-hub.github.io/Poongodi-Farms/";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const RECORDS_BACKUP_FILE = `${RECORDS_FILE}.bak`;
const ACCOUNTS_BACKUP_FILE = `${ACCOUNTS_FILE}.bak`;
const YEAR_ARCHIVE_DIR = path.join(DATA_DIR, "yearly-records");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(YEAR_ARCHIVE_DIR, { recursive: true });
if (!fs.existsSync(RECORDS_FILE) && !fs.existsSync(RECORDS_BACKUP_FILE)) {
  fs.writeFileSync(RECORDS_FILE, "[]", "utf8");
}
if (!fs.existsSync(ACCOUNTS_FILE) && !fs.existsSync(ACCOUNTS_BACKUP_FILE)) {
  fs.writeFileSync(ACCOUNTS_FILE, process.env.FARM_USERS || "[]", "utf8");
}

function readJsonWithBackup(filePath, backupPath, fallback) {
  for (const candidate of [filePath, backupPath]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch {
      // Try the backup before failing so a damaged primary file does not hide data.
    }
  }
  return fallback;
}

function readRecords() {
  const records = readJsonWithBackup(RECORDS_FILE, RECORDS_BACKUP_FILE, null);
  if (Array.isArray(records) && records.length > 0) return records;
  const archived = [];
  for (const file of fs.readdirSync(YEAR_ARCHIVE_DIR)) {
    if (!file.endsWith(".json")) continue;
    const yearRecords = readJsonWithBackup(path.join(YEAR_ARCHIVE_DIR, file), "", []);
    if (Array.isArray(yearRecords)) archived.push(...yearRecords);
  }
  return archived;
}

function writeRecords(records) {
  const content = JSON.stringify(records, null, 2);
  const tempFile = `${RECORDS_FILE}.tmp`;
  if (fs.existsSync(RECORDS_FILE)) fs.copyFileSync(RECORDS_FILE, RECORDS_BACKUP_FILE);
  fs.writeFileSync(tempFile, content, "utf8");
  fs.renameSync(tempFile, RECORDS_FILE);
  const recordsByYear = new Map();
  records.forEach((record) => {
    const year = String(record.date || record.createdAt || "").slice(0, 4);
    if (!/^\d{4}$/.test(year)) return;
    if (!recordsByYear.has(year)) recordsByYear.set(year, []);
    recordsByYear.get(year).push(record);
  });
  for (const [year, yearRecords] of recordsByYear) {
    fs.writeFileSync(
      path.join(YEAR_ARCHIVE_DIR, `${year}.json`),
      JSON.stringify(yearRecords, null, 2),
      "utf8"
    );
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  response.end(JSON.stringify(body));
}

function sendFile(response, filePath) {
  const contentType = filePath.endsWith(".html") ? "text/html; charset=utf-8" : "image/png";
  response.writeHead(200, { "Content-Type": contentType });
  response.end(fs.readFileSync(filePath));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body is too large"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || !record.date || !record.user) {
    return "date and user are required";
  }
  return null;
}

let accounts = readJsonWithBackup(ACCOUNTS_FILE, ACCOUNTS_BACKUP_FILE, []);
const sessions = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, expected] = storedHash.split(":");
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function createSession(account) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, account.user);
  return token;
}

function authenticatedUser(request) {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? sessions.get(header.slice(7)) : null;
}

async function notifyLogin(account, request) {
  if (!process.env.RESEND_API_KEY || !account.email) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.LOGIN_ALERT_FROM || "Poongodi Farms <onboarding@resend.dev>",
      to: [account.email],
      subject: `Farm login: ${account.user}`,
      text: `${account.user} signed in with ${account.email} from ${request.headers["user-agent"] || "unknown device"}.`,
    }),
  });
  if (!response.ok) console.error("Login notification failed:", await response.text());
}

function accountFor(user) {
  return accounts.find((account) => account.user === user);
}

function userCanEdit(user) {
  return ["Poongodi", "Sajindharan"].includes(user);
}

function saveAccounts() {
  const tempFile = `${ACCOUNTS_FILE}.tmp`;
  if (fs.existsSync(ACCOUNTS_FILE)) fs.copyFileSync(ACCOUNTS_FILE, ACCOUNTS_BACKUP_FILE);
  fs.writeFileSync(tempFile, JSON.stringify(accounts, null, 2), "utf8");
  fs.renameSync(tempFile, ACCOUNTS_FILE);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(request);
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const selectedUser = String(body.user || "").trim();
      if (!selectedUser || !email.includes("@") || password.length < 8) {
        return sendJson(response, 400, { error: "Select a user, enter a valid email, and use an 8-character password" });
      }
      let account = accounts.find((candidate) => candidate.user === selectedUser);
      if (!account) {
        account = { user: selectedUser, email, passwordHash: hashPassword(password), canEdit: ["Poongodi", "Sajindharan"].includes(selectedUser) };
        accounts.push(account);
        saveAccounts();
      }
      if (account.email.toLowerCase() !== email.toLowerCase() || !verifyPassword(password, account.passwordHash)) {
        return sendJson(response, 401, { error: "Invalid user, email, or password" });
      }
      const token = createSession(account);
      void notifyLogin(account, request);
      return sendJson(response, 200, {
        user: selectedUser,
        canEdit: userCanEdit(account.user),
        email,
        token,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/google/accounts") {
      return sendJson(response, 200, accounts.map(({ user, email, canEdit }) => ({ user, email, canEdit })));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/google") {
      const body = await readBody(request);
      const account = accountFor(body.user);
      if (!account) return sendJson(response, 401, { error: "Google account is not approved for this farm" });
      const token = createSession(account);
      void notifyLogin(account, request);
      return sendJson(response, 200, { user: account.user, canEdit: userCanEdit(account.user), email: account.email, token });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/google/token") {
      const body = await readBody(request);
      const tokenResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential || "")}`);
      if (!tokenResponse.ok) return sendJson(response, 401, { error: "Google credential could not be verified" });
      const profile = await tokenResponse.json();
      if (profile.aud !== GOOGLE_CLIENT_ID || profile.email_verified !== "true") {
        return sendJson(response, 401, { error: "Google account verification failed" });
      }
      const selectedUser = String(body.user || "").trim();
      let account = accounts.find((candidate) =>
        (candidate.googleEmail || candidate.email || "").toLowerCase() === String(profile.email).toLowerCase()
      );
      if (!account && selectedUser) {
        account = {
          user: selectedUser,
          email: profile.email,
          googleEmail: profile.email,
          canEdit: userCanEdit(selectedUser),
        };
        accounts.push(account);
        saveAccounts();
      }
      if (!account) return sendJson(response, 403, { error: "Select a family member before Google login" });
      const token = createSession(account);
      void notifyLogin(account, request);
      return sendJson(response, 200, { user: account.user, canEdit: userCanEdit(account.user), email: profile.email, token });
    }

    if (url.pathname === "/api/records" && request.method === "GET") {
      const user = authenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Login required" });
      return sendJson(response, 200, readRecords());
    }

    if (parts[0] === "api" && parts[1] === "records" && request.method === "POST") {
      const body = await readBody(request);
      const user = authenticatedUser(request);
      if (!["Poongodi", "Sajindharan"].includes(user)) return sendJson(response, 403, { error: "Only Poongodi or Sajindharan can add farm data" });
      if (body.user !== user) return sendJson(response, 403, { error: "User identity mismatch" });
      const validationError = validateRecord(body);
      if (validationError) return sendJson(response, 400, { error: validationError });
      const records = readRecords();
      const recordId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `record-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
      const record = { ...body, id: recordId, createdAt: new Date().toISOString() };
      records.push(record);
      writeRecords(records);
      return sendJson(response, 201, record);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "PUT") {
      const body = await readBody(request);
      if (!["Poongodi", "Sajindharan"].includes(authenticatedUser(request))) return sendJson(response, 403, { error: "Only Poongodi or Sajindharan can edit farm data" });
      const records = readRecords();
      const index = records.findIndex((record) => record.id === parts[2] && record.user === body.user);
      if (index < 0) return sendJson(response, 404, { error: "Record not found" });
      records[index] = { ...records[index], ...body, id: records[index].id };
      writeRecords(records);
      return sendJson(response, 200, records[index]);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "DELETE") {
      const user = url.searchParams.get("user");
      if (!["Poongodi", "Sajindharan"].includes(authenticatedUser(request))) return sendJson(response, 403, { error: "Only Poongodi or Sajindharan can delete farm data" });
      const records = readRecords();
      const nextRecords = records.filter((record) => !(record.id === parts[2] && record.user === user));
      if (nextRecords.length === records.length) return sendJson(response, 404, { error: "Record not found" });
      writeRecords(nextRecords);
      return sendJson(response, 204, {});
    }

    if (request.method === "GET") {
      if (url.pathname === "/" && request.headers.host && request.headers.host.includes("onrender.com")) {
        response.writeHead(302, { Location: FRONTEND_URL });
        return response.end();
      }
      const requestedFile = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = path.resolve(ROOT, requestedFile);
      if (filePath.startsWith(ROOT) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return sendFile(response, filePath);
      }
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Poongodi Farms is running at http://localhost:${PORT}`);
});
