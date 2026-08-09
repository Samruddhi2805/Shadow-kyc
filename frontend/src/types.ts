/**
 * Shared types for the Shadow-KYC frontend.
 *
 * These mirror the JSON shapes returned by the API server (src/api-server.ts).
 */

/** The full public ledger state of the Shadow-KYC contract. */
export interface ContractState {
  /** The authority's dapp-specific public key (hex). */
  authority: string;
  /** The authority's public name (deliberately disclosed). */
  authorityName: string;
  /** Credential commitments awaiting approval (hex). */
  pendingCredentials: string[];
  /** Approved credential commitments (hex). */
  credentials: string[];
  /** Revoked credential commitments (hex). */
  revokedCredentials: string[];
  /** Public counter of eligibility proofs performed. */
  eligibilityCount: string;
}

/** Response from GET /api/status. */
export interface ServerStatus {
  server: string;
  network: string;
  contractAddress: string;
  authorityPublicKey: string | null;
  frontendBuilt: boolean;
  timestamp: string;
}

/** Response from GET /api/balance. */
export interface BalanceInfo {
  network: string;
  address: string;
  tNight: string;
  dust: string;
}

/** Response from a successful transaction POST. */
export interface TxResponse {
  txId: string;
  blockHeight: number;
  commitment?: string;
  message: string;
}

/** Error shape returned by the API server. */
export interface ApiError {
  error: string;
}

/** A credential commitment with its derived status. */
export interface CredentialEntry {
  commitment: string;
  status: 'pending' | 'approved' | 'revoked';
}

/** Record in the audit transaction log. */
export interface AuditRecord {
  id: string;
  action: 'issueCredential' | 'approveCredential' | 'proveEligibility' | 'revokeCredential';
  txId: string;
  blockHeight: number;
  commitment?: string;
  timestamp: string;
  message: string;
}

export interface AuditHistoryResponse {
  history: AuditRecord[];
}

export interface ConnectedWalletInfo {
  id: string;
  name: string;
  address: string;
  tNight: string;
  dust?: string;
  network?: string;
  isWebWallet?: boolean;
}

export interface TxModalProgressState {
  open: boolean;
  action: 'issueCredential' | 'approveCredential' | 'proveEligibility' | 'revokeCredential';
  step: 'witness' | 'proving' | 'signing' | 'confirming' | 'done' | 'error';
  title: string;
  commitment?: string;
  txId?: string;
  blockHeight?: number;
  message?: string;
  error?: string;
}