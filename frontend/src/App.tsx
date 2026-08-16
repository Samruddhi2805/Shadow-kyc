import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { Buffer } from 'buffer'
import { findDeployedContract, type FoundContract } from '@midnight-ntwrk/midnight-js-contracts'
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import * as ShadowKyc from '../../contracts/managed/shadow-kyc/contract/index.js'
import type { Contract as ShadowKycContract } from '../../contracts/managed/shadow-kyc/contract/index.js'
import type { InitialAPI, ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api'
import { initializeClientProviders, type ShadowKycPrivateState } from './providers'

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

// ShadowKycPrivateState is imported from providers.ts

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

// initializeClientProviders is imported from providers.ts

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

// Module-scoped connection cache to survive React StrictMode remounts
let globalConnectingPromise: Promise<ConnectedAPI> | null = null;
let globalConnectedAPI: ConnectedAPI | null = null;
let globalConnectedWallet: ConnectedWalletInfo | null = null;
let globalDeployedContract: FoundContract<ShadowKycContract<ShadowKycPrivateState>> | null = null;
let globalContractInitFailed = false;

async function validateConnectedAPI(api: ConnectedAPI): Promise<boolean> {
  try {
    await api.getUnshieldedAddress();
    return true;
  } catch (err) {
    console.warn('[Lace Connect] Cached ConnectedAPI is stale:', err);
    return false;
  }
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
  const [contractInitFailed, setContractInitFailed] = useState<boolean>(globalContractInitFailed)
  const connectedApiRef = useRef<ConnectedAPI | null>(null)
  const connectingRef = useRef(false)



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
    
    // Only update availableWallets if the list of keys actually changed
    setAvailableWallets((prev) => {
      const prevKeys = prev.map(w => w.id);
      const hasChanged = keys.length !== prevKeys.length || keys.some(k => !prevKeys.includes(k));
      if (!hasChanged) return prev;
      return keys.map((id) => ({
        id,
        name: window.midnight![id]?.name || id,
      }));
    });
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      console.log('=== Midnight Wallet Detection Diagnostics ===');
      console.log('window.midnight exists:', !!window.midnight);
      if (window.midnight) {
        const keys = Object.keys(window.midnight);
        console.log('Keys under window.midnight:', keys);
        keys.forEach(key => {
          const apiObj = window.midnight![key];
          console.log(`Wallet Key: "${key}"`, {
            name: apiObj?.name,
            apiVersion: apiObj?.apiVersion,
            rdns: apiObj?.rdns,
            iconExists: !!apiObj?.icon,
            properties: Object.keys(apiObj || {}),
            isLace: key.toLowerCase().includes('lace') || apiObj?.name?.toLowerCase().includes('lace')
          });
        });
      } else {
        console.log('window.midnight is undefined/null');
      }
      console.log('============================================');
    }
  }, [])

  useEffect(() => {
    scanWallets()
    const id = window.setInterval(scanWallets, 1500)
    return () => window.clearInterval(id)
  }, [])

  const connectWallet = useCallback(async (walletId: string, isAutoConnect = false) => {
    globalContractInitFailed = false;
    setContractInitFailed(false);
    if (connectingRef.current) {
      console.log('[Wallet Connect] Connection already in progress, ignoring duplicate call.');
      return;
    }

    if (typeof window === 'undefined' || !window.midnight || !window.midnight[walletId]) {
      if (!isAutoConnect) {
        showToast('error', 'Selected wallet extension is not detected in your browser.');
      }
      return;
    }

    // Verify that the selected wallet is actually Lace (or has 'lace' in ID/name)
    const walletObj = window.midnight[walletId];
    const isLace = walletId.toLowerCase().includes('lace') || (walletObj?.name || '').toLowerCase().includes('lace');
    if (!isLace) {
      if (!isAutoConnect) {
        showToast('error', 'Only Lace Wallet is supported for this application.');
      }
      return;
    }

    // If we already have a fully established and active connection, validate it.
    if (globalConnectedAPI && globalConnectedWallet && globalConnectedWallet.id === walletId) {
      console.log('[Lace Connect] Validating cached ConnectedAPI...');
      const isValid = await validateConnectedAPI(globalConnectedAPI);
      if (isValid) {
        console.log('[Lace Connect] Restoring existing active connection from global cache.');
        setConnectedWallet(globalConnectedWallet);
        if (globalDeployedContract) setDeployedContract(globalDeployedContract);
        setContractInitFailed(globalContractInitFailed);
        connectedApiRef.current = globalConnectedAPI;
        setShowWalletModal(false);
        if (!isAutoConnect) {
          showToast('success', `Successfully connected to ${walletObj.name || 'Lace'}!`);
        }
        return;
      } else {
        console.warn('[Lace Connect] Cached ConnectedAPI is stale. Clearing cache and reconnecting...');
        globalConnectedAPI = null;
        globalConnectedWallet = null;
        globalDeployedContract = null;
        globalConnectingPromise = null;
        connectedApiRef.current = null;
        setConnectedWallet(null);
        setDeployedContract(null);
        setContractInitFailed(false);
      }
    }

    connectingRef.current = true;
    setIsConnectingWallet(true);
    if (!isAutoConnect) {
      showToast('info', `Connecting to ${walletObj.name || 'Lace'}... Please check your wallet extension popup.`);
    }

    try {
      const defaultNet = import.meta.env.VITE_NETWORK || 'preprod';
      const targetNetwork = (status?.network || defaultNet) === 'preview' ? 'preview' : (((status?.network || defaultNet) === 'preprod') ? 'preprod' : 'testnet');
      
      let walletApi: ConnectedAPI | null = null;
      let lastErr: any = null;

      const legacyWallet = walletObj as unknown as {
        connect?: (networkId?: string) => Promise<ConnectedAPI>;
        enable?: () => Promise<ConnectedAPI>;
      };

      if (globalConnectingPromise) {
        console.log('[Lace Connect] Reusing existing pending connection promise...');
        walletApi = await globalConnectingPromise;
      } else {
        // Step 1: Try connecting with targetNetwork parameter
        if (typeof legacyWallet.connect === 'function') {
          try {
            console.log(`[Lace Connect] Trying connect('${targetNetwork}')...`);
            globalConnectingPromise = legacyWallet.connect(targetNetwork);
            walletApi = await globalConnectingPromise;
          } catch (e: any) {
            lastErr = e;
            globalConnectingPromise = null;
            console.warn(`[Lace Connect] connect('${targetNetwork}') failed, trying parameter-less connect():`, e);
          }
        }

        // Step 2: Try parameter-less connect() if first attempt failed
        if (!walletApi && typeof legacyWallet.connect === 'function') {
          try {
            console.log('[Lace Connect] Trying parameter-less connect()...');
            globalConnectingPromise = legacyWallet.connect();
            walletApi = await globalConnectingPromise;
          } catch (e: any) {
            lastErr = e;
            globalConnectingPromise = null;
            console.warn('[Lace Connect] Parameter-less connect failed:', e);
          }
        }

        // Step 3: Fallback to enable() if available
        if (!walletApi && typeof legacyWallet.enable === 'function') {
          try {
            console.log('[Lace Connect] Trying legacy enable()...');
            globalConnectingPromise = legacyWallet.enable();
            walletApi = await globalConnectingPromise;
          } catch (e: any) {
            lastErr = e;
            globalConnectingPromise = null;
            console.warn('[Lace Connect] enable() failed:', e);
          }
        }

        globalConnectingPromise = null;
      }

      if (!walletApi) {
        throw lastErr || new Error(`Unable to connect to ${walletObj.name || walletId}. Please check the Lace extension popup and permissions.`);
      }

      console.log(`[Wallet Connection] Connected API:`, walletApi);
      globalConnectedAPI = walletApi;
      connectedApiRef.current = walletApi;

      // Address resolution based strictly on API typings
      let finalAddress = '';
      try {
        const addressObj = await walletApi.getUnshieldedAddress();
        finalAddress = addressObj.unshieldedAddress;
      } catch (addrErr: any) {
        console.error('[Wallet Connection Debug] getUnshieldedAddress failed:', addrErr);
        throw addrErr;
      }

      // Balance resolution
      let rawBalance = '0';
      try {
        const balances = await walletApi.getUnshieldedBalances();
        rawBalance = (balances['00'] ?? Object.values(balances)[0] ?? 0n).toString();
      } catch (balErr) {
        console.warn('[Wallet Connection Debug] Balance query warning:', balErr);
      }

      let activeNetworkName = targetNetwork === 'preprod' ? 'Midnight Preprod' : (targetNetwork === 'preview' ? 'Midnight Preview' : targetNetwork);
      try {
        if (typeof walletApi.getConfiguration === 'function') {
          const cfg = await walletApi.getConfiguration();
          if (cfg?.networkId) {
            activeNetworkName = cfg.networkId === 'preprod' ? 'Midnight Preprod' : (cfg.networkId === 'preview' ? 'Midnight Preview' : (cfg.networkId === 'undeployed' ? 'Local Devnet' : cfg.networkId));
          }
        }
      } catch (cfgErr) {
        console.warn('[Wallet Connection Debug] getConfiguration warning:', cfgErr);
      }

      const connectedWalletObj: ConnectedWalletInfo = {
        id: walletId,
        name: walletObj.name || 'Lace',
        address: finalAddress,
        tNight: rawBalance,
        dust: '0',
        network: activeNetworkName,
        isWebWallet: false,
      };

      globalConnectedWallet = connectedWalletObj;

      // Join the deployed smart contract on Preprod
      const contractAddress = status?.contractAddress || import.meta.env.VITE_CONTRACT_ADDRESS;
      if (contractAddress && contractAddress !== '') {
        try {
          const result = await joinContract(walletApi, finalAddress, contractAddress);
          console.log('[Contract Join] Successfully loaded contract client:', result.deployed);
          globalDeployedContract = result.deployed;
          setDeployedContract(result.deployed);
          globalContractInitFailed = false;
          setContractInitFailed(false);
        } catch (contractErr: any) {
          console.error('[Contract Join Error]', contractErr);
          globalContractInitFailed = true;
          setContractInitFailed(true);
          // Do not throw contractErr so wallet remains connected in read-only mode
        }
      } else {
        globalContractInitFailed = false;
        setContractInitFailed(false);
      }

      localStorage.setItem('connectedWalletId', walletId);
      setConnectedWallet(connectedWalletObj);
      setShowWalletModal(false);
      setShowWalletSuccessPop(connectedWalletObj);
      if (!isAutoConnect) {
        showToast('success', `Successfully connected to ${walletObj.name || 'Lace'}!`);
      }
    } catch (err: any) {
      console.error('[Wallet Connection Error]', err);
      if (!isAutoConnect) {
        const details = err?.message || err?.reason || String(err);
        const errMsg = details.toLowerCase();
        let displayMsg = details;
        if (errMsg.includes('wallet is locked') || (errMsg.includes('locked') && !errMsg.includes('unlocked') && !errMsg.includes('block'))) {
          displayMsg = 'Please unlock Lace, then click Connect Wallet.';
        } else if (err?.code === 'Rejected' || errMsg.includes('reject') || err?.code === 'PermissionRejected') {
          displayMsg = 'Wallet connection rejected.';
        } else if (errMsg.includes('network')) {
          displayMsg = 'Please switch Lace to Midnight Preprod.';
        }
        showToast('error', displayMsg);
      }
    } finally {
      connectingRef.current = false;
      setIsConnectingWallet(false);
    }
  }, [status, showToast]);

  const autoConnectedRef = useRef(false);

  useEffect(() => {
    const laceWallet = availableWallets.find(w => w.id.toLowerCase().includes('lace') || w.name.toLowerCase().includes('lace'));
    if (laceWallet && !connectedWallet && !autoConnectedRef.current) {
      const savedId = localStorage.getItem('connectedWalletId');
      if (savedId && (savedId.toLowerCase().includes('lace') || savedId === laceWallet.id)) {
        autoConnectedRef.current = true;
        void connectWallet(laceWallet.id, true);
      }
    }
  }, [availableWallets, connectedWallet, connectWallet])

  const [isRequestingFaucet, setIsRequestingFaucet] = useState(false);

  const handleFaucetRequest = useCallback(async () => {
    if (!connectedWallet) return;
    setIsRequestingFaucet(true);
    showToast('info', 'Requesting 20 tNIGHT from local backend faucet...');
    try {
      const response = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: connectedWallet.address }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Faucet request failed');
      }
      showToast('success', `Faucet transfer successful! Tx ID: ${data.txId?.slice(0, 10)}... Please wait 5-10 seconds for block inclusion.`);
      
      // Wait 8 seconds for block inclusion and refresh balance
      await new Promise(r => setTimeout(r, 8000));
      if (connectedApiRef.current) {
        const balances = await connectedApiRef.current.getUnshieldedBalances();
        const rawBalance = (balances['00'] ?? Object.values(balances)[0] ?? 0n).toString();
        setConnectedWallet(prev => prev ? { ...prev, tNight: rawBalance } : null);
        console.log('[Faucet Request] Updated Lace wallet balance:', rawBalance);
      }
    } catch (err: any) {
      showToast('error', err.message || String(err));
    } finally {
      setIsRequestingFaucet(false);
    }
  }, [connectedWallet, showToast]);

  const disconnectWallet = useCallback(() => {
    globalConnectedAPI = null;
    globalConnectedWallet = null;
    globalDeployedContract = null;
    globalConnectingPromise = null;
    globalContractInitFailed = false;

    setConnectedWallet(null)
    setShowWalletSuccessPop(null)
    setDeployedContract(null)
    setContractInitFailed(false)
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
  }, [])

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
        console.error('[TX ERROR DETAILED]', err);
        console.error('Constructor:', err?.constructor?.name);
        console.error('Name:', err?.name);
        console.error('Message:', err?.message);
        console.error('Code:', err?.code);
        console.error('Reason:', err?.reason);
        console.error('Cause:', err?.cause);
        console.error('Stack:', err?.stack);

        const details = [];
        if (err?.name && err.name !== 'Error') details.push(`Name: ${err.name}`);
        if (err?.message) details.push(`Message: ${err.message}`);
        if (err?.code) details.push(`Code: ${err.code}`);
        if (err?.reason) details.push(`Reason: ${err.reason}`);
        let rootError: any = err;
        let depth = 0;
        while (rootError?.cause && depth < 10) {
          rootError = rootError.cause;
          depth++;
          console.error(`[TX ROOT CAUSE \${depth}]`, rootError?.message || rootError);
        }
        const rootMessage = rootError?.message || rootError?.reason || (typeof rootError === 'string' ? rootError : '');
        if (rootMessage && rootMessage !== err?.message) {
          details.push(`Root Error: ${rootMessage}`);
        } else if (err?.cause) {
          const causeMsg = err.cause?.message || err.cause?.reason || String(err.cause);
          details.push(`Cause: ${causeMsg}`);
        }
        
        let errMsg = details.join(' | ') || String(err);
        
        // Handle dust error with a friendly explanation
        const isDustError = 
          /could not balance dust/i.test(errMsg) || 
          /Wallet\.InsufficientFunds/i.test(errMsg) || 
          (err?.cause?.failure?.message && /could not balance dust/i.test(err.cause.failure.message));
          
        if (isDustError) {
          errMsg = "Insufficient DUST balance in Lace Wallet! DUST is required to cover ZK transaction fees. Please open your Lace Wallet extension, select the Midnight tab, click 'Generate DUST' (or register your NIGHT tokens), and wait a few blocks for DUST generation.";
        }
        
        // Contract assertion errors (409) are warnings, not fatal errors
        const isWarning = isDustError || errMsg.includes('Please wait') || errMsg.includes('already') || errMsg.includes('Only the') || errMsg.includes('does not match') || errMsg.includes('not been approved') || errMsg.includes('been revoked') || errMsg.includes('No pending')
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
        console.log('[TX] issueCredential started');
        console.log('[Lace ZK] Fetching real-time balance before transaction...');
        if (!connectedApiRef.current) {
          throw new Error(
            'Lace wallet is not connected. Please reconnect Lace and try again.'
          );
        }

        let currentBalance: bigint;

        try {
          const balances = await connectedApiRef.current.getUnshieldedBalances();

          currentBalance =
            balances['00'] ?? Object.values(balances)[0] ?? 0n;

          console.log(
            '[Lace ZK] Real-time balance (micro-tNIGHT):',
            currentBalance.toString()
          );

          setConnectedWallet(prev =>
            prev
              ? { ...prev, tNight: currentBalance.toString() }
              : null
          );
        } catch (err) {
          console.error(
            '[Lace ZK] Wallet API balance lookup failed:',
            err
          );

          throw new Error(
            'Lace wallet connection expired. Please disconnect and reconnect Lace, then try again.',
            { cause: err }
          );
        }

        if (currentBalance < 2_000_000n) {
          throw new Error(
            'Insufficient tNIGHT balance. At least 2 tNIGHT is required.'
          );
        }

        console.log('[TX] contract call created. Executing issueCredential circuit...');
        setTxProgress((prev: any) => prev ? { ...prev, step: 'proving', message: 'Generating local ZK proof...' } : null);
        
        // Execute the circuit client-side (this triggers ZK proof, balancing, signing and submission)
        const tx = await deployedContract.callTx.issueCredential();
        
        console.log('[TX] proof completed');
        console.log('[TX] transaction object created');
        console.log('[TX] submitTransaction completed');

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
          console.log('[TX] proveEligibility started');
          console.log('[Lace ZK] Fetching real-time balance before transaction...');
          if (!connectedApiRef.current) {
            throw new Error(
              'Lace wallet is not connected. Please reconnect Lace and try again.'
            );
          }

          let currentBalance: bigint;

          try {
            const balances = await connectedApiRef.current.getUnshieldedBalances();

            currentBalance =
              balances['00'] ?? Object.values(balances)[0] ?? 0n;

            console.log(
              '[Lace ZK] Real-time balance (micro-tNIGHT):',
              currentBalance.toString()
            );

            setConnectedWallet(prev =>
              prev
                ? { ...prev, tNight: currentBalance.toString() }
                : null
            );
          } catch (err) {
            console.error(
              '[Lace ZK] Wallet API balance lookup failed:',
              err
            );

            throw new Error(
              'Lace wallet connection expired. Please disconnect and reconnect Lace, then try again.',
              { cause: err }
            );
          }

          if (currentBalance < 2_000_000n) {
            throw new Error(
              'Insufficient tNIGHT balance. At least 2 tNIGHT is required.'
            );
          }

          console.log('[TX] contract call created. Executing proveEligibility circuit...');
          setTxProgress((prev: any) => prev ? { ...prev, step: 'proving', message: 'Generating local ZK proof...' } : null);

          // Convert hex commitment to Bytes<32>
          const commitmentBytes = new Uint8Array(Buffer.from(commitment, 'hex'));
          const tx = await deployedContract.callTx.proveEligibility(commitmentBytes);

          console.log('[TX] proof completed');
          console.log('[TX] transaction object created');
          console.log('[TX] submitTransaction completed');

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
              {contractInitFailed && (
                <span className="pill pill-err">
                  ⚠️ Contract Init Failed
                </span>
              )}
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
              <button 
                className="btn btn-secondary btn-small" 
                onClick={handleFaucetRequest}
                disabled={isRequestingFaucet}
              >
                {isRequestingFaucet ? 'Funding...' : 'Request 20 tNIGHT Faucet'}
              </button>
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

      {contractInitFailed && (
        <div className="contract-error-banner" style={{
          margin: '20px auto',
          maxWidth: '1200px',
          padding: '16px 20px',
          background: 'rgba(244, 63, 94, 0.18)',
          border: '1px solid var(--rose-border)',
          color: '#fda4af',
          borderRadius: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          boxShadow: 'var(--shadow)',
          animation: 'toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
          <span style={{ fontSize: '20px' }}>⚠️</span>
          <div>
            <strong style={{ color: '#fda4af' }}>Wallet connected, contract initialization failed.</strong>
            <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-s)' }}>
              We could not connect to the Shadow-KYC smart contract or configure the Midnight client providers. 
              The application is running in read-only / offline mode. Make sure the local devnet or Preprod indexer & prover servers are running and healthy.
            </p>
          </div>
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
                <p className="wallet-list-sub">Select your Midnight wallet extension:</p>

                {availableWallets
                  .filter(w => w.id.toLowerCase().includes('lace') || w.name.toLowerCase().includes('lace'))
                  .map((wallet) => (
                    <button
                      key={wallet.id}
                      className="wallet-item-btn"
                      onClick={() => void connectWallet(wallet.id)}
                      disabled={isConnectingWallet}
                    >
                      <span className="wallet-icon">💳</span>
                      <div className="wallet-info">
                        <span className="wallet-name">{wallet.name}</span>
                        <span className="wallet-meta">Official Midnight Extension</span>
                      </div>
                      <span className="wallet-arrow">➔</span>
                    </button>
                  ))}
              </div>

              {!availableWallets.some(w => w.id.toLowerCase().includes('lace') || w.name.toLowerCase().includes('lace')) && (
                <div className="no-wallets-found" style={{ marginTop: '20px' }}>
                  <p className="no-wallets-sub">
                    Lace wallet extension not found in your browser.
                  </p>
                  <div className="download-links">
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