/**
 * Thin typed client for the Shadow-KYC API server.
 *
 * In dev, Vite proxies /api to the API server (see vite.config.ts). In
 * production, requests are sent to the deployed Shadow-KYC API server
 * configured via VITE_API_BASE_URL.
 */
import type {
  ApiError,
  AuditHistoryResponse,
  BalanceInfo,
  ContractState,
  ServerStatus,
  TxResponse,
} from './types';

export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ||
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ||
  '/api';
const BASE = API_BASE;

async function request<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  const timeoutMs = init?.timeout ?? (init?.method === 'POST' ? 120000 : 8000);
  const { timeout, ...fetchInit } = init || {};
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      ...fetchInit,
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`API request timed out after ${timeoutMs / 1000}s (${path}). The backend may be processing a ZK transaction or is unreachable.`);
    }
    if (err instanceof TypeError && /failed to fetch/i.test(err.message)) {
      throw new Error(
        `Shadow-KYC API unreachable at ${BASE}${path}. Please verify that the permanent backend API is active and CORS is enabled.`
      );
    }
    throw err;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response (e.g. HTML error page).
  }

  if (!res.ok) {
    let message = (body as ApiError | null)?.error;
    if (!message) {
      if (res.status === 405) {
        message = `API endpoint rejected method (${res.status} Method Not Allowed on ${path}). Ensure permanent backend is deployed and handling POST requests.`;
      } else if (res.status === 404) {
        message = `API route not found (${res.status} on ${path}). Ensure permanent API server is running.`;
      } else {
        message = `Request failed with status ${res.status}`;
      }
    }
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