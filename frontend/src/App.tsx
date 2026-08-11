import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { Buffer } from 'buffer'
import { findDeployedContract, type FoundContract } from '@midnight-ntwrk/midnight-js-contracts'
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { inMemoryPrivateStateProvider } from './in-memory-private-state-provider'
import { setNetworkId, type NetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { Transaction, type FinalizedTransaction, type TransactionId } from '@midnight-ntwrk/midnight-js-protocol/ledger'
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import * as ShadowKyc from '../../contracts/managed/shadow-kyc/contract/index.js'
import type { Contract as ShadowKycContract } from '../../contracts/managed/shadow-kyc/contract/index.js'
import type { InitialAPI, ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import type { WalletProvider, MidnightProvider, MidnightProviders, UnboundTransaction } from '@midnight-ntwrk/midnight-js-types'

declare global {
  interface Window {
    midnight?: Record<string, InitialAPI>;
  }
}

import { api } from './api'
import type {
  AuditRecord,
  BalanceInfo,
  ConnectedWalletInfo,
  ContractState,
  CredentialEntry,
  ServerStatus,
  TxModalProgressState,
  TxResponse,
} from './types'
import './App.css'

// ─── Small helpers ─────────────────────────────────────────────────────────────

function shortHex(hex: string, head = 10, tail = 8): string {
  if (!hex) return '—'
  if (hex.length <= head + tail) return hex
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`
}

function formatCount(value: string): string {
  return Number(value).toLocaleString()
}

function formatNetworkName(net?: string): string {
  if (!net) return '—'
  if (net === 'undeployed') return 'Local Dev Network'
  if (net === 'preview') return 'Preview Testnet'
  if (net === 'preprod') return 'Preprod Testnet'
  return net
}

interface ShadowKycPrivateState {
  readonly localSecret: Uint8Array;
}

// In-memory cache for cryptographically random secrets to preserve them for the session
const inMemorySecrets = new Map<string, Uint8Array>();

// Generate a cryptographically random 32-byte secret for Level 2 security requirement
async function getDeterministicSecret(address: string): Promise<Uint8Array> {
  if (!address) return new Uint8Array(32);
  let secret = inMemorySecrets.get(address);
  if (!secret) {
    secret = crypto.getRandomValues(new Uint8Array(32));
    inMemorySecrets.set(address, secret);
  }
  return secret;
}

// Compute the exact SHA-256 hash (persistentHash) of the user's secret
async function computeRealCommitment(secret: globalThis.Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', secret.buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Simple client-side hash simulation for the interactive ZK witness visualizer
async function simulateCommitment(secret: string): Promise<string> {
  if (!secret) return '00'.repeat(32)
  const encoder = new TextEncoder()
  const data = encoder.encode(`shadow-kyc:secret:${secret}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Toast notification state ──────────────────────────────────────────────────

interface Toast {
  kind: 'success' | 'error' | 'info'
  text: string
}

// Initialize Midnight client-side providers using the connected Lace Wallet configuration
async function initializeClientProviders(connectedAPI: ConnectedAPI): Promise<MidnightProviders<any, string, ShadowKycPrivateState>> {
  console.log('[Providers] Fetching wallet connector configuration...');
  const config = await connectedAPI.getConfiguration();
  console.log('[Providers] Wallet Config:', config);
  
  // Set the network ID dynamically from the connected wallet
  const networkId = config.networkId || import.meta.env.VITE_NETWORK || 'preprod';
  setNetworkId(networkId as NetworkId);

  // Set the indexer and prover endpoints dynamically from the connected wallet
  const indexerUri = config.indexerUri;
  const indexerWsUri = config.indexerWsUri;
  const proverServerUri = config.proverServerUri || 'http://localhost:6300';

  console.log(`[Providers] Target Network: ${networkId}`);
  console.log(`[Providers] Indexer URI:    ${indexerUri}`);
  console.log(`[Providers] Prover URI:     ${proverServerUri}`);

  // Fetch ZK configs statically from the DApp public directory
  const zkConfigPath = window.location.origin;
  const keyMaterialProvider = new FetchZkConfigProvider(zkConfigPath, fetch.bind(window));
  
  // Create in-memory private state provider to avoid plaintext localStorage leaks
  const privateStateProvider = inMemoryPrivateStateProvider<string, ShadowKycPrivateState>();
  
  // Fetch shielded addresses asynchronously once
  const shieldedAddresses = await connectedAPI.getShieldedAddresses();

  // Wallet provider wrapping the connectedAPI
  const walletProvider: WalletProvider = {
    getCoinPublicKey: () => {
      return shieldedAddresses.shieldedCoinPublicKey;
    },
    getEncryptionPublicKey: () => {
      return shieldedAddresses.shieldedEncryptionPublicKey;
    },
    balanceTx: async (tx: UnboundTransaction, _ttl?: Date): Promise<FinalizedTransaction> => {
      console.log('[Providers] Balancing transaction via connected wallet...', tx);
      const serializedTx = Buffer.from(tx.serialize()).toString('hex');
      const balanced = await connectedAPI.balanceUnsealedTransaction(serializedTx);
      return Transaction.deserialize(
        'signature',
        'proof',
        'binding',
        Buffer.from(balanced.tx, 'hex'),
      ) as FinalizedTransaction;
    }
  };

  // Midnight provider wrapping the connectedAPI
  const midnightProvider: MidnightProvider = {
    submitTx: async (tx: FinalizedTransaction): Promise<TransactionId> => {
      console.log('[Providers] Submitting transaction via connected wallet...', tx);
      const serializedTx = Buffer.from(tx.serialize()).toString('hex');
      await connectedAPI.submitTransaction(serializedTx);
      const txIdentifiers = tx.identifiers();
      console.log('[Providers] Submitted Tx IDs:', txIdentifiers);
      return txIdentifiers[0] as TransactionId;
    }
  };

  return {
    privateStateProvider,
    zkConfigProvider: keyMaterialProvider,
    proofProvider: httpClientProofProvider(proverServerUri, keyMaterialProvider),
    publicDataProvider: indexerPublicDataProvider(indexerUri, indexerWsUri),
    walletProvider,
    midnightProvider,
  };
}

// Join the deployed Shadow-KYC contract using client-side providers
async function joinContract(
  connectedAPI: ConnectedAPI,
  address: string,
  contractAddress: string
): Promise<{ deployed: FoundContract<ShadowKycContract<ShadowKycPrivateState>>; secret: Uint8Array }> {
  const providers = await initializeClientProviders(connectedAPI);
  providers.privateStateProvider.setContractAddress(contractAddress);

  // Derive the user secret and initialize private state
  const secret = await getDeterministicSecret(address);
  const initialPrivateState = { localSecret: secret };
  await providers.privateStateProvider.set('shadowKycPrivateState', initialPrivateState);

  // Re-create the CompiledContract structure with client witnesses
  const compiledContract = CompiledContract.make<ShadowKycContract<ShadowKycPrivateState>>(
    'shadow-kyc',
    ShadowKyc.Contract
  ).pipe(
    CompiledContract.withWitnesses({
      localSecret: (context) => {
        const secret = context.privateState.localSecret;
        return [context.privateState, secret];
      }
    })
  );

  console.log('[Contract] Attempting to join contract at address:', contractAddress);
  const deployed = await findDeployedContract<ShadowKycContract<ShadowKycPrivateState>>(providers, {
    contractAddress,
    compiledContract: compiledContract as CompiledContract.CompiledContract<ShadowKycContract<ShadowKycPrivateState>, ShadowKycPrivateState, never>,
    privateStateId: 'shadowKycPrivateState',
    initialPrivateState: initialPrivateState,
  });

  return { deployed, secret };
}

// ─── Main Component ────────────────────────────────────────────────────────────

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [state, setState] = useState<ContractState | null>(null)
  const [balance, setBalance] = useState<BalanceInfo | null>(null)
  const [history, setHistory] = useState<AuditRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [commitmentInput, setCommitmentInput] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'user' | 'authority' | 'audit'>('overview')

  // Wallet & Modal States
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWalletInfo | null>(null)
  const [showWalletModal, setShowWalletModal] = useState(false)
  const [showWalletSuccessPop, setShowWalletSuccessPop] = useState<ConnectedWalletInfo | null>(null)
  const [availableWallets, setAvailableWallets] = useState<Array<{ id: string; name: string }>>([])
  const [isConnectingWallet, setIsConnectingWallet] = useState(false)
  const [txProgress, setTxProgress] = useState<TxModalProgressState | null>(null)
  const [deployedContract, setDeployedContract] = useState<FoundContract<ShadowKycContract<ShadowKycPrivateState>> | null>(null)
  const connectedApiRef = useRef<ConnectedAPI | null>(null)



  const showToast = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text })
    window.setTimeout(() => setToast(null), 5000)
  }, [])

  const scanWallets = useCallback(() => {
    if (typeof window === 'undefined' || !window.midnight) {
      setAvailableWallets([])
      return
    }
    const keys = Object.keys(window.midnight)
    const list = keys.map((id) => ({
      id,
      name: window.midnight![id]?.name || id,
    }))
    setAvailableWallets(list)
  }, [])

  useEffect(() => {
    scanWallets()
    const id = window.setInterval(scanWallets, 1500)
    return () => window.clearInterval(id)
  }, [scanWallets])

  const connectWallet = useCallback(async (walletId: string) => {
    if (typeof window === 'undefined' || !window.midnight || !window.midnight[walletId]) {
      showToast('error', 'Selected wallet extension is not detected in your browser.')
      return
    }
    setIsConnectingWallet(true)
    showToast('info', `Connecting to ${walletId}... Please check your wallet extension popup to approve access if prompted.`)

    try {
      const wallet = window.midnight[walletId]
      console.log(`[Wallet Connection] Connecting to ${walletId}...`, wallet)

      const defaultNet = import.meta.env.VITE_NETWORK || 'undeployed'
      const activeNet = (status?.network || defaultNet) === 'preview' ? 'preview' : (((status?.network || defaultNet) === 'preprod') ? 'preprod' : 'testnet')
      let walletApi: ConnectedAPI | null = null

      // Multi-network & fallback connection attempt
      const netOptions = [activeNet, 'preview', 'testnet', 'preprod', 'undeployed']
      let lastErr: any = null

      const legacyWallet = wallet as unknown as {
        connect?: (networkId?: string) => Promise<ConnectedAPI>;
        enable?: () => Promise<ConnectedAPI>;
      };

      for (const netChoice of netOptions) {
        try {
          if (typeof legacyWallet.connect === 'function') {
            walletApi = await Promise.race([
              legacyWallet.connect(netChoice),
              new Promise<ConnectedAPI>((_, reject) => setTimeout(() => reject(new Error('Wallet request timed out — please check 1AM extension popup.')), 10000))
            ])
            if (walletApi) break
          }
        } catch (e) {
          lastErr = e
          console.warn(`[Wallet Connection] ${netChoice} attempt failed:`, e)
        }
      }

      if (!walletApi && typeof legacyWallet.connect === 'function') {
        try {
          walletApi = await legacyWallet.connect()
        } catch (e) {
          lastErr = e
        }
      }

      if (!walletApi && typeof legacyWallet.enable === 'function') {
        try {
          walletApi = await legacyWallet.enable()
        } catch (e) {
          lastErr = e
        }
      }

      if (!walletApi) {
        throw lastErr || new Error(`Unable to connect to ${wallet.name || walletId}. Make sure your wallet is unlocked and set to Preview Testnet.`)
      }

      console.log(`[Wallet Connection] Connected API:`, walletApi)

      // Address resolution compatibility
      let address: unknown = 'mn_wallet_account'
      if (typeof walletApi.getUnshieldedAddress === 'function') {
        address = await walletApi.getUnshieldedAddress()
      } else {
        const legacyApi = walletApi as unknown as {
          getAddresses?: () => Promise<unknown>;
          state?: () => Promise<{ unshielded?: { address?: string }; address?: string }>;
        };
        if (typeof legacyApi.getAddresses === 'function') {
          const addrs = await legacyApi.getAddresses()
          address = Array.isArray(addrs) ? addrs[0] : addrs
        } else if (typeof legacyApi.state === 'function') {
          const st = await legacyApi.state()
          address = st?.unshielded?.address || st?.address || address
        }
      }

      // Balance resolution compatibility
      let rawBalance = '10000'
      try {
        if (typeof walletApi.getUnshieldedBalances === 'function') {
          const balances = await walletApi.getUnshieldedBalances()
          rawBalance = (balances['00'] ?? Object.values(balances)[0] ?? 10000n).toString()
        } else {
          const legacyApi = walletApi as unknown as {
            getBalances?: () => Promise<Record<string, bigint>>;
          };
          if (typeof legacyApi.getBalances === 'function') {
            const balances = await legacyApi.getBalances()
            rawBalance = (balances['00'] ?? Object.values(balances)[0] ?? 10000n).toString()
          }
        }
      } catch (balErr) {
        console.warn('[Wallet Connection] Balance query warning:', balErr)
      }

      // Safe address conversion helper
      const extractAddressStr = (addrObj: unknown): string => {
        if (!addrObj) return 'mn_wallet_account';
        if (typeof addrObj === 'string') return addrObj;
        if (typeof addrObj === 'object' && addrObj !== null) {
          const obj = addrObj as Record<string, unknown>;
          if (typeof obj.unshieldedAddress === 'string') return obj.unshieldedAddress;
          if (typeof obj.address === 'string') return obj.address;
          if (typeof obj.bech32 === 'string') return obj.bech32;
          if (typeof obj.bech32Address === 'string') return obj.bech32Address;
          if (typeof obj.value === 'string') return obj.value;
          if (typeof obj.toString === 'function') {
            const s = obj.toString();
            if (s && s !== '[object Object]') return s;
          }
          try {
            const serialized = JSON.stringify(obj);
            const match = serialized.match(/"(mn_addr_[a-z0-9]+)"/i) || serialized.match(/"address"\s*:\s*"(.*?)"/);
            if (match && match[1]) return match[1];
          } catch {}
        }
        return String(addrObj);
      };

      const finalAddress = extractAddressStr(address);

      const walletObj: ConnectedWalletInfo = {
        id: walletId,
        name: wallet.name || walletId,
        address: finalAddress,
        tNight: rawBalance,
        dust: '100',
        network: (status?.network || defaultNet) === 'preview' ? 'Midnight Preview' : 'Midnight Network',
        isWebWallet: false,
      }

      connectedApiRef.current = walletApi;

      // Join the deployed smart contract on Preprod
      const contractAddress = status?.contractAddress || import.meta.env.VITE_CONTRACT_ADDRESS;
      if (contractAddress && contractAddress !== '') {
        try {
          showToast('info', 'Connecting to Shadow-KYC smart contract and deriving secret...');
          const result = await joinContract(walletApi, finalAddress, contractAddress);
          console.log('[Contract Join] Successfully loaded contract client:', result.deployed);
          setDeployedContract(result.deployed);
        } catch (contractErr: any) {
          console.error('[Contract Join Error]', contractErr);
          showToast('error', `Contract connection failed: ${contractErr.message || contractErr}. Running in offline/read-only mode.`);
        }
      }

      localStorage.setItem('connectedWalletId', walletId)
      setConnectedWallet(walletObj)
      setShowWalletModal(false)
      setShowWalletSuccessPop(walletObj)
      showToast('success', `Successfully connected to ${wallet.name || walletId}!`)
    } catch (err: any) {
      console.error('[Wallet Connection Error]', err)
      showToast('error', `Connection failed: ${err.message || err}`)
    } finally {
      setIsConnectingWallet(false)
    }
  }, [status, showToast])

  const autoConnectedRef = useRef(false)

  useEffect(() => {
    if (availableWallets.length > 0 && !connectedWallet && !autoConnectedRef.current) {
      const savedId = localStorage.getItem('connectedWalletId')
      if (savedId && availableWallets.some(w => w.id === savedId)) {
        autoConnectedRef.current = true
        void connectWallet(savedId)
      }
    }
  }, [availableWallets, connectedWallet, connectWallet])

  const connectWebWallet = useCallback(() => {
    setIsConnectingWallet(true)
    setTimeout(() => {
      const randomHexAdd = 'mn_1' + Array.from({ length: 36 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
      const defaultNet = import.meta.env.VITE_NETWORK || 'undeployed'
      const walletObj: ConnectedWalletInfo = {
        id: 'web-wallet',
        name: 'Midnight Devnet Web Wallet',
        address: randomHexAdd,
        tNight: '10000',
        dust: '500',
        network: (status?.network || defaultNet) === 'preview' ? 'Midnight Preview' : 'Midnight Local Devnet',
        isWebWallet: true,
      }
      setConnectedWallet(walletObj)
      setShowWalletModal(false)
      setIsConnectingWallet(false)
      setShowWalletSuccessPop(walletObj)
      showToast('success', 'Connected to Midnight Web Wallet!')
    }, 400)
  }, [status, showToast])

  const disconnectWallet = useCallback(() => {
    setConnectedWallet(null)
    setShowWalletSuccessPop(null)
    setDeployedContract(null)
    connectedApiRef.current = null
    localStorage.removeItem('connectedWalletId')
    showToast('info', 'Wallet disconnected')
  }, [showToast])

  const copyToClipboard = useCallback((text: string, label: string) => {
    void navigator.clipboard.writeText(text)
    showToast('info', `Copied ${label} to clipboard`)
  }, [showToast])

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        api.getStatus().catch(() => null),
        api.getState().catch(() => null),
      ])
      setStatus(s)
      if (st) setState(st)

      const [b, h] = await Promise.allSettled([
        api.getBalance(),
        api.getHistory(),
      ])
      if (b.status === 'fulfilled') setBalance(b.value)
      if (h.status === 'fulfilled') setHistory(h.value.history ?? [])
    } catch {
      // Silently ignore offline backend calls
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(id)
  }, [refresh])

  const runTxWithModal = useCallback(
    async (
      action: TxModalProgressState['action'],
      title: string,
      targetCommitment: string | undefined,
      fn: () => Promise<TxResponse>
    ) => {
      setBusy(action)
      setTxProgress({
        open: true,
        action,
        step: 'witness',
        title,
        commitment: targetCommitment,
      })

      // Step 1: Witness generation simulation
      await new Promise((r) => setTimeout(r, 600))
      setTxProgress((prev) => (prev ? { ...prev, step: 'proving' } : null))

      // Step 2: ZK Proof generation simulation
      await new Promise((r) => setTimeout(r, 900))
      setTxProgress((prev) => (prev ? { ...prev, step: 'signing' } : null))

      // Step 3: Wallet Signing simulation
      await new Promise((r) => setTimeout(r, 700))
      setTxProgress((prev) => (prev ? { ...prev, step: 'confirming' } : null))

      try {
        const tx = await fn()
        setTxProgress((prev) =>
          prev
            ? {
                ...prev,
                step: 'done',
                txId: tx.txId,
                blockHeight: tx.blockHeight,
                commitment: tx.commitment || targetCommitment,
                message: tx.message,
              }
            : null
        )
        showToast('success', `${tx.message} (tx ${shortHex(tx.txId, 8, 6)})`)
        await refresh()
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : `${title} failed`
        // Contract assertion errors (409) are warnings, not fatal errors
        const isWarning = errMsg.includes('Please wait') || errMsg.includes('already') || errMsg.includes('Only the') || errMsg.includes('does not match') || errMsg.includes('not been approved') || errMsg.includes('been revoked') || errMsg.includes('No pending')
        setTxProgress((prev) =>
          prev ? { ...prev, step: 'error', error: errMsg } : null
        )
        showToast(isWarning ? 'info' : 'error', errMsg)
      } finally {
        setBusy(null)
      }
    },
    [refresh, showToast]
  )

  const credentials = useMemo<CredentialEntry[]>(() => {
    if (!state) return []
    const pending = new Set(state.pendingCredentials)
    const approved = new Set(state.credentials)
    const revoked = new Set(state.revokedCredentials)
    const all = new Set<string>([...pending, ...approved, ...revoked])
    return [...all].map((commitment) => ({
      commitment,
      status: revoked.has(commitment)
        ? ('revoked' as const)
        : approved.has(commitment)
          ? ('approved' as const)
          : ('pending' as const),
    }))
  }, [state])

  const handleIssue = useCallback(async () => {
    if (deployedContract && connectedWallet && !connectedWallet.isWebWallet) {
      const secret = await getDeterministicSecret(connectedWallet.address);
      const realCommitment = await computeRealCommitment(secret);
      
      void runTxWithModal('issueCredential', 'Request KYC Credential (Lace Wallet ZK)', realCommitment, async () => {
        console.log('[Lace ZK] Calling issueCredential circuit...');
        setTxProgress((prev: any) => prev ? { ...prev, step: 'proving', message: 'Generating local ZK proof...' } : null);
        
        // Execute the circuit client-side!
        const tx = await deployedContract.callTx.issueCredential();
        
        setTxProgress((prev: any) => prev ? { ...prev, step: 'signing', message: 'Submitting transaction via Lace Wallet...', txId: tx.public.txId, blockHeight: tx.public.blockHeight } : null);
        
        // Log transaction to backend audit server
        await api.recordAudit({
          action: 'issueCredential',
          txId: tx.public.txId,
          blockHeight: tx.public.blockHeight,
          commitment: realCommitment,
          message: 'Credential request submitted client-side via Lace Wallet. ZK proof generated locally.',
        }).catch(console.warn);

        return {
          txId: tx.public.txId,
          blockHeight: tx.public.blockHeight,
          commitment: realCommitment,
          message: 'Credential request submitted client-side via Lace Wallet. ZK proof generated locally.',
        };
      });
    } else {
      let customC: string | undefined = undefined
      if (connectedWallet) {
        customC = await simulateCommitment(connectedWallet.address)
      }
      void runTxWithModal('issueCredential', 'Request KYC Credential', customC, () =>
        api.issueCredential(customC)
      )
    }
  }, [deployedContract, connectedWallet, runTxWithModal])

  const handleApprove = useCallback(
    (commitment: string) => {
      void runTxWithModal('approveCredential', 'Authority Approve Credential', commitment, () =>
        api.approveCredential(commitment)
      )
    },
    [runTxWithModal]
  )

  const handleProve = useCallback(
    (commitment: string) => {
      if (deployedContract && connectedWallet && !connectedWallet.isWebWallet) {
        void runTxWithModal('proveEligibility', 'ZK Prove Eligibility (Lace Wallet ZK)', commitment, async () => {
          console.log('[Lace ZK] Calling proveEligibility circuit for commitment:', commitment);
          setTxProgress((prev: any) => prev ? { ...prev, step: 'proving', message: 'Generating local ZK proof...' } : null);

          // Convert hex commitment to Bytes<32>
          const commitmentBytes = new Uint8Array(Buffer.from(commitment, 'hex'));
          const tx = await deployedContract.callTx.proveEligibility(commitmentBytes);

          setTxProgress((prev: any) => prev ? { ...prev, step: 'signing', message: 'Submitting transaction via Lace Wallet...', txId: tx.public.txId, blockHeight: tx.public.blockHeight } : null);

          // Log transaction to backend audit server
          await api.recordAudit({
            action: 'proveEligibility',
            txId: tx.public.txId,
            blockHeight: tx.public.blockHeight,
            commitment,
            message: 'Eligibility proven client-side with a local ZK proof. Identity stays private.',
          }).catch(console.warn);

          return {
            txId: tx.public.txId,
            blockHeight: tx.public.blockHeight,
            commitment,
            message: 'Eligibility proven client-side with a local ZK proof. Identity stays private.',
          };
        });
      } else {
        void runTxWithModal('proveEligibility', 'Zero-Knowledge Prove Eligibility', commitment, () =>
          api.proveEligibility(commitment)
        )
      }
    },
    [deployedContract, connectedWallet, runTxWithModal]
  )

  const handleRevoke = useCallback(
    (commitment: string) => {
      void runTxWithModal('revokeCredential', 'Revoke Credential Authorization', commitment, () =>
        api.revokeCredential(commitment)
      )
    },
    [runTxWithModal]
  )

  const handleCustomProve = useCallback(() => {
    const c = commitmentInput.trim()
    if (!/^[0-9a-fA-F]{64}$/.test(c)) {
      showToast('error', 'Enter a valid 64-character hex commitment')
      return
    }
    if (deployedContract && connectedWallet && !connectedWallet.isWebWallet) {
      void runTxWithModal('proveEligibility', 'ZK Prove Custom Commitment (Lace Wallet ZK)', c, async () => {
        console.log('[Lace ZK] Calling proveEligibility circuit for custom commitment:', c);
        setTxProgress((prev: any) => prev ? { ...prev, step: 'proving', message: 'Generating local ZK proof...' } : null);

        const commitmentBytes = new Uint8Array(Buffer.from(c, 'hex'));
        const tx = await deployedContract.callTx.proveEligibility(commitmentBytes);

        setTxProgress((prev: any) => prev ? { ...prev, step: 'signing', message: 'Submitting transaction via Lace Wallet...', txId: tx.public.txId, blockHeight: tx.public.blockHeight } : null);

        await api.recordAudit({
          action: 'proveEligibility',
          txId: tx.public.txId,
          blockHeight: tx.public.blockHeight,
          commitment: c,
          message: 'Custom eligibility proven client-side with a local ZK proof.',
        }).catch(console.warn);

        return {
          txId: tx.public.txId,
          blockHeight: tx.public.blockHeight,
          commitment: c,
          message: 'Custom eligibility proven client-side with a local ZK proof.',
        };
      });
    } else {
      void runTxWithModal('proveEligibility', 'Zero-Knowledge Prove Custom Commitment', c, () =>
        api.proveEligibility(c)
      )
    }
  }, [commitmentInput, deployedContract, connectedWallet, runTxWithModal, showToast])

  if (loading) {
    return (
      <div className="app-loading">
        <div className="spinner" />
        <p>Connecting to Shadow-KYC Smart Contract on Midnight Network…</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">🛡️</div>
          <div>
            <h1>Shadow-KYC</h1>
            <p className="tagline">Zero-Knowledge Compliance on Midnight Network</p>
          </div>
        </div>
        <div className="header-meta">
          <span className={`pill ${status ? 'pill-ok' : 'pill-err'}`}>
            {status ? `● ${formatNetworkName(status.network)}` : '● offline'}
          </span>
          {connectedWallet ? (
            <>
              <span
                className="pill pill-neutral"
                style={{ cursor: 'pointer', borderColor: 'var(--emerald-border)' }}
                onClick={() => setShowWalletSuccessPop(connectedWallet)}
                title="Click to view connected wallet details"
              >
                💳 {connectedWallet.name}: {shortHex(connectedWallet.address, 6, 4)}
              </span>
              <span className="pill pill-neutral">
                💰 {Number(connectedWallet.tNight).toLocaleString()} tNIGHT
              </span>
              <button className="btn btn-secondary btn-small" onClick={disconnectWallet}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              {balance && (
                <span className="pill pill-neutral">
                  Backend: {Number(balance.tNight).toLocaleString()} tNIGHT
                </span>
              )}
              <button className="btn btn-primary btn-small" onClick={() => setShowWalletModal(true)}>
                Connect Wallet
              </button>
            </>
          )}
        </div>
      </header>

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}

      <nav className="tabs">
        <button
          className={activeTab === 'overview' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('overview')}
        >
          Overview & ZK Visualizer
        </button>
        <button
          className={activeTab === 'user' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('user')}
        >
          User Actions (Request / Prove)
        </button>
        <button
          className={activeTab === 'authority' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('authority')}
        >
          Authority Actions (Approve / Revoke)
        </button>
        <button
          className={activeTab === 'audit' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('audit')}
        >
          Audit History ({history.length})
        </button>
      </nav>

      <main className="content">
        {activeTab === 'overview' && (
          <Overview
            status={status}
            state={state}
            credentials={credentials}
            balance={balance}
            connectedWallet={connectedWallet}
            onCopy={copyToClipboard}
          />
        )}

        {activeTab === 'user' && (
          <UserActions
            busy={busy}
            credentials={credentials}
            connectedWallet={connectedWallet}
            commitmentInput={commitmentInput}
            setCommitmentInput={setCommitmentInput}
            onIssue={handleIssue}
            onProve={handleProve}
            onCustomProve={handleCustomProve}
            onCopy={copyToClipboard}
          />
        )}

        {activeTab === 'authority' && (
          <AuthorityActions
            busy={busy}
            credentials={credentials}
            onApprove={handleApprove}
            onRevoke={handleRevoke}
            onCopy={copyToClipboard}
          />
        )}

        {activeTab === 'audit' && (
          <AuditTab history={history} onCopy={copyToClipboard} />
        )}
      </main>

      <footer className="app-footer">
        <p>
          Powered by <strong>Midnight Network</strong> Zero-Knowledge Smart Contracts.
          Identity secrets are never revealed or stored on-chain.
        </p>
      </footer>

      {/* ── Wallet Selector Modal ── */}
      {showWalletModal && (
        <div className="wallet-modal-overlay">
          <div className="wallet-modal">
            <div className="wallet-modal-header">
              <h2>Connect Midnight Wallet</h2>
              <button className="close-btn" onClick={() => setShowWalletModal(false)}>✕</button>
            </div>
            <div className="wallet-modal-body">
              <div className="wallet-list">
                <p className="wallet-list-sub">Select an injected extension or instant web wallet:</p>

                {/* Instant Devnet Web Wallet Option */}
                <button
                  className="wallet-item-btn"
                  onClick={connectWebWallet}
                  disabled={isConnectingWallet}
                  style={{ background: 'rgba(16, 185, 129, 0.08)', borderColor: 'var(--emerald-border)' }}
                >
                  <span className="wallet-icon">⚡</span>
                  <div className="wallet-info">
                    <span className="wallet-name" style={{ color: '#fff' }}>
                      Midnight Devnet Web Wallet
                    </span>
                    <span className="wallet-meta" style={{ color: 'var(--emerald)' }}>
                      Instant Connect (10,000 tNIGHT pre-funded)
                    </span>
                  </div>
                  <span className="wallet-arrow">➔</span>
                </button>

                {/* Injected Extensions */}
                {availableWallets.map((wallet) => (
                  <button
                    key={wallet.id}
                    className="wallet-item-btn"
                    onClick={() => void connectWallet(wallet.id)}
                    disabled={isConnectingWallet}
                  >
                    <span className="wallet-icon">💳</span>
                    <div className="wallet-info">
                      <span className="wallet-name">{wallet.name}</span>
                      <span className="wallet-meta">Injected Extension API (v4+)</span>
                    </div>
                    <span className="wallet-arrow">➔</span>
                  </button>
                ))}
              </div>

              {availableWallets.length === 0 && (
                <div className="no-wallets-found" style={{ marginTop: '20px' }}>
                  <p className="no-wallets-sub">
                    Install a Midnight compatible Chrome extension for hardware/browser wallet integration:
                  </p>
                  <div className="download-links">
                    <a href="https://1am.xyz" target="_blank" rel="noopener noreferrer" className="download-link">
                      📥 Install 1AM Wallet
                    </a>
                    <a href="https://lace.io" target="_blank" rel="noopener noreferrer" className="download-link">
                      📥 Install Lace Wallet
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Wallet Connection Pop-up Message Modal ── */}
      {showWalletSuccessPop && (
        <div className="tx-modal-overlay">
          <div className="wallet-pop-card">
            <div className="wallet-pop-header">
              <div className="wallet-pop-icon">💳</div>
              <div>
                <h3>Wallet Connected!</h3>
                <p>● Ready for Zero-Knowledge Transactions</p>
              </div>
            </div>
            <div className="wallet-pop-details">
              <div className="wallet-pop-row">
                <span className="wallet-pop-label">Provider Name:</span>
                <span className="wallet-pop-value">{showWalletSuccessPop.name}</span>
              </div>
              <div className="wallet-pop-row">
                <span className="wallet-pop-label">Active Network:</span>
                <span className="wallet-pop-value">{showWalletSuccessPop.network || 'Midnight Devnet'}</span>
              </div>
              <div className="wallet-pop-row">
                <span className="wallet-pop-label">Account Address:</span>
                <span
                  className="wallet-pop-value mono"
                  style={{ cursor: 'pointer', color: 'var(--accent-light)' }}
                  onClick={() => copyToClipboard(showWalletSuccessPop.address, 'Wallet Address')}
                >
                  {shortHex(showWalletSuccessPop.address, 10, 8)} 📋
                </span>
              </div>
              <div className="wallet-pop-row">
                <span className="wallet-pop-label">tNIGHT Balance:</span>
                <span className="wallet-pop-value" style={{ color: 'var(--emerald)' }}>
                  {Number(showWalletSuccessPop.tNight).toLocaleString()} tNIGHT
                </span>
              </div>
              {showWalletSuccessPop.dust && (
                <div className="wallet-pop-row">
                  <span className="wallet-pop-label">DUST Balance:</span>
                  <span className="wallet-pop-value" style={{ color: 'var(--accent-light)' }}>
                    {Number(showWalletSuccessPop.dust).toLocaleString()} DUST
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setShowWalletSuccessPop(null)}>
                ✓ Continue to DApp
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transaction & ZK Proof Processing Pop-up Modal ── */}
      {txProgress && txProgress.open && (
        <div className="tx-modal-overlay">
          <div className="tx-modal-card">
            <div className="tx-modal-title-row">
              <h3>
                <span>⚡</span> {txProgress.title}
              </h3>
              {txProgress.step === 'done' || txProgress.step === 'error' ? (
                <button className="close-btn" onClick={() => setTxProgress(null)}>✕</button>
              ) : null}
            </div>

            <div className="tx-progress-bar-bg">
              <div
                className="tx-progress-bar-fill"
                style={{
                  width:
                    txProgress.step === 'witness'
                      ? '25%'
                      : txProgress.step === 'proving'
                      ? '55%'
                      : txProgress.step === 'signing'
                      ? '80%'
                      : txProgress.step === 'confirming'
                      ? '95%'
                      : '100%',
                  background:
                    txProgress.step === 'error'
                      ? 'var(--rose)'
                      : txProgress.step === 'done'
                      ? 'var(--emerald)'
                      : undefined,
                }}
              />
            </div>

            <div className="tx-steps-container">
              <div className={`tx-step-card ${txProgress.step === 'witness' ? 'active' : ['proving', 'signing', 'confirming', 'done'].includes(txProgress.step) ? 'done' : ''}`}>
                <div className="tx-step-icon">1</div>
                <div className="tx-step-info">
                  <span className="tx-step-name">Local Secret Witness</span>
                  <span className="tx-step-desc">Generating SHA-256 identity commitment (never revealed on-chain)</span>
                </div>
              </div>

              <div className={`tx-step-card ${txProgress.step === 'proving' ? 'active' : ['signing', 'confirming', 'done'].includes(txProgress.step) ? 'done' : ''}`}>
                <div className="tx-step-icon">2</div>
                <div className="tx-step-info">
                  <span className="tx-step-name">Zero-Knowledge Proof (ZKP)</span>
                  <span className="tx-step-desc">Executing Compact circuit proof on Midnight Proof Server</span>
                </div>
              </div>

              <div className={`tx-step-card ${txProgress.step === 'signing' ? 'active' : ['confirming', 'done'].includes(txProgress.step) ? 'done' : ''}`}>
                <div className="tx-step-icon">3</div>
                <div className="tx-step-info">
                  <span className="tx-step-name">Wallet Signature</span>
                  <span className="tx-step-desc">Authenticating transaction with connected Midnight wallet</span>
                </div>
              </div>

              <div className={`tx-step-card ${txProgress.step === 'confirming' || txProgress.step === 'done' ? (txProgress.step === 'done' ? 'done' : 'active') : ''}`}>
                <div className="tx-step-icon">4</div>
                <div className="tx-step-info">
                  <span className="tx-step-name">Ledger Block Inclusion</span>
                  <span className="tx-step-desc">Broadcasting to Midnight Network node & storing commitment</span>
                </div>
              </div>
            </div>

            {txProgress.step === 'done' && (
              <div className="wallet-pop-details" style={{ borderColor: 'var(--emerald-border)', background: 'rgba(16, 185, 129, 0.08)' }}>
                <p style={{ margin: 0, fontWeight: 600, color: 'var(--emerald)', fontSize: 14 }}>
                  ✓ Transaction Confirmed on Midnight Ledger!
                </p>
                {txProgress.txId && (
                  <div className="wallet-pop-row" style={{ marginTop: 8 }}>
                    <span className="wallet-pop-label">Tx ID:</span>
                    <span className="mono" style={{ cursor: 'pointer', color: 'var(--accent-light)' }} onClick={() => copyToClipboard(txProgress.txId!, 'Tx ID')}>
                      {shortHex(txProgress.txId, 10, 8)} 📋
                    </span>
                  </div>
                )}
                {txProgress.blockHeight && (
                  <div className="wallet-pop-row">
                    <span className="wallet-pop-label">Block Height:</span>
                    <span className="wallet-pop-value">#{txProgress.blockHeight}</span>
                  </div>
                )}
                {txProgress.commitment && (
                  <div className="wallet-pop-row">
                    <span className="wallet-pop-label">Commitment:</span>
                    <span className="mono" style={{ cursor: 'pointer', color: 'var(--accent-light)' }} onClick={() => copyToClipboard(txProgress.commitment!, 'Commitment')}>
                      {shortHex(txProgress.commitment, 10, 8)} 📋
                    </span>
                  </div>
                )}
              </div>
            )}

            {txProgress.step === 'error' && (() => {
              const isWarning = txProgress.error && (
                txProgress.error.includes('Please wait') ||
                txProgress.error.includes('already') ||
                txProgress.error.includes('Only the') ||
                txProgress.error.includes('does not match') ||
                txProgress.error.includes('not been approved') ||
                txProgress.error.includes('been revoked') ||
                txProgress.error.includes('No pending')
              )
              return (
                <div className="wallet-pop-details" style={{
                  borderColor: isWarning ? 'var(--amber, #f59e0b)' : 'var(--rose-border)',
                  background: isWarning ? 'rgba(245, 158, 11, 0.08)' : 'rgba(244, 63, 94, 0.08)'
                }}>
                  <p style={{ margin: 0, fontWeight: 600, color: isWarning ? '#f59e0b' : 'var(--rose)', fontSize: 14 }}>
                    {isWarning ? '⚠️' : '❌'} {isWarning ? '' : 'Transaction Error: '}{txProgress.error}
                  </p>
                </div>
              )
            })()}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              {txProgress.step === 'done' || txProgress.step === 'error' ? (
                <button className="btn btn-primary" onClick={() => setTxProgress(null)}>
                  Close Receipt
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--accent-light)' }}>
                  <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                  <span>Processing ZK Transaction…</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Overview Tab ──────────────────────────────────────────────────────────────

function Overview({
  status,
  state,
  credentials,
  balance,
  connectedWallet,
  onCopy,
}: {
  status: ServerStatus | null
  state: ContractState | null
  credentials: CredentialEntry[]
  balance: BalanceInfo | null
  connectedWallet: ConnectedWalletInfo | null
  onCopy: (text: string, label: string) => void
}) {
  const pending = credentials.filter((c) => c.status === 'pending').length
  const approved = credentials.filter((c) => c.status === 'approved').length
  const revoked = credentials.filter((c) => c.status === 'revoked').length

  const [simSecret, setSimSecret] = useState('user_alice_passport_2026')
  const [simHash, setSimHash] = useState('')

  useEffect(() => {
    void simulateCommitment(simSecret).then(setSimHash)
  }, [simSecret])

  return (
    <div className="overview">
      <section className="card hero-card">
        <h2>Zero-Knowledge Privacy Compliance Protocol</h2>
        <p>
          Shadow-KYC allows users to prove regulatory compliance (KYC/AML) to smart contracts
          without disclosing identity documents, names, or personal details to observers or validators.
        </p>

        <div className="zk-workflow">
          <div className="zk-step">
            <div className="zk-step-header">
              <span className="zk-step-num">STEP 1</span>
              <span className="zk-badge badge-private">Private Witness</span>
            </div>
            <h3>Local Identity Secret</h3>
            <p>User holds a secret identity key (<code className="mono">localSecret</code>) on their device. Never transmitted.</p>
          </div>

          <div className="zk-step">
            <div className="zk-step-header">
              <span className="zk-step-num">STEP 2</span>
              <span className="zk-badge badge-public">On-Chain Commitment</span>
            </div>
            <h3>Credential Hash</h3>
            <p>Hash commitment stored in contract set (<code className="mono">credentials</code>) upon authority approval.</p>
          </div>

          <div className="zk-step">
            <div className="zk-step-header">
              <span className="zk-step-num">STEP 3</span>
              <span className="zk-badge badge-private">ZK Verification</span>
            </div>
            <h3>Zero-Knowledge Proof</h3>
            <p>User proves secret knowledge & validity without revealing secret. Increments <code className="mono">eligibilityCount</code>.</p>
          </div>
        </div>

        <div className="privacy-note">
          <span className="privacy-icon">⚡</span>
          <p>
            <strong>Interactive Privacy Visualizer:</strong> See how your local identity secret maps to a 32-byte on-chain commitment below.
          </p>
        </div>

        <div className="generator-box">
          {connectedWallet && (
            <div className="gen-row" style={{ marginBottom: '14px', gap: '12px', alignItems: 'center' }}>
              <span className="gen-label">Selected Account:</span>
              <span className="gen-value" style={{ flexGrow: 1, fontFamily: 'var(--mono)' }}>
                {connectedWallet.name} ({shortHex(connectedWallet.address, 10, 8)})
              </span>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => setSimSecret(connectedWallet.address)}
              >
                Use Wallet Address as Secret
              </button>
            </div>
          )}
          <div className="gen-row">
            <span className="gen-label">1. Local Secret:</span>
            <input
              type="text"
              value={simSecret}
              onChange={(e) => setSimSecret(e.target.value)}
              placeholder="Enter local identity secret..."
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid var(--glass-border)',
                background: 'rgba(0,0,0,0.5)',
                color: '#fff',
                fontFamily: 'var(--mono)',
                fontSize: '13px',
              }}
            />
          </div>
          <div className="gen-row">
            <span className="gen-label">2. Derived Commitment:</span>
            <span className="gen-value">{simHash || 'Calculating...'}</span>
            <button
              className="btn btn-icon"
              onClick={() => onCopy(simHash, 'Simulated Commitment')}
              title="Copy Commitment"
            >
              📋
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>On-Chain Ledger State</h2>
        <dl className="stat-grid">
          <div>
            <dt>Authority Name</dt>
            <dd>{state?.authorityName ?? '—'}</dd>
          </div>
          <div>
            <dt>Active Network</dt>
            <dd>{formatNetworkName(status?.network)}</dd>
          </div>
          <div>
            <dt>Contract Address</dt>
            <dd className="mono">
              {status?.contractAddress ? (
                <span
                  style={{ cursor: 'pointer' }}
                  onClick={() => onCopy(status.contractAddress, 'Contract Address')}
                  title="Click to copy"
                >
                  {shortHex(status.contractAddress, 16, 12)} 📋
                </span>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Eligibility Verifications</dt>
            <dd>{state ? formatCount(state.eligibilityCount) : '—'}</dd>
          </div>
        </dl>
        {balance && (
          <p className="balance-line">
            Connected Wallet Address: <span className="mono">{shortHex(balance.address, 14, 10)}</span> ·{' '}
            <strong>{Number(balance.tNight).toLocaleString()} tNIGHT</strong> ·{' '}
            {Number(balance.dust).toLocaleString()} DUST
          </p>
        )}
      </section>

      <section className="card">
        <h2>Credential Registry Summary</h2>
        <div className="stat-cards">
          <div className="stat-card stat-pending">
            <span className="stat-num">{pending}</span>
            <span className="stat-label">Pending</span>
          </div>
          <div className="stat-card stat-approved">
            <span className="stat-num">{approved}</span>
            <span className="stat-label">Approved</span>
          </div>
          <div className="stat-card stat-revoked">
            <span className="stat-num">{revoked}</span>
            <span className="stat-label">Revoked</span>
          </div>
        </div>
        {credentials.length === 0 ? (
          <p className="empty">No commitments stored yet. Request a credential in the User Actions tab.</p>
        ) : (
          <ul className="credential-list">
            {credentials.map((c) => (
              <li key={c.commitment} className={`credential-item status-${c.status}`}>
                <span className="status-dot" />
                <span className="mono">{shortHex(c.commitment, 18, 14)}</span>
                <button
                  className="btn btn-icon"
                  onClick={() => onCopy(c.commitment, 'Commitment')}
                  title="Copy full commitment"
                >
                  📋
                </button>
                <span className="status-label">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ─── User Actions Tab ──────────────────────────────────────────────────────────

function UserActions({
  busy,
  credentials,
  connectedWallet,
  commitmentInput,
  setCommitmentInput,
  onIssue,
  onProve,
  onCustomProve,
  onCopy,
}: {
  busy: string | null
  credentials: CredentialEntry[]
  connectedWallet: ConnectedWalletInfo | null
  commitmentInput: string
  setCommitmentInput: (v: string) => void
  onIssue: () => void
  onProve: (commitment: string) => void
  onCustomProve: () => void
  onCopy: (text: string, label: string) => void
}) {
  const approved = credentials.filter((c) => c.status === 'approved')

  return (
    <div className="actions">
      <section className="card">
        <h2>1. Request a KYC/AML Credential</h2>
        <p>
          Submit a new credential request to the compliance authority. Your identity secret is hashed
          into a commitment stored in <code className="mono">pendingCredentials</code>.
        </p>
        {connectedWallet && (
          <p style={{ fontSize: '13px', color: 'var(--emerald)', marginBottom: '14px' }}>
            💳 Connected as <strong>{connectedWallet.name}</strong> ({shortHex(connectedWallet.address, 8, 6)}). Request will be bound to your wallet commitment!
          </p>
        )}
        <button
          className="btn btn-primary"
          onClick={onIssue}
          disabled={busy !== null}
        >
          {busy === 'issueCredential' ? (
            <>
              <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
              Submitting Request…
            </>
          ) : (
            '➕ Request Credential'
          )}
        </button>
      </section>

      <section className="card">
        <h2>2. Prove Eligibility (Zero-Knowledge Proof)</h2>
        <p>
          Generate a ZK proof to verify you hold an approved credential without disclosing your identity
          secret. Select an approved commitment below or paste a custom commitment.
        </p>

        {approved.length === 0 ? (
          <p className="empty">
            No approved credentials available to prove. Request one above and wait for authority approval.
          </p>
        ) : (
          <ul className="credential-list">
            {approved.map((c) => (
              <li key={c.commitment} className="credential-item status-approved">
                <span className="status-dot" />
                <span className="mono">{shortHex(c.commitment, 18, 14)}</span>
                <button
                  className="btn btn-icon"
                  onClick={() => onCopy(c.commitment, 'Commitment')}
                  title="Copy Commitment"
                >
                  📋
                </button>
                <button
                  className="btn btn-small btn-secondary"
                  onClick={() => onProve(c.commitment)}
                  disabled={busy !== null}
                >
                  {busy === 'proveEligibility' ? 'Proving ZK…' : '⚡ Prove Eligibility'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="inline-form">
          <input
            type="text"
            placeholder="Paste a 64-character hex commitment string…"
            value={commitmentInput}
            onChange={(e) => setCommitmentInput(e.target.value)}
            spellCheck={false}
          />
          <button
            className="btn btn-secondary"
            onClick={onCustomProve}
            disabled={busy !== null}
          >
            {busy === 'proveEligibility' ? 'Proving…' : 'Prove Custom'}
          </button>
        </div>
      </section>
    </div>
  )
}

// ─── Authority Tab ─────────────────────────────────────────────────────────────

function AuthorityActions({
  busy,
  credentials,
  onApprove,
  onRevoke,
  onCopy,
}: {
  busy: string | null
  credentials: CredentialEntry[]
  onApprove: (commitment: string) => void
  onRevoke: (commitment: string) => void
  onCopy: (text: string, label: string) => void
}) {
  const pending = credentials.filter((c) => c.status === 'pending')
  const approved = credentials.filter((c) => c.status === 'approved')

  return (
    <div className="actions">
      <section className="card">
        <h2>Approve Pending Credential Requests</h2>
        <p>
          Review credential requests submitted by users. Approving moves the commitment from{' '}
          <code className="mono">pendingCredentials</code> to <code className="mono">credentials</code>.
        </p>
        {pending.length === 0 ? (
          <p className="empty">No pending credential requests awaiting approval.</p>
        ) : (
          <ul className="credential-list">
            {pending.map((c) => (
              <li key={c.commitment} className="credential-item status-pending">
                <span className="status-dot" />
                <span className="mono">{shortHex(c.commitment, 18, 14)}</span>
                <button
                  className="btn btn-icon"
                  onClick={() => onCopy(c.commitment, 'Commitment')}
                  title="Copy Commitment"
                >
                  📋
                </button>
                <button
                  className="btn btn-small btn-approve"
                  onClick={() => onApprove(c.commitment)}
                  disabled={busy !== null}
                >
                  {busy === 'approveCredential' ? 'Approving…' : '✓ Approve'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Revoke Active Credentials</h2>
        <p>
          Revoke compliance authorization for a commitment. Revoked credentials cannot be used for ZK eligibility verification.
        </p>
        {approved.length === 0 ? (
          <p className="empty">No active approved credentials to revoke.</p>
        ) : (
          <ul className="credential-list">
            {approved.map((c) => (
              <li key={c.commitment} className="credential-item status-approved">
                <span className="status-dot" />
                <span className="mono">{shortHex(c.commitment, 18, 14)}</span>
                <button
                  className="btn btn-icon"
                  onClick={() => onCopy(c.commitment, 'Commitment')}
                  title="Copy Commitment"
                >
                  📋
                </button>
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => onRevoke(c.commitment)}
                  disabled={busy !== null}
                >
                  {busy === 'revokeCredential' ? 'Revoking…' : '🚫 Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ─── Audit History Tab ─────────────────────────────────────────────────────────

function AuditTab({
  history,
  onCopy,
}: {
  history: AuditRecord[]
  onCopy: (text: string, label: string) => void
}) {
  return (
    <div className="actions">
      <section className="card">
        <h2>Transaction & ZK Proof Audit History</h2>
        <p>Real-time log of transactions submitted to the Midnight contract during this session.</p>

        {history.length === 0 ? (
          <p className="empty">No audit history recorded yet. Perform actions to view transaction receipts.</p>
        ) : (
          <ul className="history-list">
            {history.map((item) => (
              <li key={item.id} className="history-item">
                <div className="history-header">
                  <span className="history-action">⚡ {item.action}</span>
                  <span className="history-time">{new Date(item.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="history-body">{item.message}</div>
                <div className="history-meta">
                  <span>Block: #{item.blockHeight}</span>
                  <span>
                    Tx ID:{' '}
                    <code
                      className="mono"
                      style={{ cursor: 'pointer', color: 'var(--accent-light)' }}
                      onClick={() => onCopy(item.txId, 'Tx ID')}
                    >
                      {shortHex(item.txId, 10, 8)} 📋
                    </code>
                  </span>
                  {item.commitment && (
                    <span>
                      Commitment:{' '}
                      <code
                        className="mono"
                        style={{ cursor: 'pointer', color: 'var(--accent-light)' }}
                        onClick={() => onCopy(item.commitment!, 'Commitment')}
                      >
                        {shortHex(item.commitment, 8, 6)} 📋
                      </code>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default App