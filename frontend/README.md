# Shadow-KYC Frontend

React + TypeScript + Vite frontend for the Shadow-KYC / ZK-AML system on the
Midnight Network.

## Architecture

The Midnight Wallet SDK and Midnight.js providers are Node-oriented (filesystem
ZK configs, WebSocket node client), so the frontend does **not** import the
contract directly. Instead, it talks to the API server in the repository root
(`src/api-server.ts`), which holds the wallet + deployed-contract connection
and exposes a small REST API:

```
┌──────────────┐   /api/*   ┌───────────────────────────┐
│  React UI    │ ─────────▶ │  API server (port 8080)   │
│  (Vite:5173) │ ◀───────── │  wallet + contract handle │
└──────────────┘    JSON    └───────────────────────────┘
```

In dev, Vite proxies `/api` requests to `http://127.0.0.1:8080` (override with
`API_URL`). In production, the API server serves the built frontend from
`frontend/dist/` at the same origin, so relative `/api` paths work everywhere.

## Development

```bash
# From the repo root:
npm run setup          # once: devnet + deploy
npm run api            # API server on :8080
npm run frontend:dev   # Vite dev server on :5173 (proxies /api)
```

## Production build

```bash
npm run frontend:build
```

The output goes to `frontend/dist/`, which `npm run api` serves at
`http://localhost:8080`.

## Layout

```
frontend/
├── src/
│   ├── App.tsx        # main UI (overview / user / authority tabs)
│   ├── api.ts         # typed API client
│   ├── types.ts       # shared response types
│   ├── main.tsx       # React entry point
│   ├── App.css        # component styles
│   └── index.css      # global styles / design tokens
├── vite.config.ts     # dev-server proxy for /api
├── index.html
└── package.json
```

## API reference

| Method | Path            | Body                  | Description                        |
| ------ | --------------- | --------------------- | ---------------------------------- |
| GET    | `/api/status`   | —                     | Server / network / contract info.  |
| GET    | `/api/state`    | —                     | Full public ledger state.          |
| GET    | `/api/balance`  | —                     | Wallet tNight / DUST balances.     |
| POST   | `/api/issue`    | —                     | Request a credential.              |
| POST   | `/api/approve`  | `{ "commitment": "…" }` | Approve a pending credential.    |
| POST   | `/api/prove`    | `{ "commitment": "…" }` | Prove eligibility (ZK proof).    |
| POST   | `/api/revoke`   | `{ "commitment": "…" }` | Revoke a credential.             |