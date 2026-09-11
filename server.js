const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RECORDS_FILE)) fs.writeFileSync(RECORDS_FILE, "[]", "utf8");

function readRecords() {
  return JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8"));
}

function writeRecords(records) {
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2), "utf8");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

const accounts = JSON.parse(process.env.FARM_USERS || "[]");
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
  if (!process.env.RESEND_API_KEY || !process.env.LOGIN_ALERT_TO) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.LOGIN_ALERT_FROM || "Poongodi Farms <onboarding@resend.dev>",
      to: [process.env.LOGIN_ALERT_TO],
      subject: `Farm login: ${account.user}`,
      text: `${account.user} signed in with ${account.email} from ${request.headers["user-agent"] || "unknown device"}.`,
    }),
  });
  if (!response.ok) console.error("Login notification failed:", await response.text());
}

function accountFor(user) {
  return accounts.find((account) => account.user === user);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(request);
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const selectedUser = String(body.user || "").trim();
      const account = accounts.find((candidate) => candidate.user === selectedUser && candidate.email.toLowerCase() === email.toLowerCase());
      if (!account || !verifyPassword(password, account.passwordHash)) {
        return sendJson(response, 401, { error: "Invalid user, email, or password" });
      }
      const token = createSession(account);
      void notifyLogin(account, request);
      return sendJson(response, 200, {
        user: selectedUser,
        canEdit: Boolean(account.canEdit),
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
      return sendJson(response, 200, { user: account.user, canEdit: account.canEdit, email: account.email, token });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/google/token") {
      const body = await readBody(request);
      if (!process.env.GOOGLE_CLIENT_ID) return sendJson(response, 503, { error: "Google login is not configured on the backend" });
      const tokenResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential || "")}`);
      if (!tokenResponse.ok) return sendJson(response, 401, { error: "Google credential could not be verified" });
      const profile = await tokenResponse.json();
      if (profile.aud !== process.env.GOOGLE_CLIENT_ID || profile.email_verified !== "true") {
        return sendJson(response, 401, { error: "Google account verification failed" });
      }
      const account = accounts.find((candidate) =>
        (candidate.googleEmail || candidate.email || "").toLowerCase() === String(profile.email).toLowerCase()
      );
      if (!account) return sendJson(response, 403, { error: "This Google account is not approved for the farm" });
      const token = createSession(account);
      void notifyLogin(account, request);
      return sendJson(response, 200, { user: account.user, canEdit: account.canEdit, email: profile.email, token });
    }

    if (url.pathname === "/api/records" && request.method === "GET") {
      const user = authenticatedUser(request);
      if (!user) return sendJson(response, 401, { error: "Login required" });
      return sendJson(response, 200, readRecords());
    }

    if (parts[0] === "api" && parts[1] === "records" && request.method === "POST") {
      const body = await readBody(request);
      const user = authenticatedUser(request);
      if (user !== "Poongodi") return sendJson(response, 403, { error: "Only Poongodi can add farm data" });
      if (body.user !== user) return sendJson(response, 403, { error: "User identity mismatch" });
      const validationError = validateRecord(body);
      if (validationError) return sendJson(response, 400, { error: validationError });
      const records = readRecords();
      const record = { ...body, id: randomUUID(), createdAt: new Date().toISOString() };
      records.push(record);
      writeRecords(records);
      return sendJson(response, 201, record);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "PUT") {
      const body = await readBody(request);
      if (authenticatedUser(request) !== "Poongodi") return sendJson(response, 403, { error: "Only Poongodi can edit farm data" });
      const records = readRecords();
      const index = records.findIndex((record) => record.id === parts[2] && record.user === body.user);
      if (index < 0) return sendJson(response, 404, { error: "Record not found" });
      records[index] = { ...records[index], ...body, id: records[index].id };
      writeRecords(records);
      return sendJson(response, 200, records[index]);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "DELETE") {
      const user = url.searchParams.get("user");
      if (authenticatedUser(request) !== "Poongodi") return sendJson(response, 403, { error: "Only Poongodi can delete farm data" });
      const records = readRecords();
      const nextRecords = records.filter((record) => !(record.id === parts[2] && record.user === user));
      if (nextRecords.length === records.length) return sendJson(response, 404, { error: "Record not found" });
      writeRecords(nextRecords);
      return sendJson(response, 204, {});
    }

    if (request.method === "GET") {
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
