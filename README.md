# risein

A Midnight Network smart contract scaffolded with create-mn-app.

## Quick start

Requirements: Node 22, Docker (with Compose v2), and the Compact compiler at the version pinned in `.compact-version` at the create-mn-app repo root (the version this project was scaffolded against).

```bash
npm install
npm run setup
npm run test:e2e
```

`npm run setup` runs end-to-end with no prompts:

1. `docker compose up -d --wait` — starts a local Midnight devnet (node, indexer, proof-server) and blocks until all three pass their healthchecks.
2. `npm run compile` — compiles `contracts/hello-world.compact` to `contracts/managed/hello-world/`.
3. `npm run deploy` — derives the genesis-seed wallet (NIGHT pre-minted), registers UTXOs for DUST generation, deploys the contract, writes `.midnight-state.json`.

`npm run test:e2e` reconnects to the deployed contract and reads its ledger state. Exits 0 if the contract is live and indexable.

## Local devnet

The project ships its own devnet via `docker-compose.yml`:

| Service        | Port | Purpose                                         |
| -------------- | ---- | ----------------------------------------------- |
| `node`         | 9944 | Midnight node, `dev` chain preset               |
| `indexer`      | 8088 | GraphQL indexer for chain state                 |
| `proof-server` | 6300 | Generates ZK proofs for contract transactions   |

State lives in container-managed volumes. Tear everything down with:

```bash
docker compose down -v
```

That removes all containers, networks, and volumes. The next `npm run setup` starts from a clean slate.

## ⚠️ LOCAL DEVNET ONLY

The deploy script uses a well-known genesis seed (`0000…0001`) so the
pre-minted NIGHT in the `dev` chain preset is immediately available. **Do
not use this seed against Preprod, mainnet, or any environment that
handles real value** — anyone running this devnet has full access to
funds at this seed.

## Networks

This DApp supports three networks:

| Network | When to use | Default? |
|---|---|---|
| `undeployed` | Local devnet bundled in `docker-compose.yml`. Genesis seed is hardcoded; no funding needed. | yes |
| `preview` | Public preview testnet. Faucet at `https://midnight-tmnight-preview.nethermind.dev`. |  |
| `preprod` | Public preprod testnet. Faucet at `https://midnight-tmnight-preprod.nethermind.dev`. |  |

The active network is **sticky**: whichever network you last interacted
with stays active until you switch. Any command run with `--network <name>`
also sets that network active for subsequent commands. The default on a
fresh project is `undeployed` (local devnet).

```sh
npm run setup -- --network preview   # runs on preview AND makes it active
npm run cli                          # still uses preview
npm run check-balance                # still uses preview
```

You can also switch without running anything else:

```sh
npm run network preview         # active network is now preview
npm run network                 # prints current active network
npm run network undeployed      # switch back to local devnet
```

### How wallets work across networks

- `undeployed` uses a hardcoded genesis seed. Local devnet pre-funds it.
- `preview` and `preprod` generate a fresh seed on first use and store it
  in `.midnight-state.json` (gitignored). The seed survives switching
  networks — switch back later and your funded wallet returns.
- **Back up your seed** if you fund a public-network wallet you care
  about. Open `.midnight-state.json` and copy the relevant
  `wallets.<network>.seed` value to a safe place.

### Funding a public-network wallet

On the first run with `--network preview` (or `preprod`):

1. `setup` will print your wallet address and the faucet URL.
2. Open the faucet URL, paste the address, request tNIGHT.
3. `setup` polls the wallet balance every 10 s and continues automatically
   once funds arrive.
4. The default poll budget is 10 minutes. Override with
   `MIDNIGHT_FAUCET_TIMEOUT_MS=1800000` (30 min) for unattended runs.

If the faucet is slow or the script times out, your seed is preserved.
Re-run `npm run setup -- --network preview` once the funds land.

### Environment overrides

These env vars override the active network's config (no per-network
suffix — they apply to whichever network is active for the run):

| Variable | Effect |
|---|---|
| `MIDNIGHT_WALLET_SEED` | Use this seed instead of generating/persisting one. Useful for CI with a pre-funded wallet. |
| `MIDNIGHT_INDEXER_URL` | Override the indexer GraphQL URL. |
| `MIDNIGHT_INDEXER_WS_URL` | Override the indexer WS URL. |
| `MIDNIGHT_NODE_URL` | Override the node RPC URL. |
| `MIDNIGHT_FAUCET_URL` | Override the faucet URL printed during setup. |
| `MIDNIGHT_PROOF_SERVER_URL` | Override the proof server URL — set to a public proof server (e.g. `https://lace-proof-pub.preview.midnight.network`) to skip running one locally. |
| `MIDNIGHT_FAUCET_TIMEOUT_MS` | Faucet poll budget in milliseconds (default 600000 = 10 min). |

By default all networks use the **local** proof server. Public proof
servers exist (see the env override above) but the local default keeps
your witness data on your machine and avoids depending on a remote
service for the deploy hot path.

### Switching back to local devnet

```sh
npm run network undeployed     # or: npm run setup -- --network undeployed
```

Your preview/preprod wallet seeds and deploy addresses stay in
`.midnight-state.json`. Switch back later, and they're still there.

### Wallet sync cache

After each `deploy`, `cli`, or `check-balance` run, the scripts serialize the
wallet's synced state to `.midnight-wallet-state/<network>/` (gitignored).
The next run on the same network restores from that snapshot and only catches
up to the latest block instead of replaying from genesis — meaningful on
`preview` / `preprod` where a from-seed sync takes minutes.

If the cache is stale or corrupt (e.g. after an SDK upgrade with an
incompatible state format) the wallet falls back to a fresh from-seed sync
with a one-line warning. `npm run clean` removes the cache along with other
generated state.

## Available scripts

| Script                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `npm run setup`         | One-shot: start devnet, compile, deploy.                       |
| `npm run compile`       | Compile the Compact contract.                                  |
| `npm run deploy`        | Deploy the compiled contract (requires devnet up + compiled).  |
| `npm run cli`           | Interactive CLI to call circuits on the deployed contract.     |
| `npm run check-balance` | Print the genesis-seed wallet's NIGHT and DUST balances.       |
| `npm run test:e2e`      | Smoke + read-back check against the deployed contract.         |
| `npm run clean`         | Remove `contracts/managed/`, `.midnight-state.json`, and `.midnight-wallet-state/`. |
| `npm run proof-server:start` / `:stop` | Compose lifecycle for just the proof-server service. |
| `npm run api`           | Start the API + frontend server (port 8080).                   |
| `npm run frontend:dev`  | Vite dev server (port 5173) with `/api` proxied to 8080.       |
| `npm run frontend:build`| Build the React frontend into `frontend/dist/`.                |

## Frontend (Phase 3)

The project ships a React + TypeScript frontend (in `frontend/`) that talks to
the deployed contract through a small API server (`src/api-server.ts`). The
API server reuses the same wallet/contract infrastructure as the CLI, so it
needs at least one deployment on the active network.

### Starting the web app

```bash
# 1. (once) Deploy the contract and start the local devnet
npm run setup

# 2. Start the API server — connects to the deployed contract
npm run api

# 3. In a second terminal — dev mode with HMR (or open http://localhost:8080
#    directly if you've built the frontend with `npm run frontend:build`)
npm run frontend:dev
```

Open `http://localhost:5173` for the Vite dev server, or
`http://localhost:8080` once the frontend is built.

### What the UI does

- **Overview** — live contract state: authority name, network, contract
  address, eligibility-proof counter, and a credential registry (pending /
  approved / revoked).
- **User Actions** — request a KYC/AML credential (`issueCredential`) and
  prove eligibility with a zero-knowledge proof (`proveEligibility`). The
  user's identity is hashed into a commitment and never leaves their side.
- **Authority** — approve pending credentials (`approveCredential`) and
  revoke credentials (`revokeCredential`).

> ⚠️ **Local devnet only.** The API server uses the same genesis seed as the
> deploy script, so on the bundled devnet it acts as both user and authority.
> Do not expose the API server to a public network without replacing the seed
> and adding authentication.

### API endpoints

| Method | Path            | Description                                        |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/api/status`   | Server, network, contract address, authority key.  |
| GET    | `/api/state`    | Full public ledger state (credential sets, count). |
| GET    | `/api/balance`  | Wallet tNight / DUST balances.                     |
| POST   | `/api/issue`    | Call `issueCredential` (user action).              |
| POST   | `/api/approve`  | Call `approveCredential` (authority, body: `{commitment}`). |
| POST   | `/api/prove`    | Call `proveEligibility` (user, ZK proof, body: `{commitment}`). |
| POST   | `/api/revoke`   | Call `revokeCredential` (authority, body: `{commitment}`). |

Transactions take 30–60s each (proof generation + block time). The UI shows
a "busy" state and polls the ledger until the transaction lands.

## Project structure

```
risein/
├── contracts/
│   ├── shadow-kyc.compact      # Compact source (Phase 1)
│   └── managed/                # compiled output (gitignored)
├── frontend/
│   ├── src/                    # React + TypeScript frontend (Phase 3)
│   │   ├── App.tsx             # main UI (overview / user / authority tabs)
│   │   ├── api.ts              # typed API client
│   │   ├── types.ts            # shared response types
│   │   └── ...
│   ├── vite.config.ts          # dev-server proxy for /api
│   └── package.json
├── scripts/
│   └── e2e-check.ts            # smoke + read-back
├── src/
│   ├── api-server.ts           # REST API + static frontend host (Phase 3)
│   ├── network.ts              # network selection + state file management
│   ├── wallet.ts               # wallet construction + sync-state cache
│   ├── setup.ts                # orchestrator for `npm run setup`
│   ├── deploy.ts               # deploy the contract
│   ├── cli.ts                  # interact with deployed contract
│   └── check-balance.ts        # NIGHT / DUST balance
├── docker-compose.yml          # node + indexer + proof-server
├── .midnight-state.json        # written by deploy (gitignored)
├── .midnight-wallet-state/     # serialized sync state per network (gitignored)
├── package.json
└── tsconfig.json
```

## Compact compiler version

`.compact-version` at the create-mn-app repo root pinned the compiler
version this project was scaffolded against. To upgrade your local
compiler to that version:

```bash
compact update <version>
compact use <version>
```
