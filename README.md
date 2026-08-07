# 🛡️ Shadow-KYC

> Privacy-preserving KYC/AML verification using Zero-Knowledge Proofs (ZKPs) on the Midnight Network.

Shadow-KYC is a decentralized KYC/AML system built using **Midnight Network**, **Compact Smart Contracts**, **React**, and **TypeScript**. It allows users to request identity verification and prove eligibility **without revealing their personal information**.

---

## ✨ Features

- 🔒 Privacy-preserving identity verification using Zero-Knowledge Proofs (ZKPs)
- 📄 Request KYC/AML credentials
- ✅ Authority approval workflow
- ❌ Credential revocation
- 📜 On-chain credential registry
- 📊 Audit history
- 🌐 React + TypeScript frontend
- ⚡ REST API backend
- 🧪 Comprehensive smart contract tests (14/14 passing)

---

## 🏗️ Architecture

```text
                  React Frontend
                        │
                        ▼
                 REST API Server
                        │
                        ▼
          Compact Smart Contract (Midnight)
                        │
                        ▼
            Midnight Local Dev Network
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|--------|------------|
| Smart Contract | Compact |
| Blockchain | Midnight Network |
| Frontend | React + TypeScript + Vite |
| Backend | Node.js + REST API |
| Language | TypeScript |
| Testing | Vitest |

---

## 🚀 Getting Started

Clone the repository:

```bash
git clone https://github.com/Samruddhi2805/shadow-kyc.git
cd shadow-kyc
```

Install dependencies:

```bash
npm install
```

Compile the smart contract:

```bash
npm run compile
```

Start the local proof server:

```bash
npm run proof-server:start
```

Deploy the contract locally:

```bash
npm run deploy
```

Start the backend API:

```bash
npm run api
```

Start the frontend:

```bash
npm run frontend:dev
```

---

## ✅ Running Tests

Run all smart contract tests:

```bash
npm test
```

Build the frontend:

```bash
npm run frontend:build
```

Current project status:

- ✅ 14/14 Smart Contract Tests Passing
- ✅ Frontend Build Passing
- ✅ REST API Working
- ✅ Local Development Environment

---

# ⚠️ Current Deployment Status

> **This project currently runs on the Midnight Local Development Network only.**

The application is designed and tested in a **local Midnight development environment**. It is **not yet deployed** to the public Midnight Preview Network or Mainnet.

### Current Status

| Feature | Status |
|---------|--------|
| Local Midnight Dev Network | ✅ |
| Smart Contract | ✅ |
| REST API | ✅ |
| React Frontend | ✅ |
| Preview Network Deployment | ❌ |
| Mainnet Deployment | ❌ |

The frontend may display:

```text
Network: undeployed
```

This is expected because the project is currently configured for **local development only**.

---

## 🔐 Why Zero-Knowledge Proofs?

Traditional KYC systems require users to reveal sensitive personal information.

Shadow-KYC uses **Zero-Knowledge Proofs (ZKPs)** to allow users to prove they possess a valid credential **without revealing their identity or private data**, improving privacy while maintaining regulatory compliance.

---

## 📂 Project Structure

```text
shadow-kyc/
│
├── contracts/        # Compact smart contracts
├── frontend/         # React + TypeScript frontend
├── scripts/          # Utility scripts
├── src/              # Backend API & deployment logic
├── tests/            # Smart contract tests
├── package.json
└── README.md
```

---

## 🔮 Future Improvements

- Deploy to Midnight Preview Network
- Real wallet authentication
- Multi-authority credential issuance
- Decentralized Identity (DID) support
- IPFS document storage
- Role-based access control
- Production deployment

---

## 👨‍💻 Author

**Samruddhi Nevse**

GitHub: https://github.com/Samruddhi2805

---

## 📜 License

This project is licensed under the MIT License.
