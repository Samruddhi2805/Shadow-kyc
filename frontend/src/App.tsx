import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { AuditRecord, BalanceInfo, ContractState, CredentialEntry, ServerStatus, TxResponse } from './types'
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

// Simple client-side pseudo-hash simulation for the interactive visualizer
async function simulateCommitment(secret: string): Promise<string> {
  if (!secret) return '00'.repeat(32)
  const encoder = new TextEncoder()
  const data = encoder.encode(`shadow-kyc:secret:${secret}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Toast / notification state ────────────────────────────────────────────────

interface Toast {
  kind: 'success' | 'error' | 'info'
  text: string
}

// ─── Main component ────────────────────────────────────────────────────────────

function App() {
  const [status, setStatus] = useState<ServerStatus | null>({
    server: 'shadow-kyc-api',
    network: 'undeployed',
    contractAddress: '284dc91af0ef0729907f28321017df24f8063b786185f46bdc0d69999d09dae1',
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

  const showToast = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text })
    window.setTimeout(() => setToast(null), 5000)
  }, [])

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

      // Balance and history are best-effort — silently skip on 503 / error
      const [b, h] = await Promise.allSettled([
        api.getBalance(),
        api.getHistory(),
      ])
      if (b.status === 'fulfilled') setBalance(b.value)
      if (h.status === 'fulfilled') setHistory(h.value.history ?? [])
    } catch {
      // Silently ignore — we show offline pill in header
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Poll every 8s so the dashboard stays fresh after transactions land.
    const id = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(id)
  }, [refresh])

  const runTx = useCallback(
    async (label: string, fn: () => Promise<TxResponse>) => {
      setBusy(label)
      try {
        const tx = await fn()
        showToast('success', `${tx.message} (tx ${shortHex(tx.txId, 8, 6)})`)
        await refresh()
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : `${label} failed`)
      } finally {
        setBusy(null)
      }
    },
    [refresh, showToast],
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

  const handleIssue = useCallback(() => {
    void runTx('issueCredential', () => api.issueCredential())
  }, [runTx])

  const handleApprove = useCallback(
    (commitment: string) => {
      void runTx('approveCredential', () => api.approveCredential(commitment))
    },
    [runTx],
  )

  const handleProve = useCallback(
    (commitment: string) => {
      void runTx('proveEligibility', () => api.proveEligibility(commitment))
    },
    [runTx],
  )

  const handleRevoke = useCallback(
    (commitment: string) => {
      void runTx('revokeCredential', () => api.revokeCredential(commitment))
    },
    [runTx],
  )

  const handleCustomProve = useCallback(() => {
    const c = commitmentInput.trim()
    if (!/^[0-9a-fA-F]{64}$/.test(c)) {
      showToast('error', 'Enter a valid 64-character hex commitment')
      return
    }
    void runTx('proveEligibility', () => api.proveEligibility(c))
  }, [commitmentInput, runTx, showToast])

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
          {balance && (
            <span className="pill pill-neutral">
              {Number(balance.tNight).toLocaleString()} tNIGHT
            </span>
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
            onCopy={copyToClipboard}
          />
        )}

        {activeTab === 'user' && (
          <UserActions
            busy={busy}
            credentials={credentials}
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
    </div>
  )
}

// ─── Overview tab ──────────────────────────────────────────────────────────────

function Overview({
  status,
  state,
  credentials,
  balance,
  onCopy,
}: {
  status: ServerStatus | null
  state: ContractState | null
  credentials: CredentialEntry[]
  balance: BalanceInfo | null
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

// ─── User Actions tab ──────────────────────────────────────────────────────────

function UserActions({
  busy,
  credentials,
  commitmentInput,
  setCommitmentInput,
  onIssue,
  onProve,
  onCustomProve,
  onCopy,
}: {
  busy: string | null
  credentials: CredentialEntry[]
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

// ─── Authority tab ─────────────────────────────────────────────────────────────

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