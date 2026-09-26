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
const SUPABASE_URL = String(
  process.env.SUPABASE_URL && process.env.SUPABASE_URL.startsWith("http")
    ? process.env.SUPABASE_URL
    : "https://tslrqgojisjqeyrnqdeg.supabase.co"
)
  .replace(/\/rest\/v1\/?$/, "")
  .replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  ""
)
  .trim()
  .replace(/^['"]|['"]$/g, "")
  .replace(/\/rest\/v1\/?$/, "");

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

function localReadRecords() {
  const records = readJsonWithBackup(RECORDS_FILE, RECORDS_BACKUP_FILE, null);
  const archived = [];
  for (const file of fs.readdirSync(YEAR_ARCHIVE_DIR)) {
    if (!file.endsWith(".json")) continue;
    const yearRecords = readJsonWithBackup(path.join(YEAR_ARCHIVE_DIR, file), "", []);
    if (Array.isArray(yearRecords)) archived.push(...yearRecords);
  }
  if (!Array.isArray(records)) return archived;
  if (records.length === 0 && archived.length > 0) return archived;
  return records;
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Supabase request failed:", response.status, details);
    throw new Error(`Supabase request failed (${response.status}): ${details.slice(0, 240)}`);
  }
  const responseText = await response.text();
  return responseText ? JSON.parse(responseText) : null;
}

async function readRecords() {
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const rows = await supabaseRequest("farm_records?select=record&order=record_date.asc");
    if (rows.length) return rows.map((row) => row.record);
    const legacyRecords = localReadRecords();
    if (legacyRecords.length) {
      await writeRecords(legacyRecords);
      return legacyRecords;
    }
    return [];
  }
  return localReadRecords();
}

async function writeRecords(records, changedRecord = null, deletedId = null) {
  const content = JSON.stringify(records, null, 2);
  const tempFile = `${RECORDS_FILE}.tmp`;
  fs.writeFileSync(tempFile, content, "utf8");
  fs.renameSync(tempFile, RECORDS_FILE);
  fs.copyFileSync(RECORDS_FILE, RECORDS_BACKUP_FILE);
  for (const file of fs.readdirSync(YEAR_ARCHIVE_DIR)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(YEAR_ARCHIVE_DIR, file));
  }
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
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    if (deletedId) {
      await supabaseRequest(`farm_records?id=eq.${encodeURIComponent(deletedId)}`, { method: "DELETE" });
    }
    if (changedRecord) {
      const databaseRecord = {
        ...changedRecord,
        updatedAt: normalizeRecordTimestamp(changedRecord.updatedAt),
      };
      await supabaseRequest("farm_records", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          id: changedRecord.id,
          record: databaseRecord,
          record_date: normalizeRecordDate(databaseRecord.date),
          user_name: databaseRecord.user,
          updated_at: databaseRecord.updatedAt,
        }),
      });
    } else if (!deletedId && records.length) {
      await supabaseRequest("farm_records", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(records.map((record) => {
          const databaseRecord = {
            ...record,
            updatedAt: normalizeRecordTimestamp(record.updatedAt),
          };
          return {
            id: databaseRecord.id,
            record: databaseRecord,
            record_date: normalizeRecordDate(databaseRecord.date),
            user_name: databaseRecord.user,
            updated_at: databaseRecord.updatedAt,
          };
        })),
      });
    }
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

function normalizeRecordDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return "";
}

function normalizeRecordTimestamp(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    return text;
  }
  return new Date().toISOString();
}

let accounts = readJsonWithBackup(ACCOUNTS_FILE, ACCOUNTS_BACKUP_FILE, []);
const sessions = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const hash = String(storedHash || "");
  const separator = hash.indexOf(":");
  if (separator < 1) return false;
  const salt = hash.slice(0, separator);
  const expectedHex = hash.slice(separator + 1);
  if (!/^(?:[a-f0-9]{2})+$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
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
  return Boolean(user && accountFor(user));
}

function saveAccounts() {
  const tempFile = `${ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(accounts, null, 2), "utf8");
  fs.renameSync(tempFile, ACCOUNTS_FILE);
  fs.copyFileSync(ACCOUNTS_FILE, ACCOUNTS_BACKUP_FILE);
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
      const selectedUser = "PRS";
      if (!email.includes("@") || password.length < 8) {
        return sendJson(response, 400, { error: "Enter a valid email and use an 8-character password" });
      }
      const matchingAccounts = accounts.filter((candidate) =>
        String(candidate.email || "").trim().toLowerCase() === email.toLowerCase()
      );
      if (!matchingAccounts.length) {
        return sendJson(response, 401, { error: "Invalid user, email, or password" });
      }
      const account = matchingAccounts.find((candidate) =>
        candidate.passwordHash && verifyPassword(password, candidate.passwordHash)
      );
      if (!account) {
        const hasPassword = matchingAccounts.some((candidate) => candidate.passwordHash);
        return sendJson(response, 401, {
          error: hasPassword
            ? "Invalid user, email, or password"
            : "No email/password password is set for this account. Use Google sign-in or contact the farm administrator to set one.",
        });
      }
      account.user = selectedUser;
      account.canEdit = true;
      saveAccounts();
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
      return sendJson(response, 401, { error: "Use verified Google sign-in to authenticate" });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/google/token") {
      const body = await readBody(request);
      const tokenResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential || "")}`);
      if (!tokenResponse.ok) return sendJson(response, 401, { error: "Google credential could not be verified" });
      const profile = await tokenResponse.json();
      if (profile.aud !== GOOGLE_CLIENT_ID || profile.email_verified !== "true") {
        return sendJson(response, 401, { error: "Google account verification failed" });
      }
      const selectedUser = "PRS";
      let account = accounts.find((candidate) =>
        (candidate.googleEmail || candidate.email || "").toLowerCase() === String(profile.email).toLowerCase()
      );
      if (account) {
        account.user = "PRS";
        account.canEdit = true;
        saveAccounts();
      }
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
      if (!account) return sendJson(response, 403, { error: "Google account could not be registered" });
      const token = createSession(account);
      void notifyLogin(account, request);
      return sendJson(response, 200, { user: account.user, canEdit: userCanEdit(account.user), email: profile.email, token });
    }

    if (url.pathname === "/api/records" && request.method === "GET") {
      const user = authenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Login required" });
      return sendJson(response, 200, await readRecords());
    }

    if (parts[0] === "api" && parts[1] === "records" && request.method === "POST") {
      const body = await readBody(request);
      const user = authenticatedUser(request);
      if (!user || !accountFor(user)) return sendJson(response, 403, { error: "Login required to add farm data" });
      body.user = user;
      const validationError = validateRecord(body);
      if (validationError) return sendJson(response, 400, { error: validationError });
      const records = await readRecords();
      const recordId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `record-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
      const normalizedDate = normalizeRecordDate(body.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
        return sendJson(response, 400, { error: "Date must be in YYYY-MM-DD format" });
      }
      const record = {
        ...body,
        date: normalizedDate,
        id: recordId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      records.push(record);
      await writeRecords(records, record);
      return sendJson(response, 201, record);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "PUT") {
      const body = await readBody(request);
      const authenticated = authenticatedUser(request);
      if (!authenticated || !accountFor(authenticated)) return sendJson(response, 403, { error: "Login required to edit farm data" });
      const records = await readRecords();
      const index = records.findIndex((record) => record.id === parts[2]);
      if (index < 0) return sendJson(response, 404, { error: "Record not found" });
      const normalizedDate = normalizeRecordDate(body.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
        return sendJson(response, 400, { error: "Date must be in YYYY-MM-DD format" });
      }
      records[index] = {
        ...records[index],
        ...body,
        date: normalizedDate,
        id: records[index].id,
        updatedAt: new Date().toISOString(),
      };
      await writeRecords(records, records[index]);
      return sendJson(response, 200, records[index]);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "DELETE") {
      const user = url.searchParams.get("user");
      const authenticated = authenticatedUser(request);
      if (!authenticated || !accountFor(authenticated)) return sendJson(response, 403, { error: "Login required to delete farm data" });
      const records = await readRecords();
      const nextRecords = records.filter((record) => record.id !== parts[2]);
      if (nextRecords.length === records.length) return sendJson(response, 404, { error: "Record not found" });
      await writeRecords(nextRecords, null, parts[2]);
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
