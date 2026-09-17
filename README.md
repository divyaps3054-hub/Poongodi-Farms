# Poongodi Natural Farm

Full-stack farm management app with a browser frontend and a Node.js backend. Daily records are stored in `data/records.json` and are separated by family member.

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run `npm start`.
4. Open <http://localhost:3000>.

No database package or build step is required. The server creates the `data/records.json` file automatically on first start.

## API

- `POST /api/login` - validates a family member.
- `GET /api/records?user=<name>` - returns that user's records.
- `POST /api/records` - creates a record.
- `PUT /api/records/:id` - updates a record.
- `DELETE /api/records/:id?user=<name>` - deletes a record.

The frontend uses these endpoints for login, daily data, history, dashboard, and reports. Profile photos remain local to the browser because they are presentation preferences rather than farm records.

## Local account access

Every authenticated farm account can add, edit, and delete daily records from any device. The backend still requires a valid login session for these operations:

- Poongodi: `poongodi@poongodifarms.local` / `poongodi123`
- Prabakaran: `prabakaran@poongodifarms.local` / `prabakaran123`
- Rajindharan: `rajindharan@poongodifarms.local` / `rajindharan123`
- Sajindharan: `sajindharan@poongodifarms.local` / `sajindharan123`

The Google button currently shows the approved local account chooser. Real Google OAuth requires adding a Google Cloud Client ID, redirect URI, and server-side OAuth verification before deploying publicly.

## GitHub Pages and shared data

GitHub Pages cannot run `server.js`, and browser `localStorage` is device-specific. To share the same records between a laptop and a mobile phone, deploy `server.js` to a Node hosting provider and set its URL in [backend-config.js](./backend-config.js):

```js
window.FARM_API_URL = "https://your-backend-host.example.com";
```

The backend supports CORS through `ALLOWED_ORIGIN`. Set that environment variable to the GitHub Pages origin in production.

### Deploying the shared backend on Render

1. Open Render and choose **New > Blueprint**.
2. Select this GitHub repository and deploy [render.yaml](./render.yaml).
3. Copy the generated service URL.
4. Put that URL in [backend-config.js](./backend-config.js), then commit and push:

```js
window.FARM_API_URL = "https://poongodi-farms-api.onrender.com";
```

The JSON file is shared by all devices while the service is running. For durable production storage across redeploys, replace the JSON file with a managed database or attach persistent storage in Render.

### Secure authentication and login alerts

Set `FARM_USERS` in Render as a JSON array. Passwords must be scrypt hashes, never plain text:

```json
[
  {"user":"Poongodi","email":"your-real-email@example.com","passwordHash":"SALT:HASH","canEdit":true},
  {"user":"Prabakaran","email":"viewer@example.com","passwordHash":"SALT:HASH","canEdit":false}
]
```

Create a password hash locally:

```bash
node -e "const c=require('crypto');const p=process.argv[1];const s=c.randomBytes(16).toString('hex');console.log(s+':'+c.scryptSync(p,s,64).toString('hex'))" "your strong password"
```

The server checks the selected family member and exact email together, issues a session token, and protects records API calls. Optional login alerts can be enabled with Resend by setting `RESEND_API_KEY`, `LOGIN_ALERT_TO`, and `LOGIN_ALERT_FROM`. Passwords are never included in notifications.

If `FARM_USERS` is empty, the first valid login for each selected family member creates that account with a securely hashed password. Later logins require the same email and password. The service must have a persistent disk for these dynamically created accounts and records to survive redeploys.
