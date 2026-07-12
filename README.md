# Smart Travel Agent

A **human-in-the-loop travel planning agent** built with the MERN-style stack — React frontend, Express backend, Cloud Firestore for state, and optional Google Gemini enrichment.

The agent breaks down travel goals using a ReAct loop, pauses when budget conflicts arise, waits for your decision, then returns an optimized itinerary.

![Stack](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Stack](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Stack](https://img.shields.io/badge/Firestore-Enabled-FFCA28?logo=firebase&logoColor=black)
![Stack](https://img.shields.io/badge/Gemini-Optional-4285F4?logo=google&logoColor=white)

---

## Features

- **Stateful agent execution** — sessions persisted in Firestore (`sessions/{sessionId}`)
- **ReAct loop** — Thought → Action → Observation agent steps
- **Human-in-the-loop** — pauses on budget conflicts with Option A / Option B
- **Multi-destination support** — Jaipur, Udaipur, Goa, Manali (+ generic city parsing)
- **Gemini enrichment** — optional single API call to polish the final plan
- **React UI** — live agent logs, decision cards, day-by-day itinerary

---

## Architecture

```
React UI (5173)  →  Express API (3001)  →  Firestore
                              ↓
                     Gemini API (optional)
```

| Layer      | Tech                          | Role                          |
|------------|-------------------------------|-------------------------------|
| Frontend   | React + Vite                  | User interface                |
| Backend    | Node.js + Express             | Agent logic & API routes      |
| Database   | Firebase Cloud Firestore      | Session state & logs          |
| LLM        | Google Gemini (flash-lite)    | Final plan enrichment         |

**Status lifecycle:** `RUNNING` → `AWAITING_USER_INPUT` → `COMPLETED`

---

## Project Structure

```
Smart-Travel-Agent/
├── server.js                 # Express backend + agent brain
├── package.json
├── .env.example              # Environment template
├── docs/
│   ├── Smart-Travel-Agent-Framework.md
│   ├── Smart-Travel-Agent-Framework.pdf
│   └── generate-pdf.js
└── client/                   # React frontend
    ├── src/
    │   ├── App.jsx           # Main UI
    │   └── api.js            # API client
    └── vite.config.js        # Dev proxy → :3001
```

---

## Quick Start

### Prerequisites

- Node.js 22+
- Firebase project with **Firestore** enabled
- Google Gemini API key (optional)

### 1. Clone & install

```bash
git clone https://github.com/Sahil5273/Smart-Travel-Agent.git
cd Smart-Travel-Agent

npm install
cd client && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_ENABLED=true
GEMINI_MODEL=gemini-2.0-flash-lite
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json
PORT=3001
```

Place your Firebase service account JSON as `serviceAccount.json` in the project root.

### 3. Run

**Terminal 1 — Backend:**
```bash
npm start
```

**Terminal 2 — Frontend:**
```bash
cd client && npm run dev
```

Open **http://localhost:5173**

---

## API Endpoints

### `POST /api/agent/run`

Start or resume the agent.

```json
{
  "userId": "demo-user",
  "sessionId": "session-123",
  "userGoal": "Plan a trip to Udaipur under 15000"
}
```

Returns `AWAITING_USER_INPUT` (with options) or `COMPLETED` (with plan).

### `POST /api/agent/respond`

Submit the user's choice after a conflict.

```json
{
  "sessionId": "session-123",
  "userChoice": "option_a"
}
```

Returns the final itinerary.

### `GET /health`

Server health check.

---

## How the Agent Works

1. User submits a travel goal
2. Agent runs ReAct steps and parses the destination
3. If budget ≤ ₹15,000 → **pauses** with two options
4. User picks Option A (budget) or Option B (full experience)
5. Backend builds a city-specific 3-day itinerary
6. Gemini optionally adds summary, highlights, and packing tips
7. Final plan saved to Firestore and returned to the UI

---

## Supported Destinations

| City     | Highlights                                      |
|----------|-------------------------------------------------|
| Jaipur   | Amber Fort, Hawa Mahal, City Palace             |
| Udaipur  | Lake Pichola, City Palace, Monsoon Palace       |
| Goa      | Beaches, Fort Aguada, Dudhsagar Falls           |
| Manali   | Solang Valley, Rohtang Pass, Hadimba Temple     |
| Other    | Parsed from phrases like "trip to Varanasi"     |

---

## Gemini Optimization

Gemini is called **at most once per session** — only on `/api/agent/respond`.

| Optimization        | Detail                              |
|---------------------|-------------------------------------|
| Skip on `/run`      | No API calls during initial planning |
| Lightweight model   | `gemini-2.0-flash-lite`             |
| Token cap           | 200 max output tokens               |
| In-memory cache     | Duplicate goal+choice skipped       |
| Circuit breaker     | 5-min pause after quota errors      |
| Local fallback      | Plans work fully without Gemini     |

---

## Documentation

Full framework documentation is in [`docs/Smart-Travel-Agent-Framework.pdf`](docs/Smart-Travel-Agent-Framework.pdf).

Regenerate the PDF:

```bash
node docs/generate-pdf.js
```

---

## Firebase Deployment

The project is configured for **Firebase Hosting** (React) + **Cloud Functions** (Express API) + **Firestore**.

### Prerequisites

- [Firebase CLI](https://firebase.google.com/docs/cli) installed
- Firebase project on the **Blaze (pay-as-you-go)** plan (required for Cloud Functions)
- Logged in: `firebase login`
- Firestore enabled in your Firebase project

### 1. Link your Firebase project

The repo is linked to Firebase project **`smart-travel-agent-92559`**.

To use a different project:

```bash
firebase use --add
```

Or edit `.firebaserc` with your project ID.

### 2. Set the Gemini API secret

Cloud Functions reads the Gemini key from Firebase Secrets (not `.env`):

```bash
firebase functions:secrets:set GEMINI_API_KEY
# Paste your Gemini API key when prompted
```

### 3. Install dependencies

```bash
npm install
cd functions && npm install && cd ..
cd client && npm install && cd ..
```

### 4. Deploy everything

```bash
npm run deploy
```

This builds the React app and deploys Hosting + Functions + Firestore rules.

### Deploy individually

```bash
npm run deploy:hosting     # React frontend only
npm run deploy:functions   # Express API only
npm run deploy:firestore   # Firestore rules only
```

### Live URLs after deploy

| Service | URL |
|---------|-----|
| **App** | `https://<project-id>.web.app` |
| **API** | `https://<region>-<project-id>.cloudfunctions.net/api` |
| **Health** | `https://<project-id>.web.app/health` |

Hosting rewrites `/api/**` and `/health` to the Cloud Function automatically.

### Local vs production credentials

| Environment | Firebase credentials |
|-------------|-------------------|
| **Local** (`npm start`) | `serviceAccount.json` + `.env` |
| **Cloud Functions** | Auto-injected — no service account file needed |

### Project layout for Firebase

```
functions/
  index.js    → exports Cloud Function "api"
  app.js      → Express app (shared logic)
firebase.json → Hosting + Functions + Firestore config
.firebaserc   → Firebase project ID
```

---

## License

ISC

---

## Author

**Sahil** — [GitHub](https://github.com/Sahil5273)
