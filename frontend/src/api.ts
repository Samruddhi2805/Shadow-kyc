/**
 * Thin typed client for the Shadow-KYC API server.
 *
 * In dev, Vite proxies /api to the API server (see vite.config.ts). In
 * production, requests are sent to the deployed Shadow-KYC API server.
 */
import type {
  ApiError,
  AuditHistoryResponse,
  BalanceInfo,
  ContractState,
  ServerStatus,
  TxResponse,
} from './types';

export const API_BASE = 'https://peninsula-stats-ctrl-brakes.trycloudflare.com/api';
const BASE = API_BASE;

async function request<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  const timeoutMs = init?.timeout ?? (init?.method === 'POST' ? 120000 : 5000);
  const { timeout, ...fetchInit } = init || {};
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    ...fetchInit,
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response (e.g. HTML error page).
  }

  if (!res.ok) {
    const message =
      (body as ApiError | null)?.error ??
      `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return body as T;
}

export const api = {
  getStatus: () => request<ServerStatus>('/status'),

  getState: () => request<ContractState>('/state'),

  getBalance: () => request<BalanceInfo>('/balance'),

  getHistory: () => request<AuditHistoryResponse>('/history'),

  issueCredential: (commitment?: string) =>
    request<TxResponse>('/issue', {
      method: 'POST',
      body: JSON.stringify(commitment ? { commitment } : {}),
    }),

  approveCredential: (commitment: string) =>
    request<TxResponse>('/approve', {
      method: 'POST',
      body: JSON.stringify({ commitment }),
    }),

  proveEligibility: (commitment: string) =>
    request<TxResponse>('/prove', {
      method: 'POST',
      body: JSON.stringify({ commitment }),
    }),

  revokeCredential: (commitment: string) =>
    request<TxResponse>('/revoke', {
      method: 'POST',
      body: JSON.stringify({ commitment }),
    }),

  recordAudit: (record: {
    action: string;
    txId: string;
    blockHeight: number;
    commitment?: string;
    message: string;
  }) =>
    request<{ success: boolean }>('/audit', {
      method: 'POST',
      body: JSON.stringify(record),
    }),
};
