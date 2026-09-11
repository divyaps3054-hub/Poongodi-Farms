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

`Poongodi` is the only account with add/edit/delete access. The other family accounts are read-only:

- Poongodi: `poongodi@poongodifarms.local` / `poongodi123`
- Prabakaran: `prabakaran@poongodifarms.local` / `prabakaran123`
- Rajindharan: `rajindharan@poongodifarms.local` / `rajindharan123`
- Sajindharan: `sajindharan@poongodifarms.local` / `sajindharan123`

The Google button currently shows the approved local account chooser. Real Google OAuth requires adding a Google Cloud Client ID, redirect URI, and server-side OAuth verification before deploying publicly.
