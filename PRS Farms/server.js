const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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

const accounts = [
  { user: "Poongodi", email: "poongodi@poongodifarms.local", password: "poongodi123", canEdit: true },
  { user: "Prabakaran", email: "prabakaran@poongodifarms.local", password: "prabakaran123", canEdit: false },
  { user: "Rajindharan", email: "rajindharan@poongodifarms.local", password: "rajindharan123", canEdit: false },
  { user: "Sajindharan", email: "sajindharan@poongodifarms.local", password: "sajindharan123", canEdit: false },
];

function accountFor(user) {
  return accounts.find((account) => account.user === user);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(request);
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      if (!email || !password || !email.includes("@") || password.length < 6) {
        return sendJson(response, 401, { error: "Enter a valid email and a password with at least 6 characters" });
      }
      const account = accounts.find((candidate) => candidate.email === email);
      return sendJson(response, 200, {
        user: account ? account.user : "Poongodi",
        canEdit: account ? account.canEdit : true,
        email,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/google/accounts") {
      return sendJson(response, 200, accounts.map(({ user, email, canEdit }) => ({ user, email, canEdit })));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/google") {
      const body = await readBody(request);
      const account = accountFor(body.user);
      if (!account) return sendJson(response, 401, { error: "Google account is not approved for this farm" });
      return sendJson(response, 200, { user: account.user, canEdit: account.canEdit, email: account.email });
    }

    if (url.pathname === "/api/records" && request.method === "GET") {
      const user = url.searchParams.get("user");
      if (!user) return sendJson(response, 400, { error: "user is required" });
      return sendJson(response, 200, readRecords().filter((record) => record.user === user));
    }

    if (parts[0] === "api" && parts[1] === "records" && request.method === "POST") {
      const body = await readBody(request);
      const validationError = validateRecord(body);
      if (validationError) return sendJson(response, 400, { error: validationError });
      if (body.user !== "Poongodi") return sendJson(response, 403, { error: "Only Poongodi can add farm data" });
      const records = readRecords();
      const record = { ...body, id: randomUUID(), createdAt: new Date().toISOString() };
      records.push(record);
      writeRecords(records);
      return sendJson(response, 201, record);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "PUT") {
      const body = await readBody(request);
      if (body.user !== "Poongodi") return sendJson(response, 403, { error: "Only Poongodi can edit farm data" });
      const records = readRecords();
      const index = records.findIndex((record) => record.id === parts[2] && record.user === body.user);
      if (index < 0) return sendJson(response, 404, { error: "Record not found" });
      records[index] = { ...records[index], ...body, id: records[index].id };
      writeRecords(records);
      return sendJson(response, 200, records[index]);
    }

    if (parts[0] === "api" && parts[1] === "records" && parts[2] && request.method === "DELETE") {
      const user = url.searchParams.get("user");
      if (user !== "Poongodi") return sendJson(response, 403, { error: "Only Poongodi can delete farm data" });
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
