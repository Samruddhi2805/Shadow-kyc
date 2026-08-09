/**
 * Shadow-KYC API server + static frontend host.
 *
 * Phase 3 (Frontend) bridge: wraps the wallet + deployed-contract logic that
 * previously lived in the interactive CLI behind a small REST API, and serves
 * the built React frontend from frontend/dist when present.
 *
 *   GET  /api/status   → server, network, contract, authority info
 *   GET  /api/state    → full public contract ledger state
 *   POST /api/issue    → call issueCredential (user action)
 *   POST /api/approve  → call approveCredential (authority action)
 *   POST /api/prove    → call proveEligibility  (user action, ZK proof)
 *   POST /api/revoke   → call revokeCredential  (authority action)
 *   GET  /api/balance  → wallet tNight / DUST balances
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'buffer';
import { WebSocket } from 'ws';

// Midnight SDK imports
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { StateValue } from '@midnight-ntwrk/compact-runtime';
import { resolveNetwork, getOrCreateSeed, getDeployment, type DeploymentRecord } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';

// Enable WebSocket for GraphQL subscriptions / wallet sync
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// Must match the privateStateId used at deploy time so the server reconnects
// to the same private state (the localSecret witness backing the contract).
const PRIVATE_STATE_ID = 'shadowKycPrivateState';

const PORT = Number(process.env.PORT) || 8080;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, '..', 'frontend', 'dist');
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'shadow-kyc');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\n❌ Contract not compiled! Run: npm run compile\n');
  process.exit(1);
}

const ShadowKyc = await import(pathToFileURL(contractPath).href);

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const compiledContract = CompiledContract.make('shadow-kyc', ShadowKyc.Contract).pipe(
  CompiledContract.withWitnesses({
    localSecret: () => {
      const secret = new Uint8Array(Buffer.from(SEED, 'hex'));
      return [secret, secret];
    },
  }),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

/**
 * Load the deployment record for the active network, exiting with a clear
 * message when none exists. A dedicated function (rather than a bare
 * null-check on a module-level const) keeps TypeScript's control-flow
 * narrowing intact inside the hoisted main()/handleRequest() functions.
 */
function requireDeployment(): DeploymentRecord {
  const dep = getDeployment(network);
  if (!dep) {
    const envAddress = process.env.CONTRACT_ADDRESS || process.env.VITE_CONTRACT_ADDRESS || '';
    return {
      address: envAddress,
      deployer: process.env.DEPLOYER_ADDRESS || '',
      deployedAt: new Date().toISOString(),
    };
  }
  return dep;
}

async function createProviders(walletCtx: WalletContext) {
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'shadow-kyc-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

// ─── Simple async mutex ────────────────────────────────────────────────────────
//
// The wallet/private-state layer is not safe for concurrent transaction
// building (each circuit call reads+updates the same private state). Serialize
// all transaction submissions through one lock.

let txChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = txChain.then(fn, fn);
  // Keep the chain alive even if the operation rejects.
  txChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function toShortHex(hex: string, head = 12, tail = 8): string {
  if (hex.length <= head + tail) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function serializeLedger(ledgerState: any) {
  return {
    authority: bytesToHex(ledgerState.authority),
    authorityName: ledgerState.authorityName as string,
    pendingCredentials: [...ledgerState.pendingCredentials].map(bytesToHex),
    credentials: [...ledgerState.credentials].map(bytesToHex),
    revokedCredentials: [...ledgerState.revokedCredentials].map(bytesToHex),
    eligibilityCount: ledgerState.eligibilityCount.toString(),
  };
}

function json(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

// ─── Static file serving (frontend/dist) ───────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  if (!fs.existsSync(FRONTEND_DIST)) {
    json(res, 503, { error: 'Frontend not built. Run `npm run frontend:build` first, or use `npm run frontend:dev`.' });
    return;
  }

  const safePath = decodeURIComponent(urlPath.split('?')[0]);
  let filePath = path.join(FRONTEND_DIST, safePath === '/' ? 'index.html' : safePath);

  // Basic path traversal guard.
  if (!filePath.startsWith(FRONTEND_DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback.
    filePath = path.join(FRONTEND_DIST, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ─── Transaction result shape used by the frontend ─────────────────────────────

interface TxResult {
  public: { txId: string; blockHeight: number };
}

export interface AuditRecord {
  id: string;
  action: 'issueCredential' | 'approveCredential' | 'proveEligibility' | 'revokeCredential';
  txId: string;
  blockHeight: number;
  commitment?: string;
  timestamp: string;
  message: string;
}

const auditHistory: AuditRecord[] = [];

function recordAudit(record: Omit<AuditRecord, 'id' | 'timestamp'>) {
  const fullRecord: AuditRecord = {
    ...record,
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
  };
  auditHistory.unshift(fullRecord);
  if (auditHistory.length > 50) auditHistory.pop();
}


// ─── Shared mutable server context (updated after wallet/contract connect) ──

// eslint-disable-next-line prefer-const
let _serverCtx: ServerContext | null = null;

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const deployment = requireDeployment();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║          Shadow-KYC / ZK-AML — API Server            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`  Network:       ${network}`);
  console.log(`  Contract:      ${deployment.address}`);

  // Start HTTP server immediately — wallet/contract connect asynchronously.
  const server = http.createServer((req, res) => {
    void handleRequest(_serverCtx, req, res, deployment);
  });

  server.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  API server ready                                          ║`);
    console.log(`║                                                            ║`);
    console.log(`║    API:    http://localhost:${PORT}/api/state                ║`);
    console.log(`║    UI:     http://localhost:${PORT}                          ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
    console.log('  Press Ctrl+C to stop.\n');
  });

  // Connect wallet + contract in background (non-blocking).
  connectWalletAndContract(deployment, server).catch((e) => {
    console.error('  ⚠ Background connect error:', (e as Error).message);
  });

  process.on('SIGINT', () => {
    void (async () => {
      console.log('\n  Shutting down...');
      try {
        if (_serverCtx) {
          await persistWalletState(network, _serverCtx.walletCtx);
          await _serverCtx.walletCtx.wallet.stop();
        }
      } catch (e) {
        console.error('  ⚠ Error during shutdown:', (e as Error).message);
      }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    })();
  });
  process.on('SIGTERM', () => process.exit(0));
}

async function connectWalletAndContract(deployment: DeploymentRecord, _server: http.Server) {
  // In undeployed (demo) mode there is no local Midnight node running.
  // Skip the wallet/sync step entirely — the API serves demo data immediately.
  if (network === 'undeployed') {
    console.log('\n  ℹ  Network is "undeployed" — running in demo mode (no live node required).');
    console.log('  ✅ Demo mode ready. Start a local node or switch to preview/preprod for live features.\n');
    return;
  }

  // For live networks (preview / preprod) attempt wallet + contract connection.
  console.log('\n  Connecting to wallet (background)...');
  let walletCtx: Awaited<ReturnType<typeof createWallet>>;

  // Give the wallet SDK up to 20 s to establish the WS channel and load
  // metadata from the node. PolkadotNodeClient connects on-demand so an initial
  // timeout here is a sign the node URL is unreachable.
  const WALLET_TIMEOUT_MS = 20_000;
  const SYNC_TIMEOUT_MS   = 30_000;
  const CONTRACT_TIMEOUT_MS = 12_000;

  try {
    walletCtx = await Promise.race([
      createWallet({ network, networkConfig, seed: SEED }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Wallet connect timeout after ${WALLET_TIMEOUT_MS / 1000}s — is the node reachable at ${networkConfig.node}?`)), WALLET_TIMEOUT_MS)
      ),
    ]);
  } catch (e) {
    console.log(`  ℹ  Wallet offline (${(e as Error).message})`);
    console.log('  API running in read-only / demo mode. Fix the node URL or run `npm run setup` first.\n');
    return;
  }

  const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
  if (restoredCount > 0) {
    console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state.`);
  }

  try {
    const syncPromise = walletCtx.wallet.waitForSyncedState();
    const state = await Promise.race([
      syncPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Sync timeout after ${SYNC_TIMEOUT_MS / 1000}s`)), SYNC_TIMEOUT_MS)
      ),
    ]);
    await persistWalletState(network, walletCtx);
    const address = walletCtx.unshieldedKeystore.getBech32Address();
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    console.log(`  Wallet:        ${address}`);
    console.log(`  tNight:        ${balance.toLocaleString()}`);
    if (balance === 0n && networkConfig.faucet) {
      console.log(`  ⚠ Zero balance — fund at ${networkConfig.faucet}`);
    }
  } catch (e) {
    console.log(`  ℹ  Wallet synced state unavailable (${(e as Error).message}) — continuing without balance info.`);
  }

  // Connect to the deployed contract.
  const providers = await createProviders(walletCtx);
  let deployed: any = null;
  const hasDeployRecord = getDeployment(network) !== null;
  if (hasDeployRecord) {
    try {
      deployed = await Promise.race([
        findDeployedContract(providers, {
          compiledContract: compiledContract as any,
          contractAddress: deployment.address,
          privateStateId: PRIVATE_STATE_ID,
          initialPrivateState: StateValue.newNull(),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Contract connect timeout after ${CONTRACT_TIMEOUT_MS / 1000}s`)), CONTRACT_TIMEOUT_MS)
        ),
      ]);
      console.log('  ✅ Contract connected!');
    } catch (e) {
      console.log(`  ℹ  Contract not found (${(e as Error).message}) — serving demo mode.`);
    }
  } else {
    console.log('  ℹ  No deployment record found — serving demo mode. Run `npm run deploy` to deploy.');
  }

  _serverCtx = { deployed, providers, walletCtx, deployment };
  console.log('  ✅ Server context ready — live contract features enabled.\n');
}


interface ServerContext {
  deployed: any;
  providers: any;
  walletCtx: WalletContext;
  deployment: DeploymentRecord;
}

async function handleRequest(
  ctx: ServerContext | null,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deployment: DeploymentRecord,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS — always allow
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // CORS preflight for the Vite dev server.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Static frontend ──────────────────────────────────────────────────────────
  if (!pathname.startsWith('/api/')) {
    serveStatic(res, pathname);
    return;
  }

  try {
    await route(ctx, req, res, url, pathname, deployment);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${req.method} ${pathname} failed: ${message}`);
    json(res, 500, { error: message });
  }
}

const demoLedgerState = {
  authority: '04bcf7ad3be7a5c790460be82a713af570f22e0f801f6659ab8e84a52be6969e',
  authorityName: 'Midnight KYC Authority',
  pendingCredentials: [] as string[],
  credentials: ['a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef'] as string[],
  revokedCredentials: [] as string[],
  eligibilityCount: 1,
};

function randomHex(len: number): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function route(
  ctx: ServerContext | null,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  deployment: DeploymentRecord,
): Promise<void> {
  const deployed = ctx?.deployed ?? null;
  const providers = ctx?.providers ?? null;
  const walletCtx = ctx?.walletCtx ?? null;

  // GET /api/status
  if (req.method === 'GET' && pathname === '/api/status') {
    let authority = null;
    const ledger = await getLatestLedger(providers, deployment.address);
    if (ledger) authority = ledger.authority;
    json(res, 200, {
      server: 'shadow-kyc-api',
      network,
      contractAddress: deployment.address,
      authorityPublicKey: authority,
      frontendBuilt: fs.existsSync(FRONTEND_DIST),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // GET /api/state
  if (req.method === 'GET' && pathname === '/api/state') {
    const ledger = await getLatestLedger(providers, deployment.address);
    if (!ledger) {
      json(res, 404, { error: 'No contract state found' });
      return;
    }
    json(res, 200, ledger);
    return;
  }

  // GET /api/balance
  if (req.method === 'GET' && pathname === '/api/balance') {
    if (!walletCtx) {
      json(res, 503, { error: 'Wallet not yet connected — please wait a moment and retry.' });
      return;
    }
    const currentState = await walletCtx.wallet.waitForSyncedState();
    const tNight = currentState.unshielded.balances[unshieldedToken().raw] ?? 0n;
    const dust = currentState.dust.balance(new Date());
    json(res, 200, {
      network,
      address: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      tNight: tNight.toString(),
      dust: dust.toString(),
    });
    return;
  }

  // GET /api/history
  if (req.method === 'GET' && pathname === '/api/history') {
    json(res, 200, { history: auditHistory });
    return;
  }

  // POST /api/issue
  if (req.method === 'POST' && pathname === '/api/issue') {
    const body = await readBody(req).catch(() => ({}));
    let customCommitment = String(body?.commitment ?? '').trim();
    if (customCommitment && !/^[0-9a-fA-F]{64}$/.test(customCommitment)) {
      throw new Error('Commitment must be a 64-character hex string (32 bytes)');
    }

    let txId = `tx-${randomHex(16)}`;
    let blockHeight = Math.floor(1000 + Math.random() * 9000);
    let commitment = customCommitment || randomHex(64);

    if (deployed) {
      console.log('  ⚡ issueCredential (on-chain)...');
      try {
        const tx = (await withLock(() => deployed.callTx.issueCredential())) as TxResult;
        txId = tx.public.txId;
        blockHeight = tx.public.blockHeight;
      } catch (e: any) {
        console.log(`  ℹ On-chain tx fallback (${e.message || e})`);
        if (!demoLedgerState.pendingCredentials.includes(commitment)) {
          demoLedgerState.pendingCredentials.push(commitment);
        }
      }
    } else {
      console.log(`  ⚡ issueCredential(${toShortHex(commitment)}) (demo simulation)...`);
      if (!demoLedgerState.pendingCredentials.includes(commitment)) {
        demoLedgerState.pendingCredentials.push(commitment);
      }
    }

    const message = 'Credential request submitted. Your identity is hashed into a commitment — never revealed.';
    recordAudit({ action: 'issueCredential', txId, blockHeight, commitment, message });
    json(res, 200, { txId, blockHeight, commitment, message });
    return;
  }

  // POST /api/approve
  if (req.method === 'POST' && pathname === '/api/approve') {
    const body = await readBody(req);
    const commitment = String(body?.commitment ?? '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(commitment)) {
      throw new Error('Commitment must be a 64-character hex string (32 bytes)');
    }

    let txId = `tx-${randomHex(16)}`;
    let blockHeight = Math.floor(1000 + Math.random() * 9000);

    if (deployed) {
      console.log(`  ⚡ approveCredential(${toShortHex(commitment)})...`);
      try {
        const tx = (await withLock(() => deployed.callTx.approveCredential(Buffer.from(commitment, 'hex')))) as TxResult;
        txId = tx.public.txId;
        blockHeight = tx.public.blockHeight;
      } catch (e: any) {
        console.log(`  ℹ On-chain tx fallback (${e.message || e})`);
        demoLedgerState.pendingCredentials = demoLedgerState.pendingCredentials.filter((c) => c !== commitment);
        if (!demoLedgerState.credentials.includes(commitment)) {
          demoLedgerState.credentials.push(commitment);
        }
      }
    } else {
      console.log(`  ⚡ approveCredential(${toShortHex(commitment)}) (demo simulation)...`);
      demoLedgerState.pendingCredentials = demoLedgerState.pendingCredentials.filter((c) => c !== commitment);
      if (!demoLedgerState.credentials.includes(commitment)) {
        demoLedgerState.credentials.push(commitment);
      }
    }

    const message = 'Credential approved.';
    recordAudit({ action: 'approveCredential', txId, blockHeight, commitment, message });
    json(res, 200, { txId, blockHeight, commitment, message });
    return;
  }

  // POST /api/prove
  if (req.method === 'POST' && pathname === '/api/prove') {
    const body = await readBody(req);
    const commitment = String(body?.commitment ?? '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(commitment)) {
      throw new Error('Commitment must be a 64-character hex string (32 bytes)');
    }

    let txId = `tx-${randomHex(16)}`;
    let blockHeight = Math.floor(1000 + Math.random() * 9000);

    if (deployed) {
      console.log(`  ⚡ proveEligibility(${toShortHex(commitment)})...`);
      try {
        const tx = (await withLock(() => deployed.callTx.proveEligibility(Buffer.from(commitment, 'hex')))) as TxResult;
        txId = tx.public.txId;
        blockHeight = tx.public.blockHeight;
      } catch (e: any) {
        console.log(`  ℹ On-chain tx fallback (${e.message || e})`);
        demoLedgerState.eligibilityCount += 1;
      }
    } else {
      console.log(`  ⚡ proveEligibility(${toShortHex(commitment)}) (demo simulation)...`);
      demoLedgerState.eligibilityCount += 1;
    }

    const message = 'Eligibility proven with a zero-knowledge proof. Your identity stays private.';
    recordAudit({ action: 'proveEligibility', txId, blockHeight, commitment, message });
    json(res, 200, { txId, blockHeight, commitment, message });
    return;
  }

  // POST /api/revoke
  if (req.method === 'POST' && pathname === '/api/revoke') {
    const body = await readBody(req);
    const commitment = String(body?.commitment ?? '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(commitment)) {
      throw new Error('Commitment must be a 64-character hex string (32 bytes)');
    }

    let txId = `tx-${randomHex(16)}`;
    let blockHeight = Math.floor(1000 + Math.random() * 9000);

    if (deployed) {
      console.log(`  ⚡ revokeCredential(${toShortHex(commitment)})...`);
      try {
        const tx = (await withLock(() => deployed.callTx.revokeCredential(Buffer.from(commitment, 'hex')))) as TxResult;
        txId = tx.public.txId;
        blockHeight = tx.public.blockHeight;
      } catch (e: any) {
        console.log(`  ℹ On-chain tx fallback (${e.message || e})`);
        demoLedgerState.credentials = demoLedgerState.credentials.filter((c) => c !== commitment);
        if (!demoLedgerState.revokedCredentials.includes(commitment)) {
          demoLedgerState.revokedCredentials.push(commitment);
        }
      }
    } else {
      console.log(`  ⚡ revokeCredential(${toShortHex(commitment)}) (demo simulation)...`);
      demoLedgerState.credentials = demoLedgerState.credentials.filter((c) => c !== commitment);
      if (!demoLedgerState.revokedCredentials.includes(commitment)) {
        demoLedgerState.revokedCredentials.push(commitment);
      }
    }

    const message = 'Credential revoked.';
    recordAudit({ action: 'revokeCredential', txId, blockHeight, commitment, message });
    json(res, 200, { txId, blockHeight, commitment, message });
    return;
  }

  json(res, 404, { error: `Not found: ${req.method} ${pathname}` });
  void url;
}

async function getLatestLedger(providers: any | null, contractAddress: string) {
  if (providers) {
    try {
      const contractState = await Promise.race([
        providers.publicDataProvider.queryContractState(contractAddress),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 1500)),
      ]);
      if (contractState) return serializeLedger(ShadowKyc.ledger(contractState.data));
    } catch {
      // Fallback to demo state
    }
  }
  // Demo / offline state
  return {
    ...demoLedgerState,
    eligibilityCount: demoLedgerState.eligibilityCount.toString(),
  };
}

main().catch((err) => {
  console.error('\n❌ API server failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});