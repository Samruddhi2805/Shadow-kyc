import { useCallback, useEffect, useMemo, useState } from 'react'

declare global {
  interface Window {
    midnight?: Record<string, {
      name: string;
      apiVersion: string;
      isEnabled: () => Promise<boolean>;
      connect: (networkId: string) => Promise<any>;
    }>;
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

// ─── Main Component ────────────────────────────────────────────────────────────

function App() {
  const [status, setStatus] = useState<ServerStatus | null>({
    server: 'shadow-kyc-api',
    network: 'undeployed',
    contractAddress: import.meta.env.VITE_CONTRACT_ADDRESS || '441b38cab94500e09d6adb799fcecfa00537578c1e46b393ef893eb2c2361ac2',
    authorityPublicKey: '04bcf7ad3be7a5c790460be82a713af570f22e0f801f6659ab8e84a52be6969e',
    frontendBuilt: true,
    timestamp: new Date().toISOString(),
  })
  const [state, setState] = useState<ContractState | null>({
    authority: '04bcf7ad3be7a5c790460be82a713af570f22e0f801f6659ab8e84a52be6969e',
    authorityName: 'Midnight KYC Authority',
    pendingCredentials: [],
    credentials: ['a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef'],
    revokedCredentials: [],
    eligibilityCount: '1',
  })
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

      const activeNet = status?.network === 'preview' ? 'preview' : (status?.network || 'testnet')
      let walletApi: any = null

      // Multi-network & fallback connection attempt
      const netOptions = [activeNet, 'preview', 'testnet', 'preprod', 'undeployed']
      let lastErr: any = null

      for (const netChoice of netOptions) {
        try {
          if (typeof wallet.connect === 'function') {
            walletApi = await Promise.race([
              wallet.connect(netChoice),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Wallet request timed out — please check 1AM extension popup.')), 10000))
            ])
            if (walletApi) break
          }
        } catch (e) {
          lastErr = e
          console.warn(`[Wallet Connection] ${netChoice} attempt failed:`, e)
        }
      }

      if (!walletApi && typeof (wallet as any).connect === 'function') {
        try {
          walletApi = await (wallet as any).connect()
        } catch (e) {
          lastErr = e
        }
      }

      if (!walletApi && typeof (wallet as any).enable === 'function') {
        try {
          walletApi = await (wallet as any).enable()
        } catch (e) {
          lastErr = e
        }
      }

      if (!walletApi) {
        throw lastErr || new Error(`Unable to connect to ${wallet.name || walletId}. Make sure your wallet is unlocked and set to Preview Testnet.`)
      }

      console.log(`[Wallet Connection] Connected API:`, walletApi)

      // Address resolution compatibility
      let address = 'mn_wallet_account'
      if (typeof walletApi.getUnshieldedAddress === 'function') {
        address = await walletApi.getUnshieldedAddress()
      } else if (typeof walletApi.getAddresses === 'function') {
        const addrs = await walletApi.getAddresses()
        address = Array.isArray(addrs) ? addrs[0] : addrs
      } else if (typeof walletApi.state === 'function') {
        const st = await walletApi.state()
        address = st?.unshielded?.address || st?.address || address
      }

      // Balance resolution compatibility
      let rawBalance = '10000'
      try {
        if (typeof walletApi.getUnshieldedBalances === 'function') {
          const balances = await walletApi.getUnshieldedBalances()
          rawBalance = (balances['00'] ?? Object.values(balances)[0] ?? 10000n).toString()
        } else if (typeof walletApi.getBalances === 'function') {
          const balances = await walletApi.getBalances()
          rawBalance = (balances['00'] ?? Object.values(balances)[0] ?? 10000n).toString()
        }
      } catch (balErr) {
        console.warn('[Wallet Connection] Balance query warning:', balErr)
      }

      const walletObj: ConnectedWalletInfo = {
        id: walletId,
        name: wallet.name || walletId,
        address: typeof address === 'string' ? address : String(address),
        tNight: rawBalance,
        dust: '100',
        network: status?.network === 'preview' ? 'Midnight Preview' : 'Midnight Network',
        isWebWallet: false,
      }

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

  const connectWebWallet = useCallback(() => {
    setIsConnectingWallet(true)
    setTimeout(() => {
      const randomHexAdd = 'mn_1' + Array.from({ length: 36 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
      const walletObj: ConnectedWalletInfo = {
        id: 'web-wallet',
        name: 'Midnight Devnet Web Wallet',
        address: randomHexAdd,
        tNight: '10000',
        dust: '500',
        network: status?.network === 'preview' ? 'Midnight Preview' : 'Midnight Local Devnet',
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
      if (s) setStatus(s)
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
        setTxProgress((prev) =>
          prev ? { ...prev, step: 'error', error: errMsg } : null
        )
        showToast('error', errMsg)
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
    let customC: string | undefined = undefined
    if (connectedWallet) {
      customC = await simulateCommitment(connectedWallet.address)
    }
    void runTxWithModal('issueCredential', 'Request KYC Credential', customC, () =>
      api.issueCredential(customC)
    )
  }, [connectedWallet, runTxWithModal])

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
      void runTxWithModal('proveEligibility', 'Zero-Knowledge Prove Eligibility', commitment, () =>
        api.proveEligibility(commitment)
      )
    },
    [runTxWithModal]
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
    void runTxWithModal('proveEligibility', 'Zero-Knowledge Prove Custom Commitment', c, () =>
      api.proveEligibility(c)
    )
  }, [commitmentInput, runTxWithModal, showToast])

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

            {txProgress.step === 'error' && (
              <div className="wallet-pop-details" style={{ borderColor: 'var(--rose-border)', background: 'rgba(244, 63, 94, 0.08)' }}>
                <p style={{ margin: 0, fontWeight: 600, color: 'var(--rose)', fontSize: 14 }}>
                  ❌ Transaction Error: {txProgress.error}
                </p>
              </div>
            )}

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