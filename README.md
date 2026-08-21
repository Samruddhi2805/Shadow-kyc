# 🛡️ Shadow-KYC

[![Shadow-KYC CI](https://github.com/Samruddhi2805/Shadow-kyc/actions/workflows/ci.yml/badge.svg)](https://github.com/Samruddhi2805/Shadow-kyc/actions/workflows/ci.yml)

> Privacy-preserving KYC/AML verification using Zero-Knowledge Proofs (ZKPs) on the Midnight Preprod Testnet.

Shadow-KYC is a decentralized KYC/AML system built on the **Midnight Network** using **Compact Smart Contracts**, **React**, **TypeScript**, and the **Midnight.js SDK** connected to the **Lace Wallet** (Preprod Network). Users can request identity verification and prove regulatory eligibility **without ever revealing their personal information** — the secret stays private, only its cryptographic commitment goes on-chain.

---

## 🎯 What This Does

Shadow-KYC provides privacy-preserving KYC/AML verification for applications that need regulatory compliance without requiring users to repeatedly expose sensitive identity documents. A user receives a cryptographic credential commitment after approval and can later prove eligibility using a zero-knowledge proof, allowing applications to verify compliance while keeping the underlying secret and user identity private.

---

## ✨ Features

- 🔒 Privacy-preserving identity verification using Zero-Knowledge Proofs (ZKPs)
- 📄 Request KYC/AML credentials (user action, ZK proof generated client-side)
- ✅ Authority approval workflow (on-chain Compact circuit)
- ❌ Credential revocation by authority
- 📜 On-chain credential registry (Midnight Preprod Testnet)
- 📊 Dynamic client audit history
- 🌐 React + TypeScript + Vite frontend with persistent Lace wallet connection
- ⚡ Node.js REST API backend
- 🧪 14/14 smart contract tests passing

---

## 📜 Contract Addresses

| Network | Contract Address | Status |
|---------|------------------|--------|
| **Preprod (Level 2)** | `1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0` | ✅ Active / Deployed |
| **Preview (Level 1)** | `3508cc15dd43ad50f9af84d722fd71aba6b9a45eea6731656e539c195499bbcb` | ✅ Legacy / Deployed |

---

## 🏗️ Architecture

```text
       React Frontend (Vite)
                 │
                 ▼
     REST API Server (Node.js)
                 │
                 ├─── Midnight JS SDK ──▶ Midnight Preprod Network (RPC / Indexer)
                 │                              │
                 │                        Compact Smart Contract
                 │                        (shadow-kyc.compact)
                 │
                 └─── ZK Proof Server (Docker / Host) — generates ZK proofs locally
```

> [!NOTE]
> For browser-based transaction execution, ZK proof generation is performed locally. The DApp client proxies proof generation requests to the local proof-server running on the user's machine at `http://127.0.0.1:6300`.

---

## 🔐 Privacy Model

The Compact smart contract separates what is public on-chain from what remains private as a zero-knowledge witness.

The user's private identity secret is used as a private witness during the ZK flow. A cryptographic commitment derived from the secret is used by the contract, allowing eligibility to be proven without revealing the underlying secret.

### Public — visible on-chain

| Field | Type | Description |
|---|---|---|
| `authority` | `Bytes<32>` | Authority dapp-specific public key |
| `authorityName` | `Opaque<string>` | Authority public name |
| `pendingCredentials` | `Set<Bytes<32>>` | Credential commitments awaiting approval |
| `credentials` | `Set<Bytes<32>>` | Approved credential commitments |
| `revokedCredentials` | `Set<Bytes<32>>` | Revoked credential commitments |
| `eligibilityCount` | `Uint<64>` | Public counter of eligibility proofs performed |

### Private — not revealed in on-chain state

| Element | Description |
|---|---|
| `localSecret()` witness | The caller's 32-byte secret used privately during proof generation; never exposed on-chain |
| User identity | The underlying identity information represented by the secret |

The credential commitment is computed inside the circuit using Midnight's built-in `persistentHash`.

### What the user proves without revealing

The `proveEligibility()` circuit proves that the user knows the secret corresponding to an approved credential commitment without revealing the secret itself ("Proved without revealing your input").

---

### 🔎 Privacy Claim

**What an on-chain observer can see**

An observer can see public contract state such as the authority name, credential commitments, pending and approved credential commitments, revoked credential commitments, and the eligibility proof counter.

**What an on-chain observer cannot see**

An observer cannot see the user's private secret or the underlying identity information represented by that secret. The user proves eligibility through a zero-knowledge proof without revealing the private witness.

---

## 🛠️ Tech Stack

| Layer | Technology |
|--------|------------|
| Smart Contract | Compact (Midnight DSL) |
| Blockchain | Midnight Preprod Testnet |
| Frontend | React + TypeScript + Vite |
| Backend | Node.js + REST API |
| Wallet | Lace Wallet (Chrome Extension, Preprod network) |
| ZK Proofs | Midnight Proof Server (Local Docker container, port 6300) |
| Testing | Vitest |

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 22
- Docker Desktop (with WSL2 integration enabled)
- **Lace Wallet** browser extension (set to **Preprod Testnet**)
- Compact compiler (from Midnight Developer Hub)

### Install

```bash
git clone https://github.com/Samruddhi2805/shadow-kyc.git
cd shadow-kyc
npm install
```

### Start Infrastructure (Docker)

```bash
npm run proof-server:start
```

This starts the `risein-proof-server` container for local ZK proof generation on port 6300.

### Compile the Smart Contract

```bash
npm run compile
```

Expected output:
```
Compiling 4 circuits:
circuit "approveCredential" (k=13, rows=4459)
circuit "issueCredential"   (k=13, rows=2281)
circuit "proveEligibility"  (k=13, rows=2631)
circuit "revokeCredential"  (k=13, rows=4459)
```

### Start the API Server

```bash
npm run api:fresh
```

### Start the Frontend

```bash
npm run frontend:dev
```

Then open `http://localhost:5173`.

---

## ✅ Running Tests

```bash
npm test
```

Expected output:

```
✓ tests/shadow-kyc.test.ts (14 tests) ~330ms
Test Files  1 passed (1)
    Tests  14 passed (14)
```

---

### ⚙️ CI/CD

Shadow-KYC uses GitHub Actions to automatically validate the project on every push to `main` and every pull request.

The pipeline:
1. Checks out the repository
2. Sets up Node.js 22
3. Installs dependencies with `npm ci`
4. Compiles the Compact smart contract with `npm run compile`
5. Runs the 14-test Vitest suite with `npm test`
6. Runs the TypeScript build with `npm run build`

---

## 🌐 Deployment Status

| Service / Feature | Status | URL |
|---|---|---|
| **Vercel Frontend** | ✅ Active / Deployed | `https://shadow-kyc.vercel.app` |
| **Production API Backend** | 🔗 Tunnel Active | `https://agreed-tan-automobiles-domain.trycloudflare.com/api` (Cloudflare Quick Tunnel) |
| **ZK Proof Server** | 💻 User Host | `http://127.0.0.1:6300` (Localhost requirement) |

> [!WARNING]
> The deployed Vercel frontend relies on a locally running ZK proof-server on the user's host (at `http://127.0.0.1:6300`) for generating client-side ZK transaction proofs. It is not fully serverless for proof generation.

---

## Level 2 — Frontend + Lace + Preprod

Shadow-KYC is connected to a deployed frontend UI, integrated with the Lace Wallet extension, and deployed on the Midnight Preprod network.

- Lace wallet connect/disconnect
- Midnight.js frontend integration
- Frontend circuit invocation
- Zero-knowledge proof generation
- Credential request, approval and revocation
- ZK eligibility verification
- Midnight Preprod deployment
- Transaction/audit history

### Preprod Contract

Contract Address:

`1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0`

### Live Demo

https://shadow-kyc.vercel.app/

### Level 2 Demo Flow

1. Connect Lace wallet
2. Request KYC credential
3. Generate ZK proof
4. Sign transaction with Lace
5. Confirm transaction on Midnight Preprod
6. Approve credential
7. Prove eligibility without revealing the secret
8. Revoke credential

### 1. Lace Wallet Connect / Disconnect
The frontend dynamically scans the browser context for the injected `window.midnight` object. It filters and enforces connection negotiation strictly with **Lace Wallet** connected to **Preprod Testnet**. If Lace is locked, it prompts the user to unlock. Disconnection completely clears the `ConnectedAPI` instances, local state, and cached credentials.

### 2. Frontend Circuit Execution
Using the Midnight JS SDK, the frontend binds compiled smart contract structures with the active wallet connector. The application triggers the `issueCredential` and `proveEligibility` circuits directly in the client browser, prompting Lace for transaction signatures.

### 3. Local ZK Proof Generation
Prover key (`.prover` files) and ZKIR artifacts (`.bzkir` files) are served statically under the frontend (`/keys` and `/zkir` folders) and loaded on-demand by `FetchZkConfigProvider`. The browser proxies ZK proof requests locally to the ZK proof-server on port 6300.

### 4. Privacy Behavior
The client-side private witness `localSecret` is generated locally in the browser, used during proof generation, and is not stored in on-chain ledger state.

### 5. Successful Preprod Transaction Evidence

*   **Smart Contract Address:** `1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0`
*   **On-Chain Transaction ID (issueCredential):** `00c4d5f5adab653657f3d47346afd4ad56aa55a20700d30897de2ef54e8b6a5ed1`
*   **Cryptographic Commitment Hash:** `0da0b4cd7295f6f0e1c0ebdf945a225fa90feee02934a81a3bcf9f241ae0571f`

### 6. Level 2 Requirement Checklist
- [x] Dynamic wallet detection of injected extensions (specifically Lace)
- [x] Connect / Disconnect Lace Wallet (Preprod Testnet network validation)
- [x] Load Preprod smart contract client in frontend React app
- [x] Dynamic query of indexer endpoints from wallet configuration
- [x] Fetch ZK config files statically via browser `FetchZkConfigProvider`
- [x] Generate zero-knowledge proofs locally in browser (via proof-server port 6300)
- [x] Execute Compact circuits directly from the frontend client
- [x] Support browser-based transactions with DUST fee balancing
- [x] Privacy claim documented in README
- [x] Preprod contract address documented
- [x] 13 meaningful commits in repository history
- [x] Live Vercel demo — https://shadow-kyc.vercel.app
- [ ] Demo video — pending recording

---

## 📦 Level 2 Submission Information

- **GitHub Repository:** https://github.com/Samruddhi2805/Shadow-kyc
- **Live Demo:** https://shadow-kyc.vercel.app/
- **Midnight Preprod Contract Address:**
  `1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0`

### Level 2 Requirements

| Requirement | Status | Details |
|---|---|---|
| **Lace Connect** | ✅ Supported | Dynamic detection and connection to Lace Wallet on Midnight Preprod |
| **Lace Disconnect** | ✅ Supported | Full state clearing and session disconnection |
| **Frontend Circuit Call** | ✅ Supported | Client-side circuit execution via Midnight.js SDK |
| **ZK Proof Generation** | ✅ Supported | Frontend initiates the ZK proving flow using the configured Midnight proof provider |
| **Private Input Not Revealed in UI** | ✅ Verified | Private witness (`localSecret`) is not displayed or exposed in UI |
| **Observable Privacy Behavior** | ✅ Verified | Zero-knowledge proof verifies eligibility without revealing the secret |
| **Preprod Deployment** | ✅ Deployed | Smart contract deployed and active on Midnight Preprod Testnet |
| **Verifiable Contract Address** | ✅ Verified | `1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0` |
| **Live Frontend** | ✅ Deployed | Vercel deployment hosted at https://shadow-kyc.vercel.app/ |
| **Minimum 8 Meaningful Commits** | ✅ Exceeded | Repository currently has 9 meaningful commits |

### Demo Video

The demo video demonstrates:
1. Lace wallet connection
2. Successful frontend circuit call
3. Local ZK proof generation
4. Lace transaction signing
5. Successful Midnight Preprod transaction
6. Privacy behavior without revealing the private input

---

### 📋 Product Proposal

Shadow-KYC is proposed under the Level 3 **Confidential Credentials** idea.

See [`PROPOSAL.md`](./PROPOSAL.md) for the product proposal, privacy rationale, data model, and Mainnet feasibility.

---

## 📂 Project Structure

```text
shadow-kyc/
├── contracts/
│   ├── shadow-kyc.compact          # Compact smart contract source
│   └── managed/
│       └── shadow-kyc/             # Compiled artifacts (auto-generated)
│           ├── contract/           # JS circuit binaries
│           └── keys/               # Proving & verifying keys
├── frontend/                       # React + TypeScript + Vite frontend
│   └── src/
│       ├── App.tsx                 # Main UI component
│       ├── api.ts                  # API client
│       └── types.ts                # Type definitions
├── src/                            # Node.js backend
│   ├── api-server.ts               # REST API + static file server
│   ├── deploy.ts                   # Contract deployment script
│   ├── cli.ts                      # Interactive CLI
│   ├── network.ts                  # Network configuration
│   └── wallet.ts                   # Wallet management
├── tests/
│   └── shadow-kyc.test.ts          # 14 Vitest smart contract tests
├── compose.yml                     # Docker compose services
└── package.json
```

---

## 👩‍💻 Author

**Samruddhi Nevse**

GitHub: [https://github.com/Samruddhi2805](https://github.com/Samruddhi2805)

---

## 📜 License

This project is licensed under the MIT License.
