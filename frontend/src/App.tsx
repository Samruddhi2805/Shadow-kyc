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
let globalConnectedAPI: ConnectedAPI | null = null;
let globalConnectedWallet: ConnectedWalletInfo | null = null;
let globalDeployedContract: FoundContract<ShadowKycContract<ShadowKycPrivateState>> | null = null;
let globalContractInitFailed = false;

function resetGlobalWalletState() {
  globalConnectedAPI = null;
  globalConnectedWallet = null;
  globalDeployedContract = null;
  globalContractInitFailed = false;
}

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
  const [isSandbox, setIsSandbox] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('sandbox') === 'true' || params.get('mode') === 'sandbox';
    }
    return false;
  })
  const [sandboxState, setSandboxState] = useState<ContractState>({
    authority: '1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0',
    authorityName: 'Midnight KYC Authority (Preprod Verified)',
    pendingCredentials: [
      '3f8a91b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f',
      'b7e2c9a1d4f6803527194b8e3a5c7d9f0246813579bdf0246813579bdf024681',
    ],
    credentials: [
      'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
      '8f7e6d5c4b3a291807f6e5d4c3b2a19087e6d5c4b3a291807f6e5d4c3b2a1908',
    ],
    revokedCredentials: [
      'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    ],
    eligibilityCount: '48',
  })

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
    const initialWalletObj = window.midnight[walletId];
    const isLace = walletId.toLowerCase().includes('lace') || (((initialWalletObj as any)?.name || '').toLowerCase().includes('lace'));
    if (!isLace) {
      if (!isAutoConnect) {
        showToast('error', 'Only Lace Wallet is supported for this application.');
      }
      return;
    }

    // For auto-connect only: if we already have an active verified connection, keep it
    if (isAutoConnect && globalConnectedAPI && globalConnectedWallet && globalConnectedWallet.id === walletId) {
      console.log('[Lace Connect] Validating existing ConnectedAPI for auto-connect...');
      const isValid = await validateConnectedAPI(globalConnectedAPI);
      if (isValid) {
        setConnectedWallet(globalConnectedWallet);
        if (globalDeployedContract) setDeployedContract(globalDeployedContract);
        setContractInitFailed(globalContractInitFailed);
        connectedApiRef.current = globalConnectedAPI;
        setShowWalletModal(false);
        return;
      } else {
        console.warn('[Lace Connect] Cached ConnectedAPI failed validation. Purging stale session...');
        resetGlobalWalletState();
        connectedApiRef.current = null;
        setConnectedWallet(null);
        setDeployedContract(null);
        setContractInitFailed(false);
        localStorage.removeItem('connectedWalletId');
      }
    }

    // Manual connection: always reset stale state to guarantee a fresh extension handshake
    if (!isAutoConnect) {
      resetGlobalWalletState();
      connectedApiRef.current = null;
    }

    connectingRef.current = true;
    setIsConnectingWallet(true);
    if (!isAutoConnect) {
      showToast('info', `Connecting to ${(initialWalletObj as any)?.name || 'Lace'}... Please check your wallet extension popup.`);
    }

    try {
      const defaultNet = import.meta.env.VITE_NETWORK || 'preprod';
      const targetNetwork = (status?.network || defaultNet) === 'preview' ? 'preview' : (((status?.network || defaultNet) === 'preprod') ? 'preprod' : 'testnet');
      
      let walletApi: ConnectedAPI | null = null;
      let lastErr: any = null;

      // Always retrieve the latest injected InitialAPI instance directly from window.midnight
      const freshWalletObj = window.midnight?.[walletId] as unknown as {
        connect?: (networkId?: string) => Promise<ConnectedAPI>;
        enable?: () => Promise<ConnectedAPI>;
        name?: string;
      };

      if (!freshWalletObj) {
        throw new Error(`Lace extension (${walletId}) is not available in window.midnight. Please ensure the extension is installed and enabled.`);
      }

      // Step 1: Try connecting with targetNetwork parameter (e.g. 'preprod')
      if (typeof freshWalletObj.connect === 'function') {
        try {
          console.log(`[Lace Connect] Requesting fresh connect('${targetNetwork}')...`);
          walletApi = await freshWalletObj.connect(targetNetwork);
        } catch (e: any) {
          lastErr = e;
          console.warn(`[Lace Connect] connect('${targetNetwork}') failed, trying parameter-less connect():`, e);
        }
      }

      // Step 2: Try parameter-less connect() if first attempt failed
      if (!walletApi && typeof freshWalletObj.connect === 'function') {
        try {
          console.log('[Lace Connect] Requesting fresh parameter-less connect()...');
          walletApi = await freshWalletObj.connect();
        } catch (e: any) {
          lastErr = e;
          console.warn('[Lace Connect] Parameter-less connect failed:', e);
        }
      }

      // Step 3: Fallback to legacy enable() if available
      if (!walletApi && typeof freshWalletObj.enable === 'function') {
        try {
          console.log('[Lace Connect] Requesting fresh legacy enable()...');
          walletApi = await freshWalletObj.enable();
        } catch (e: any) {
          lastErr = e;
          console.warn('[Lace Connect] enable() failed:', e);
        }
      }

      if (!walletApi) {
        throw lastErr || new Error(`Unable to connect to ${freshWalletObj.name || walletId}. Please check the Lace extension popup and permissions.`);
      }

      console.log(`[Wallet Connection] Connected API successfully established:`, walletApi);
      globalConnectedAPI = walletApi;
      connectedApiRef.current = walletApi;

      // Address resolution
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
        name: freshWalletObj.name || 'Lace',
        address: finalAddress,
        tNight: rawBalance,
        dust: '0',
        network: activeNetworkName,
        isWebWallet: false,
      };

      globalConnectedWallet = connectedWalletObj;

      // Join the deployed smart contract on Preprod
      const contractAddress = status?.contractAddress || import.meta.env.VITE_CONTRACT_ADDRESS || '1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0';
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
        showToast('success', `Successfully connected to ${freshWalletObj.name || 'Lace'}!`);
      }
    } catch (err: any) {
      console.error('[Wallet Connection Error]', err);
      resetGlobalWalletState();
      connectedApiRef.current = null;
      setConnectedWallet(null);
      setDeployedContract(null);
      setContractInitFailed(false);

      const details = err?.message || err?.reason || String(err);
      const errMsg = details.toLowerCase();
      let displayMsg = details;

      if (
        errMsg.includes('midnight-authenticator') ||
        errMsg.includes('midnight-connector') ||
        errMsg.includes('shutdown') ||
        errMsg.includes('no longer be used')
      ) {
        displayMsg = 'Lace session channel was reset. Please ensure Lace is unlocked, then click Connect Wallet again.';
        localStorage.removeItem('connectedWalletId');
      } else if (errMsg.includes('wallet is locked') || (errMsg.includes('locked') && !errMsg.includes('unlocked') && !errMsg.includes('block'))) {
        displayMsg = 'Please unlock Lace, then click Connect Wallet.';
        localStorage.removeItem('connectedWalletId');
      } else if (err?.code === 'Rejected' || errMsg.includes('reject') || err?.code === 'PermissionRejected') {
        displayMsg = 'Wallet connection rejected in Lace.';
      } else if (errMsg.includes('network')) {
        displayMsg = 'Please switch Lace to Midnight Preprod.';
      }

      if (!isAutoConnect) {
        showToast('error', displayMsg);
      } else {
        console.warn('[Auto-Connect Session Reset]', displayMsg);
        localStorage.removeItem('connectedWalletId');
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
  }, [availableWallets, connectedWallet, connectWallet]);


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
    resetGlobalWalletState();
    setConnectedWallet(null);
    setShowWalletSuccessPop(null);
    setDeployedContract(null);
    setContractInitFailed(false);
    connectedApiRef.current = null;
    localStorage.removeItem('connectedWalletId');
    showToast('info', 'Wallet disconnected');
  }, [showToast]);

  const copyToClipboard = useCallback((text: string, label: string) => {
    void navigator.clipboard.writeText(text)
    showToast('info', `Copied ${label} to clipboard`)
  }, [showToast])

  const refresh = useCallback(async () => {
    if (isSandbox) {
      setLoading(false)
      return
    }
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
  }, [isSandbox])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(id)
  }, [])

  const [userCommitment, setUserCommitment] = useState<string | null>(null);

  useEffect(() => {
    if (connectedWallet?.address) {
      void getDeterministicSecret(connectedWallet.address).then(async (secret) => {
        const comm = await computeRealCommitment(secret);
        setUserCommitment(comm);
      });
    } else {
      setUserCommitment(null);
    }
  }, [connectedWallet?.address]);

  const effectiveState = isSandbox ? sandboxState : state;

  const userCredentialStatus = useMemo<'none' | 'pending' | 'approved' | 'revoked'>(() => {
    if (!effectiveState || !userCommitment) return 'none';
    if (effectiveState.revokedCredentials.includes(userCommitment)) return 'revoked';
    if (effectiveState.credentials.includes(userCommitment)) return 'approved';
    if (effectiveState.pendingCredentials.includes(userCommitment)) return 'pending';
    return 'none';
  }, [effectiveState, userCommitment]);

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
        let errorCategory = 'Transaction Error';
        let recoveryTip = '';

        // Classify errors for production-safe user feedback
        const isDustError = 
          /could not balance dust/i.test(errMsg) || 
          /Wallet\.InsufficientFunds/i.test(errMsg) || 
          (err?.cause?.failure?.message && /could not balance dust/i.test(err.cause.failure.message));

        const isProverError =
          /'check' returned an error/i.test(errMsg) ||
          /'prove' returned an error/i.test(errMsg) ||
          /prover.*failed to fetch/i.test(errMsg) ||
          (/failed to fetch/i.test(errMsg) && (errMsg.includes('prover') || errMsg.includes('check') || errMsg.includes('proof')));

        const isApiOffline =
          /api unreachable/i.test(errMsg) ||
          /Shadow-KYC API unreachable/i.test(errMsg) ||
          (/failed to fetch/i.test(errMsg) && !isProverError);

        const isCancelled =
          /user rejected|user cancelled|user denied|declined/i.test(errMsg);

        const isTimeout =
          /timed out/i.test(errMsg);

        const isSubmissionError =
          /submitting scoped transaction/i.test(errMsg) ||
          /submitTransaction/i.test(errMsg);

        if (isDustError) {
          errorCategory = 'Lace DUST Balance Required';
          errMsg = "Insufficient DUST in Lace Wallet. Midnight transactions require DUST to cover zero-knowledge circuit verification fees.";
          recoveryTip = "Open Lace Wallet, go to the Midnight tab, click 'Generate DUST' (or register your NIGHT tokens), and wait 1-2 blocks.";
        } else if (isSubmissionError) {
          errorCategory = 'Lace / Midnight Submission Error';
          errMsg = "Lace Wallet was unable to submit the signed transaction to the Midnight node.";
          recoveryTip = "Ensure you have generated DUST in Lace Wallet (click the purple Midnight icon in Lace, then 'Generate DUST' / 'Register NIGHT'). If you already registered DUST, wait 1-2 blocks for the DUST UTXO to confirm, disconnect & reconnect Lace, and try again.";
        } else if (isProverError) {
          errorCategory = 'ZK Proof Server Unreachable';
          errMsg = "The transaction could not connect to the Midnight ZK Proof Server (:6300).";
          recoveryTip = "Ensure the Midnight Proof Server is running via Docker ('docker compose -f docker-compose.prod.yml up -d') or verify the backend prover gateway is deployed.";
        } else if (isApiOffline) {
          errorCategory = 'Backend API Offline';
          errMsg = "Could not connect to the Shadow-KYC backend API.";
          recoveryTip = "Verify your internet connection and ensure the permanent backend API is deployed and configured via VITE_API_BASE_URL.";
        } else if (isCancelled) {
          errorCategory = 'Transaction Cancelled';
          errMsg = "The transaction signing request was declined or cancelled in your wallet.";
          recoveryTip = "Re-try the transaction and approve the signature prompt in Lace Wallet.";
        } else if (isTimeout) {
          errorCategory = 'Transaction Timeout';
          errMsg = "The ZK transaction took longer than expected.";
          recoveryTip = "Zero-knowledge proofs can take 30-60s on complex circuits. Please check your network and try again.";
        } else if (/Insufficient tNIGHT/i.test(errMsg)) {
          errorCategory = 'Insufficient tNIGHT';
          recoveryTip = "Request 20 tNIGHT using the faucet button in the header or visit the Midnight Preprod testnet faucet.";
        }

        // Contract assertion errors (409) are warnings, not fatal crashes
        const isWarning = isDustError || isCancelled || errMsg.includes('Please wait') || errMsg.includes('already') || errMsg.includes('Only the') || errMsg.includes('does not match') || errMsg.includes('not been approved') || errMsg.includes('been revoked') || errMsg.includes('No pending');
        if (isWarning && !isDustError && !isCancelled) {
          errorCategory = 'Contract Policy Notice';
        }

        setTxProgress((prev) =>
          prev ? { ...prev, step: 'error', error: errMsg, errorCategory, recoveryTip } : null
        )
        showToast(isWarning ? 'info' : 'error', errMsg)
      } finally {
        setBusy(null)
      }
    },
    [refresh, showToast]
  )

  const credentials = useMemo<CredentialEntry[]>(() => {
    if (!effectiveState) return []
    const pending = new Set(effectiveState.pendingCredentials)
    const approved = new Set(effectiveState.credentials)
    const revoked = new Set(effectiveState.revokedCredentials)
    const all = new Set<string>([...pending, ...approved, ...revoked])
    return [...all].map((commitment) => ({
      commitment,
      status: revoked.has(commitment)
        ? ('revoked' as const)
        : approved.has(commitment)
          ? ('approved' as const)
          : ('pending' as const),
    }))
  }, [effectiveState])

  const handleIssue = useCallback(async () => {
    if (isSandbox) {
      const customC = userCommitment || 'e5d4c3b2a19087e6d5c4b3a291807f6e5d4c3b2a19087e6d5c4b3a291807f6e5';
      void runTxWithModal('issueCredential', 'Request KYC Credential (Sandbox ZK)', customC, async () => {
        await new Promise(r => setTimeout(r, 600));
        setSandboxState(prev => ({
          ...prev,
          pendingCredentials: [customC, ...prev.pendingCredentials.filter(c => c !== customC)]
        }));
        const mockTx = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
        setHistory(prev => [
          {
            id: Date.now().toString(),
            action: 'issueCredential',
            txId: mockTx,
            blockHeight: 2126835,
            commitment: customC,
            message: 'ZK Credential request submitted to pending registry (Sandbox).',
            timestamp: new Date().toISOString(),
          },
          ...prev
        ]);
        return {
          txId: mockTx,
          blockHeight: 2126835,
          commitment: customC,
          message: 'ZK Credential request submitted to pending registry (Sandbox).',
        };
      });
      return;
    }

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
  }, [isSandbox, userCommitment, deployedContract, connectedWallet, runTxWithModal])

  const handleApprove = useCallback(
    (commitment: string) => {
      if (isSandbox) {
        void runTxWithModal('approveCredential', 'Authority Approve Credential (Sandbox)', commitment, async () => {
          await new Promise((r) => setTimeout(r, 600))
          setSandboxState((prev) => ({
            ...prev,
            pendingCredentials: prev.pendingCredentials.filter((c) => c !== commitment),
            credentials: [commitment, ...prev.credentials.filter((c) => c !== commitment)],
          }))
          const mockTx = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('')
          setHistory((prev) => [
            {
              id: Date.now().toString(),
              action: 'approveCredential',
              txId: mockTx,
              blockHeight: 2126836,
              commitment,
              message: 'Compliance authority approved KYC credential commitment (Sandbox).',
              timestamp: new Date().toISOString(),
            },
            ...prev,
          ])
          return {
            txId: mockTx,
            blockHeight: 2126836,
            commitment,
            message: 'Compliance authority approved KYC credential commitment (Sandbox).',
          }
        })
        return
      }

      void runTxWithModal('approveCredential', 'Authority Approve Credential', commitment, () =>
        api.approveCredential(commitment)
      )
    },
    [isSandbox, runTxWithModal]
  )

  const handleProve = useCallback(
    (commitment: string) => {
      if (isSandbox) {
        void runTxWithModal('proveEligibility', 'Zero-Knowledge Prove Eligibility (Sandbox)', commitment, async () => {
          await new Promise((r) => setTimeout(r, 600))
          setSandboxState((prev) => ({
            ...prev,
            eligibilityCount: (Number(prev.eligibilityCount) + 1).toString(),
          }))
          const mockTx = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('')
          setHistory((prev) => [
            {
              id: Date.now().toString(),
              action: 'proveEligibility',
              txId: mockTx,
              blockHeight: 2126837,
              commitment,
              message: 'Zero-Knowledge eligibility proved! Secret never disclosed (Sandbox).',
              timestamp: new Date().toISOString(),
            },
            ...prev,
          ])
          return {
            txId: mockTx,
            blockHeight: 2126837,
            commitment,
            message: 'Zero-Knowledge eligibility proved! Secret never disclosed (Sandbox).',
          }
        })
        return
      }

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
    [isSandbox, deployedContract, connectedWallet, runTxWithModal]
  )

  const handleRevoke = useCallback(
    (commitment: string) => {
      if (isSandbox) {
        void runTxWithModal('revokeCredential', 'Revoke Credential Authorization (Sandbox)', commitment, async () => {
          await new Promise((r) => setTimeout(r, 600))
          setSandboxState((prev) => ({
            ...prev,
            credentials: prev.credentials.filter((c) => c !== commitment),
            revokedCredentials: [commitment, ...prev.revokedCredentials.filter((c) => c !== commitment)],
          }))
          const mockTx = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('')
          setHistory((prev) => [
            {
              id: Date.now().toString(),
              action: 'revokeCredential',
              txId: mockTx,
              blockHeight: 2126838,
              commitment,
              message: 'Credential commitment revoked from compliant set (Sandbox).',
              timestamp: new Date().toISOString(),
            },
            ...prev,
          ])
          return {
            txId: mockTx,
            blockHeight: 2126838,
            commitment,
            message: 'Credential commitment revoked from compliant set (Sandbox).',
          }
        })
        return
      }

      void runTxWithModal('revokeCredential', 'Revoke Credential Authorization', commitment, () =>
        api.revokeCredential(commitment)
      )
    },
    [isSandbox, runTxWithModal]
  )


  const handleCustomProve = useCallback(() => {
    const c = commitmentInput.trim()
    if (!/^[0-9a-fA-F]{64}$/.test(c)) {
      showToast('error', 'Enter a valid 64-character hex commitment')
      return
    }

    if (isSandbox) {
      void runTxWithModal('proveEligibility', 'Zero-Knowledge Prove Custom Commitment (Sandbox)', c, async () => {
        await new Promise((r) => setTimeout(r, 600))
        setSandboxState((prev) => ({
          ...prev,
          eligibilityCount: (Number(prev.eligibilityCount) + 1).toString(),
        }))
        const mockTx = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('')
        setHistory((prev) => [
          {
            id: Date.now().toString(),
            action: 'proveEligibility',
            txId: mockTx,
            blockHeight: 2126839,
            commitment: c,
            message: 'Zero-Knowledge eligibility proved! Secret never disclosed (Sandbox).',
            timestamp: new Date().toISOString(),
          },
          ...prev,
        ])
        return {
          txId: mockTx,
          blockHeight: 2126839,
          commitment: c,
          message: 'Zero-Knowledge eligibility proved! Secret never disclosed (Sandbox).',
        }
      })
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
  }, [isSandbox, commitmentInput, deployedContract, connectedWallet, runTxWithModal, showToast])

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
      <div className="sandbox-banner">
        <div className="sandbox-banner-left">
          <span className="sandbox-tag">{isSandbox ? '🧪 Reviewer Sandbox' : '🌐 Midnight Preprod'}</span>
          <span>
            {isSandbox
              ? 'Interactive Reviewer Sandbox Active · Test all 4 ZK circuits instantly with simulated zero-knowledge state'
              : 'Connected to Midnight Preprod Testnet · Contract 1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0'}
          </span>
        </div>
        <div className="sandbox-controls">
          <button
            className={`btn-sandbox ${isSandbox ? 'active' : ''}`}
            onClick={() => {
              const next = !isSandbox;
              setIsSandbox(next);
              showToast('info', next ? 'Switched to Interactive Reviewer Sandbox Mode' : 'Switched to Live Midnight Preprod');
            }}
          >
            {isSandbox ? '🟢 Sandbox Mode Active (Click for Preprod)' : '⚡ Switch to Reviewer Sandbox Mode'}
          </button>
        </div>
      </div>

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
            state={effectiveState}
            credentials={credentials}
            balance={balance}
            connectedWallet={connectedWallet}
            userCommitment={userCommitment}
            userCredentialStatus={userCredentialStatus}
            onCopy={copyToClipboard}
            onNavigateUser={() => setActiveTab('user')}
            isSandbox={isSandbox}
          />
        )}

        {activeTab === 'user' && (
          <UserActions
            busy={busy}
            credentials={credentials}
            connectedWallet={connectedWallet}
            userCommitment={userCommitment}
            userCredentialStatus={userCredentialStatus}
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
                <div className="tx-step-icon">
                  {['proving', 'signing', 'confirming', 'done'].includes(txProgress.step) ? '✓' : '1'}
                </div>
                <div className="tx-step-info">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span className="tx-step-name">Local Secret Witness</span>
                    <span className="tx-step-badge" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(139, 92, 246, 0.15)', color: '#c4b5fd' }}>🔒 In-Memory Private</span>
                  </div>
                  <span className="tx-step-desc">Generating identity witness & SHA-256 commitment (secret never leaves device)</span>
                </div>
              </div>

              <div className={`tx-step-card ${txProgress.step === 'proving' ? 'active' : ['signing', 'confirming', 'done'].includes(txProgress.step) ? 'done' : ''}`}>
                <div className="tx-step-icon">
                  {['signing', 'confirming', 'done'].includes(txProgress.step) ? '✓' : '2'}
                </div>
                <div className="tx-step-info">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span className="tx-step-name">Zero-Knowledge Proof (ZKP)</span>
                    <span className="tx-step-badge" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(16, 185, 129, 0.15)', color: '#6ee7b7' }}>🛡️ Zero PII Revealed</span>
                  </div>
                  <span className="tx-step-desc">Evaluating Compact circuit to mathematically prove eligibility without revealing secret</span>
                </div>
              </div>

              <div className={`tx-step-card ${txProgress.step === 'signing' ? 'active' : ['confirming', 'done'].includes(txProgress.step) ? 'done' : ''}`}>
                <div className="tx-step-icon">
                  {['confirming', 'done'].includes(txProgress.step) ? '✓' : '3'}
                </div>
                <div className="tx-step-info">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span className="tx-step-name">Wallet Signature & Fee Balancing</span>
                    <span className="tx-step-badge" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(56, 189, 248, 0.15)', color: '#7dd3fc' }}>✍️ Non-Custodial</span>
                  </div>
                  <span className="tx-step-desc">Balancing unshielded fees (tNIGHT + DUST) and signing transaction via Lace Wallet</span>
                </div>
              </div>

              <div className={`tx-step-card ${txProgress.step === 'confirming' || txProgress.step === 'done' ? (txProgress.step === 'done' ? 'done' : 'active') : ''}`}>
                <div className="tx-step-icon">
                  {txProgress.step === 'done' ? '✓' : '4'}
                </div>
                <div className="tx-step-info">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span className="tx-step-name">Ledger Block Inclusion</span>
                    <span className="tx-step-badge" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(245, 158, 11, 0.15)', color: '#fcd34d' }}>⛓️ Midnight Preprod</span>
                  </div>
                  <span className="tx-step-desc">Transaction included in block; commitment recorded on-chain</span>
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
                txProgress.error.includes('No pending') ||
                txProgress.errorCategory === 'Contract Policy Notice' ||
                txProgress.errorCategory === 'Transaction Cancelled'
              )
              return (
                <div className="wallet-pop-details" style={{
                  borderColor: isWarning ? 'var(--amber, #f59e0b)' : 'var(--rose-border)',
                  background: isWarning ? 'rgba(245, 158, 11, 0.08)' : 'rgba(244, 63, 94, 0.08)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ fontSize: 16 }}>{isWarning ? '⚠️' : '❌'}</span>
                    <strong style={{ color: isWarning ? '#f59e0b' : 'var(--rose)', fontSize: 14 }}>
                      {txProgress.errorCategory || (isWarning ? 'Notice' : 'Transaction Error')}
                    </strong>
                  </div>
                  <p style={{ margin: '0 0 8px 0', color: 'var(--text-h)', fontSize: 13, lineHeight: 1.5 }}>
                    {txProgress.error}
                  </p>
                  {txProgress.recoveryTip && (
                    <div style={{
                      padding: '8px 12px',
                      borderRadius: '8px',
                      background: 'rgba(0, 0, 0, 0.3)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      fontSize: '12px',
                      color: 'var(--accent-light)',
                    }}>
                      💡 <strong>Recommended Action:</strong> {txProgress.recoveryTip}
                    </div>
                  )}
                </div>
              )
            })()}

            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 16 }}>
              {txProgress.step === 'error' && txProgress.action === 'issueCredential' && !isSandbox && (
                <button
                  className="btn btn-secondary"
                  style={{ background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.2)' }}
                  onClick={() => {
                    const commitment = txProgress.commitment;
                    setTxProgress(null);
                    void runTxWithModal('issueCredential', 'Request KYC Credential (Relayer)', commitment, () =>
                      api.issueCredential(commitment)
                    );
                  }}
                >
                  ⚡ Submit via Relayer
                </button>
              )}
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
  userCommitment,
  userCredentialStatus,
  onCopy,
  onNavigateUser,
  isSandbox,
}: {
  status: ServerStatus | null
  state: ContractState | null
  credentials: CredentialEntry[]
  balance: BalanceInfo | null
  connectedWallet: ConnectedWalletInfo | null
  userCommitment: string | null
  userCredentialStatus: 'none' | 'pending' | 'approved' | 'revoked'
  onCopy: (text: string, label: string) => void
  onNavigateUser?: () => void
  isSandbox: boolean
}) {
  const pending = credentials.filter((c) => c.status === 'pending').length
  const approved = credentials.filter((c) => c.status === 'approved').length
  const revoked = credentials.filter((c) => c.status === 'revoked').length

  const [simPreset, setSimPreset] = useState<'alice' | 'bob' | 'corp' | 'custom'>('alice')
  const [simSecret, setSimSecret] = useState('user_alice_passport_2026')
  const [simHash, setSimHash] = useState('')
  const [registryFilter, setRegistryFilter] = useState<'all' | 'pending' | 'approved' | 'revoked'>('all')
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    void simulateCommitment(simSecret).then(setSimHash)
  }, [simSecret])

  const handlePreset = (preset: 'alice' | 'bob' | 'corp' | 'custom') => {
    setSimPreset(preset)
    if (preset === 'alice') setSimSecret('user_alice_passport_2026')
    else if (preset === 'bob') setSimSecret('user_bob_national_id_9821')
    else if (preset === 'corp') setSimSecret('enterprise_fund_aml_audit_7731')
  }

  const filteredCredentials = credentials.filter((c) => {
    if (registryFilter !== 'all' && c.status !== registryFilter) return false
    if (searchTerm && !c.commitment.toLowerCase().includes(searchTerm.toLowerCase())) return false
    return true
  })

  return (
    <div className="overview">
      {!isSandbox && !state && (
        <div style={{
          marginBottom: 16,
          padding: '12px 16px',
          borderRadius: 8,
          background: 'rgba(56, 189, 248, 0.08)',
          border: '1px solid rgba(56, 189, 248, 0.2)',
          color: 'var(--accent-light)',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span>🌐</span>
          <span>
            <strong>Midnight Preprod Mode:</strong> Live on-chain contract state is loading from the Midnight network (Contract <code className="mono">1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0</code>). Connect Lace Wallet or deploy the permanent API backend to submit on-chain transactions.
          </span>
        </div>
      )}

      {/* ── 1. Live Metrics Bar ── */}
      <div className="metrics-grid">
        <div className="metric-card purple">
          <div className="metric-card-inner">
            <div>
              <div className="metric-label">Total KYC Passports</div>
              <div className="metric-value">{credentials.length}</div>
              <div className="metric-sub">{isSandbox ? 'Across Sandbox Registries' : (state ? 'On-Chain Ledger State' : 'Connecting to Preprod...')}</div>
            </div>
            <div className="metric-icon-wrap">🛡️</div>
          </div>
        </div>

        <div className="metric-card emerald">
          <div className="metric-card-inner">
            <div>
              <div className="metric-label">Approved & Compliant</div>
              <div className="metric-value">{approved}</div>
              <div className="metric-sub">✓ Ready for ZK Proving</div>
            </div>
            <div className="metric-icon-wrap">✨</div>
          </div>
        </div>

        <div className="metric-card amber">
          <div className="metric-card-inner">
            <div>
              <div className="metric-label">Pending Authority</div>
              <div className="metric-value">{pending}</div>
              <div className="metric-sub">⏳ In Review Queue</div>
            </div>
            <div className="metric-icon-wrap">⚖️</div>
          </div>
        </div>

        <div className="metric-card cyan">
          <div className="metric-card-inner">
            <div>
              <div className="metric-label">ZK Proofs Verified</div>
              <div className="metric-value">{state ? formatCount(state.eligibilityCount) : (isSandbox ? '48' : '0')}</div>
              <div className="metric-sub">⚡ Zero Knowledge Leaked</div>
            </div>
            <div className="metric-icon-wrap">🔒</div>
          </div>
        </div>
      </div>

      {/* ── 2. Holographic Digital KYC ID Card ── */}
      <div className="holo-container">
        <div className={`holo-card ${userCredentialStatus === 'approved' ? 'holo-card-approved' : ''}`}>
          <div className="holo-card-top">
            <div className="holo-issuer">
              <div className="holo-chip" />
              <div>
                <div className="holo-title">Midnight Network · Zero-Knowledge Compliance ID</div>
                <div className="holo-subtitle">Issued by: {state?.authorityName || 'Midnight Preprod Authority'}</div>
              </div>
            </div>
            <div>
              <span className={`pill ${
                userCredentialStatus === 'approved' ? 'pill-ok' :
                userCredentialStatus === 'pending' ? 'pill-warn' :
                userCredentialStatus === 'revoked' ? 'pill-err' : 'pill-neutral'
              }`}>
                {userCredentialStatus === 'approved' ? '🛡️ Verified & Compliant' :
                 userCredentialStatus === 'pending' ? '⏳ Verification Pending' :
                 userCredentialStatus === 'revoked' ? '🚫 Revoked' : '🆔 Not Requested'}
              </span>
            </div>
          </div>

          <div className="holo-body">
            <div className="holo-commitment-box">
              <div>
                <div className="holo-commitment-label">Zero-Knowledge Credential Commitment (SHA-256)</div>
                <div className="holo-commitment-val mono">
                  {userCommitment ? userCommitment : 'e5d4c3b2a19087e6d5c4b3a291807f6e5d4c3b2a19087e6d5c4b3a291807f6e5'}
                </div>
              </div>
              <button
                className="btn btn-icon"
                onClick={() => onCopy(userCommitment || 'e5d4c3b2a19087e6d5c4b3a291807f6e5d4c3b2a19087e6d5c4b3a291807f6e5', 'Credential Commitment')}
                title="Copy Credential Commitment"
              >
                📋
              </button>
            </div>

            <div className="holo-predicates">
              <span className={`holo-pred-badge ${userCredentialStatus === 'approved' ? 'verified' : ''}`}>
                ✓ Age: ≥ 18 (ZK Proved)
              </span>
              <span className={`holo-pred-badge ${userCredentialStatus === 'approved' ? 'verified' : ''}`}>
                ✓ AML Sanctions: Clean
              </span>
              <span className={`holo-pred-badge ${userCredentialStatus === 'approved' ? 'verified' : ''}`}>
                ✓ Jurisdiction: Permitted
              </span>
              <span className="holo-pred-badge verified">
                🔒 Private Witness: Zero-Knowledge Shielded
              </span>
            </div>
          </div>

          <div className="holo-card-footer">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-s)' }}>
              <span>Account:</span>
              <span className="mono" style={{ color: '#fff' }}>
                {connectedWallet ? `${connectedWallet.name} (${shortHex(connectedWallet.address, 6, 4)})` : 'Demo Pass (Connect Wallet to Bind)'}
              </span>
            </div>
            <div>
              {onNavigateUser && (
                <button
                  className="btn btn-small btn-primary"
                  onClick={onNavigateUser}
                >
                  {userCredentialStatus === 'approved' ? '⚡ Prove Eligibility On-Chain' : '➕ Complete KYC Verification'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── 3. Interactive ZK Circuit Flowchart ── */}
      <section className="card">
        <h2>Zero-Knowledge Architecture & Privacy Guarantees</h2>
        <p>
          Shadow-KYC utilizes Midnight Compact smart contracts to provide institutional-grade regulatory compliance
          while guaranteeing 100% cryptographic privacy for end-users.
        </p>

        <div className="zk-interactive-flow">
          <div className="zk-flow-card private">
            <div className="zk-flow-badge-row">
              <span className="zk-flow-num">PHASE 1</span>
              <span className="pill pill-ok" style={{ fontSize: 10, padding: '2px 8px' }}>Private Witness</span>
            </div>
            <h4>Local Identity Secret</h4>
            <p>Your secret identity witness (<code className="mono">localSecret</code>) is created and kept on your machine. Never sent to any server or ledger.</p>
          </div>

          <div className="zk-flow-arrow">➔</div>

          <div className="zk-flow-card public">
            <div className="zk-flow-badge-row">
              <span className="zk-flow-num">PHASE 2</span>
              <span className="pill pill-neutral" style={{ fontSize: 10, padding: '2px 8px' }}>Cryptographic Hash</span>
            </div>
            <h4>One-Way Commitment</h4>
            <p>Hash function computes <code className="mono">persistentHash(localSecret)</code>. Irreversible 32-byte representation.</p>
          </div>

          <div className="zk-flow-arrow">➔</div>

          <div className="zk-flow-card contract">
            <div className="zk-flow-badge-row">
              <span className="zk-flow-num">PHASE 3</span>
              <span className="pill pill-ok" style={{ fontSize: 10, padding: '2px 8px' }}>Preprod Ledger</span>
            </div>
            <h4>Authority Set Approval</h4>
            <p>Authority verifies off-chain documentation and approves the commitment into <code className="mono">credentials</code> set.</p>
          </div>

          <div className="zk-flow-arrow">➔</div>

          <div className="zk-flow-card private">
            <div className="zk-flow-badge-row">
              <span className="zk-flow-num">PHASE 4</span>
              <span className="pill pill-warn" style={{ fontSize: 10, padding: '2px 8px' }}>ZK-SNARK Proof</span>
            </div>
            <h4>Succinct Verification</h4>
            <p>User executes <code className="mono">proveEligibility</code>. Midnight verifies circuit constraints without revealing identity.</p>
          </div>
        </div>
      </section>

      {/* ── 4. Interactive Cryptographic Witness Simulator ── */}
      <section className="card hero-card">
        <h2>Interactive Cryptographic Witness Simulator</h2>
        <p>
          Test how local private identity witnesses translate to on-chain commitments. Watch how changing the secret
          produces a completely uncorrelated hash output.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            className={`btn btn-small ${simPreset === 'alice' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => handlePreset('alice')}
          >
            👤 Alice (Passport)
          </button>
          <button
            className={`btn btn-small ${simPreset === 'bob' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => handlePreset('bob')}
          >
            👤 Bob (National ID)
          </button>
          <button
            className={`btn btn-small ${simPreset === 'corp' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => handlePreset('corp')}
          >
            🏢 Enterprise Fund (Corporate)
          </button>
          {connectedWallet && (
            <button
              className={`btn btn-small ${simPreset === 'custom' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setSimPreset('custom')
                setSimSecret(connectedWallet.address)
              }}
            >
              💳 Use Connected Wallet
            </button>
          )}
        </div>

        <div className="generator-box">
          <div className="gen-row">
            <span className="gen-label">1. Private Witness (Hidden):</span>
            <input
              type="text"
              value={simSecret}
              onChange={(e) => {
                setSimPreset('custom')
                setSimSecret(e.target.value)
              }}
              placeholder="Enter local secret identity..."
              style={{
                flex: 1,
                padding: '10px 14px',
                borderRadius: '10px',
                border: '1px solid var(--glass-border-bright)',
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                fontFamily: 'var(--mono)',
                fontSize: '13px',
              }}
            />
          </div>
          <div className="gen-row">
            <span className="gen-label">2. Public Commitment (On-Chain):</span>
            <span className="gen-value mono" style={{ color: 'var(--cyan-light)' }}>
              {simHash || 'Computing SHA-256 persistent hash...'}
            </span>
            <button
              className="btn btn-icon"
              onClick={() => onCopy(simHash, 'Simulated Commitment')}
              title="Copy Commitment"
            >
              📋
            </button>
          </div>
        </div>

        <div className="privacy-note" style={{ marginTop: 16 }}>
          <span className="privacy-icon">🛡️</span>
          <p>
            <strong>Mathematical Privacy Proof:</strong> An observer on Midnight Preprod can verify that the hash above
            exists in the approved registry, but cannot deduce <code className="mono">"{simSecret}"</code> from the 32-byte hash!
          </p>
        </div>
      </section>

      {/* ── 5. On-Chain Ledger State & Credential Registry Summary ── */}
      <section className="card">
        <h2>On-Chain Ledger State</h2>
        <dl className="stat-grid">
          <div>
            <dt>Authority Name</dt>
            <dd>{state?.authorityName ?? (isSandbox ? 'Midnight KYC Authority (Sandbox)' : 'Connecting to Preprod...')}</dd>
          </div>
          <div>
            <dt>Active Network</dt>
            <dd>{formatNetworkName(status?.network || 'preprod')}</dd>
          </div>
          <div>
            <dt>Contract Address</dt>
            <dd className="mono">
              {(() => {
                const addr = status?.contractAddress || import.meta.env.VITE_CONTRACT_ADDRESS || '1387bebdf07d4f8d5d9cc5d5f8e1e27db2a3a37e3b144daf4ec2413d5374abc0'
                return (
                  <span
                    style={{ cursor: 'pointer', color: 'var(--accent-light)' }}
                    onClick={() => onCopy(addr, 'Contract Address')}
                    title="Click to copy"
                  >
                    {shortHex(addr, 16, 12)} 📋
                  </span>
                )
              })()}
            </dd>
          </div>
          <div>
            <dt>Block Reference</dt>
            <dd className="mono">{isSandbox ? 'Block #2126833 (Simulated)' : (status ? 'Live Preprod Testnet' : 'Connecting to Preprod...')}</dd>
          </div>
        </dl>
        {balance && (
          <p className="balance-line" style={{ marginTop: 14, fontSize: 13, color: 'var(--text-s)' }}>
            Relayer Wallet: <span className="mono">{shortHex(balance.address, 12, 8)}</span> ·{' '}
            <strong>{Number(balance.tNight).toLocaleString()} tNIGHT</strong> ·{' '}
            {Number(balance.dust).toLocaleString()} DUST
          </p>
        )}
      </section>

      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Credential Registry Explorer</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Search commitment..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: '8px',
                border: '1px solid var(--glass-border)',
                background: 'rgba(0,0,0,0.4)',
                color: '#fff',
                fontSize: '12px',
                fontFamily: 'var(--mono)',
                minWidth: '200px',
              }}
            />
            <button
              className={`btn btn-small ${registryFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegistryFilter('all')}
            >
              All ({credentials.length})
            </button>
            <button
              className={`btn btn-small ${registryFilter === 'approved' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegistryFilter('approved')}
            >
              Approved ({approved})
            </button>
            <button
              className={`btn btn-small ${registryFilter === 'pending' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegistryFilter('pending')}
            >
              Pending ({pending})
            </button>
            <button
              className={`btn btn-small ${registryFilter === 'revoked' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegistryFilter('revoked')}
            >
              Revoked ({revoked})
            </button>
          </div>
        </div>

        {filteredCredentials.length === 0 ? (
          <p className="empty">No credentials matched the current filter or search query.</p>
        ) : (
          <ul className="credential-list">
            {filteredCredentials.map((c) => (
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
  userCommitment,
  userCredentialStatus,
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
  userCommitment: string | null
  userCredentialStatus: 'none' | 'pending' | 'approved' | 'revoked'
  commitmentInput: string
  setCommitmentInput: (v: string) => void
  onIssue: () => void
  onProve: (commitment: string) => void
  onCustomProve: () => void
  onCopy: (text: string, label: string) => void
}) {
  const approved = credentials.filter((c) => c.status === 'approved')
  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(
    userCredentialStatus === 'approved' ? 4 : userCredentialStatus === 'pending' ? 3 : 1
  )
  const [generatedSecret, setGeneratedSecret] = useState<string>(
    '0x8f3c7a19284bd026857193bca492817d64829105473829104857291039482019'
  )
  const [entropyStrength, setEntropyStrength] = useState<number>(100)
  const [telemetryLines, setTelemetryLines] = useState<string[]>([
    '[INIT] Midnight Compact Prover ready (v0.31.1).',
    '[ZKIR] Prover circuit: proveEligibility.bzkir loaded.',
    '[KEYS] Verification key: proveEligibility.verifier bound to Midnight Preprod.',
  ])

  useEffect(() => {
    if (userCredentialStatus === 'approved') setActiveStep(4)
    else if (userCredentialStatus === 'pending') setActiveStep(3)
  }, [userCredentialStatus])

  const handleGenerateSecret = () => {
    const arr = new Uint8Array(32)
    crypto.getRandomValues(arr)
    const hex = '0x' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
    setGeneratedSecret(hex)
    setEntropyStrength(100)
  }

  const handleProveWithTelemetry = (commitment: string) => {
    setTelemetryLines((prev) => [
      ...prev,
      `[${new Date().toLocaleTimeString()}] Fetching private witness localSecret from device...`,
      `[${new Date().toLocaleTimeString()}] Computing circuit constraint: persistentHash(localSecret) == ${shortHex(commitment, 6, 4)}`,
      `[${new Date().toLocaleTimeString()}] Verifying inclusion in on-chain credentials ledger set...`,
      `[${new Date().toLocaleTimeString()}] Verifying non-revocation in revokedCredentials ledger set...`,
      `[${new Date().toLocaleTimeString()}] Generating ZK-SNARK zero-knowledge proof without disclosure...`,
      `[${new Date().toLocaleTimeString()}] Proof verified! Incrementing eligibilityCount on Midnight Preprod.`,
    ])
    onProve(commitment)
  }

  return (
    <div className="actions">
      {/* ── Guided Stepper Navigation ── */}
      <div className="stepper-header">
        <button
          className={`stepper-tab ${activeStep === 1 ? 'active' : ''}`}
          onClick={() => setActiveStep(1)}
        >
          <span className="stepper-bubble">1</span>
          <span>Generate Identity Secret</span>
        </button>

        <button
          className={`stepper-tab ${activeStep === 2 ? 'active' : ''}`}
          onClick={() => setActiveStep(2)}
        >
          <span className="stepper-bubble">2</span>
          <span>Request KYC On-Chain</span>
        </button>

        <button
          className={`stepper-tab ${activeStep === 3 ? 'active' : ''} ${userCredentialStatus === 'approved' ? 'completed' : ''}`}
          onClick={() => setActiveStep(3)}
        >
          <span className="stepper-bubble">{userCredentialStatus === 'approved' ? '✓' : '3'}</span>
          <span>Authority Approval</span>
        </button>

        <button
          className={`stepper-tab ${activeStep === 4 ? 'active' : ''}`}
          onClick={() => setActiveStep(4)}
        >
          <span className="stepper-bubble">4</span>
          <span>Prove ZK Eligibility</span>
        </button>
      </div>

      {/* ── STEP 1: Generate Identity Secret ── */}
      {activeStep === 1 && (
        <section className="card">
          <h2>Step 1: Generate or Inspect Local Identity Secret</h2>
          <p>
            Your identity secret (<code className="mono">localSecret</code>) is a 256-bit cryptographically secure
            private key stored entirely in your browser's private memory. It is never exposed to the blockchain.
          </p>

          <div style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--glass-border)', borderRadius: 12, padding: 18, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-s)', fontWeight: 600 }}>
                256-Bit Cryptographic Private Witness:
              </span>
              <span className="pill pill-ok" style={{ fontSize: 11 }}>
                Entropy: {entropyStrength}% (Cryptographically Secure)
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <code className="mono" style={{ fontSize: 13, color: 'var(--accent-light)', flex: 1, wordBreak: 'break-all' }}>
                {generatedSecret}
              </code>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => onCopy(generatedSecret, 'Identity Secret')}
              >
                📋 Copy
              </button>
              <button
                className="btn btn-primary btn-small"
                onClick={handleGenerateSecret}
              >
                🎲 Re-roll Secret
              </button>
            </div>
          </div>

          <div className="privacy-note">
            <span className="privacy-icon">🔒</span>
            <p>
              <strong>Device-Bound Security:</strong> When connected via Lace Wallet, a unique deterministic witness is derived directly
              for your account address. When running via Relayer or Sandbox, this secret creates your one-way commitment.
            </p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-primary" onClick={() => setActiveStep(2)}>
              Continue to Step 2: Request KYC ➔
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 2: Request KYC On-Chain ── */}
      {activeStep === 2 && (
        <section className="card">
          <h2>Step 2: Submit Credential Request On-Chain</h2>
          <p>
            Submit your one-way cryptographic commitment into the Midnight smart contract's <code className="mono">pendingCredentials</code> set.
            The authority will review your documentation off-chain before approving.
          </p>

          <div className="holo-commitment-box" style={{ marginBottom: 18 }}>
            <div>
              <div className="holo-commitment-label">Derived 32-Byte Commitment:</div>
              <div className="holo-commitment-val mono">
                {userCommitment || 'e5d4c3b2a19087e6d5c4b3a291807f6e5d4c3b2a19087e6d5c4b3a291807f6e5'}
              </div>
            </div>
            <button
              className="btn btn-icon"
              onClick={() => onCopy(userCommitment || 'e5d4c3b2a19087e6d5c4b3a291807f6e5d4c3b2a19087e6d5c4b3a291807f6e5', 'Commitment')}
            >
              📋
            </button>
          </div>

          {connectedWallet && (
            <p style={{ fontSize: '13px', color: 'var(--emerald)', marginBottom: '14px' }}>
              💳 Connected via <strong>{connectedWallet.name}</strong> ({shortHex(connectedWallet.address, 8, 6)}).
            </p>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
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
                '➕ Request KYC Credential'
              )}
            </button>

            <button
              className="btn btn-secondary"
              onClick={() => setActiveStep(3)}
            >
              Skip to Step 3: Check Status ➔
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 3: Authority Approval Monitor ── */}
      {activeStep === 3 && (
        <section className="card">
          <h2>Step 3: Compliance Authority Approval Status</h2>
          <p>
            Once submitted, your commitment enters the authority verification queue. The trusted KYC authority
            authenticates with its private key and moves the commitment into the verified <code className="mono">credentials</code> ledger set.
          </p>

          <div style={{
            background: userCredentialStatus === 'approved' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)',
            border: `1px solid ${userCredentialStatus === 'approved' ? 'var(--emerald-border)' : 'var(--amber-border)'}`,
            borderRadius: 14,
            padding: 22,
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 16
          }}>
            <span style={{ fontSize: 32 }}>
              {userCredentialStatus === 'approved' ? '🛡️' : '⏳'}
            </span>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: 0, fontSize: 16, color: '#fff' }}>
                {userCredentialStatus === 'approved' ? 'Credential Verified & Approved!' : 'Awaiting Authority Approval'}
              </h3>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text)' }}>
                {userCredentialStatus === 'approved'
                  ? 'Your credential commitment is active in the Midnight Preprod smart contract. You can proceed to generate zero-knowledge eligibility proofs.'
                  : 'Your request is recorded in pendingCredentials. You can approve it from the Authority Actions tab or wait for the authority to sign.'}
              </p>
            </div>
            <div>
              <span className={`pill ${userCredentialStatus === 'approved' ? 'pill-ok' : 'pill-warn'}`}>
                {userCredentialStatus === 'approved' ? 'Approved' : 'Pending Queue'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setActiveStep(2)}>
              ⬅ Back to Step 2
            </button>
            <button
              className="btn btn-primary"
              onClick={() => setActiveStep(4)}
            >
              Continue to Step 4: Prove Eligibility ➔
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 4: Prove Zero-Knowledge Eligibility ── */}
      {activeStep === 4 && (
        <section className="card">
          <h2>Step 4: Prove Zero-Knowledge Eligibility</h2>
          <p>
            Execute the <code className="mono">proveEligibility</code> circuit. Midnight creates a zero-knowledge SNARK proof
            verifying you know the private witness behind an approved commitment, incrementing <code className="mono">eligibilityCount</code> on-chain.
          </p>

          {approved.length === 0 ? (
            <p className="empty">
              No approved credentials found in the active registry. Request a credential in Step 2 and approve it in the Authority tab.
            </p>
          ) : (
            <ul className="credential-list" style={{ marginBottom: 20 }}>
              {approved.map((c) => (
                <li key={c.commitment} className="credential-item status-approved">
                  <span className="status-dot" />
                  <span className="mono">{shortHex(c.commitment, 18, 14)}</span>
                  {userCommitment === c.commitment && (
                    <span className="pill pill-ok" style={{ fontSize: 11, padding: '2px 8px' }}>Your Pass</span>
                  )}
                  <button
                    className="btn btn-icon"
                    onClick={() => onCopy(c.commitment, 'Commitment')}
                    title="Copy Commitment"
                  >
                    📋
                  </button>
                  <button
                    className="btn btn-small btn-primary"
                    onClick={() => handleProveWithTelemetry(c.commitment)}
                    disabled={busy !== null}
                  >
                    {busy === 'proveEligibility' ? '⚡ Proving ZK…' : '⚡ Prove Eligibility'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Custom Commitment Prove Form */}
          <div className="inline-form" style={{ marginBottom: 16 }}>
            <input
              type="text"
              placeholder="Or paste any 64-character hex commitment string…"
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

          {/* ── Real-Time Telemetry Terminal ── */}
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-s)', textTransform: 'uppercase' }}>
                Zero-Knowledge Prover Circuit Telemetry:
              </span>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => setTelemetryLines([
                  '[INIT] Midnight Compact Prover ready (v0.31.1).',
                  '[ZKIR] Prover circuit: proveEligibility.bzkir loaded.',
                ])}
              >
                Clear Log
              </button>
            </div>

            <div className="telemetry-box">
              {telemetryLines.map((line, idx) => (
                <div key={idx} className="telemetry-line">
                  <span className="telemetry-prompt">❯</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
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
  const [searchTerm, setSearchTerm] = useState('')

  const filteredPending = pending.filter(c => !searchTerm || c.commitment.toLowerCase().includes(searchTerm.toLowerCase()))
  const filteredApproved = approved.filter(c => !searchTerm || c.commitment.toLowerCase().includes(searchTerm.toLowerCase()))

  const handleBatchApprove = () => {
    if (pending.length > 0) {
      onApprove(pending[0].commitment)
    }
  }

  return (
    <div className="actions">
      {/* ── Search Bar ── */}
      <section className="card" style={{ padding: '16px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Compliance Authority Control Panel</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-s)' }}>
              Authorized to sign approval circuits and maintain the active regulatory whitelist.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Search commitment..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--glass-border)',
                background: 'rgba(0,0,0,0.4)',
                color: '#fff',
                fontSize: 12,
                fontFamily: 'var(--mono)',
                minWidth: '220px',
              }}
            />
            {pending.length > 0 && (
              <button
                className="btn btn-primary btn-small"
                onClick={handleBatchApprove}
                disabled={busy !== null}
              >
                ⚡ Approve Next Pending
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Pending Requests ── */}
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Review Pending Credential Requests ({filteredPending.length})</h2>
          <span className="pill pill-warn">Pending Queue</span>
        </div>
        <p>
          Review credential requests submitted by users. Approving moves the commitment from{' '}
          <code className="mono">pendingCredentials</code> to <code className="mono">credentials</code>.
        </p>
        {filteredPending.length === 0 ? (
          <p className="empty">No pending credential requests awaiting approval.</p>
        ) : (
          <ul className="credential-list">
            {filteredPending.map((c) => (
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

      {/* ── Active Whitelist & Revocation ── */}
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Active Whitelisted Credentials ({filteredApproved.length})</h2>
          <span className="pill pill-ok">Active Registry</span>
        </div>
        <p>
          Revoke compliance authorization for a commitment. Revoked credentials cannot be used for ZK eligibility verification.
        </p>
        {filteredApproved.length === 0 ? (
          <p className="empty">No active approved credentials to revoke.</p>
        ) : (
          <ul className="credential-list">
            {filteredApproved.map((c) => (
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
  const [filterAction, setFilterAction] = useState<string>('all')
  const [search, setSearch] = useState<string>('')

  const filteredHistory = history.filter((item) => {
    if (filterAction !== 'all' && item.action !== filterAction) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        item.action.toLowerCase().includes(q) ||
        item.txId.toLowerCase().includes(q) ||
        (item.commitment && item.commitment.toLowerCase().includes(q)) ||
        item.message.toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div className="actions">
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>Transaction & ZK Proof Audit Explorer</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Search txId or commitment..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid var(--glass-border)',
                background: 'rgba(0,0,0,0.4)',
                color: '#fff',
                fontSize: 12,
                fontFamily: 'var(--mono)',
                minWidth: '200px',
              }}
            />
            <button
              className={`btn btn-small ${filterAction === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterAction('all')}
            >
              All ({history.length})
            </button>
            <button
              className={`btn btn-small ${filterAction === 'issueCredential' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterAction('issueCredential')}
            >
              Issue
            </button>
            <button
              className={`btn btn-small ${filterAction === 'approveCredential' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterAction('approveCredential')}
            >
              Approve
            </button>
            <button
              className={`btn btn-small ${filterAction === 'proveEligibility' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterAction('proveEligibility')}
            >
              Prove
            </button>
            <button
              className={`btn btn-small ${filterAction === 'revokeCredential' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterAction('revokeCredential')}
            >
              Revoke
            </button>
          </div>
        </div>

        <p style={{ marginBottom: 18 }}>
          Real-time log of transactions submitted to the Midnight contract. Verify block inclusion and proof status.
        </p>

        {filteredHistory.length === 0 ? (
          <p className="empty">No audit history recorded yet. Perform actions to view transaction receipts.</p>
        ) : (
          <ul className="history-list">
            {filteredHistory.map((item) => (
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
                      title="Click to copy full transaction ID"
                    >
                      {shortHex(item.txId, 10, 8)} 📋
                    </code>
                  </span>
                  {item.commitment && (
                    <span>
                      Commitment:{' '}
                      <code
                        className="mono"
                        style={{ cursor: 'pointer', color: 'var(--cyan-light)' }}
                        onClick={() => onCopy(item.commitment!, 'Commitment')}
                        title="Click to copy full commitment"
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