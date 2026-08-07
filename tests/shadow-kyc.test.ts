import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createConstructorContext,
  createCircuitContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'shadow-kyc');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

// Load the compiled contract
const ShadowKyc = await import(pathToFileURL(contractPath).href);

// Fixed test secrets — these are the "private witnesses" that must NEVER
// appear in any output, event, or public state.
const AUTHORITY_SECRET = new Uint8Array(32).fill(0xaa);
const USER_SECRET = new Uint8Array(32).fill(0xbb);

// A valid CoinPublicKey is a string (BIP340 public key hex)
const TEST_COIN_PUBLIC_KEY = '0000000000000000000000000000000000000000000000000000000000000001';

// ─── State threading helpers ─────────────────────────────────────────────────
//
// The contract state lives on-chain and is shared by ALL callers. In the
// headless testkit we thread it manually: each circuit call takes the current
// state and produces an updated state used by the next call.

type TestState = {
  currentContractState: any;
  currentPrivateState: any;
};

// Create a contract instance with a given secret as the localSecret witness.
function createContract(secret: Uint8Array) {
  return new ShadowKyc.Contract({
    localSecret: () => [secret, secret],
  });
}

// Run the constructor to get the initial on-chain state.
function createInitialState(contract: any, name: string): TestState {
  const ctx = createConstructorContext({}, TEST_COIN_PUBLIC_KEY);
  const result = contract.initialState(ctx, name);
  return {
    currentContractState: result.currentContractState,
    currentPrivateState: result.currentPrivateState,
  };
}

// Run a circuit against the given state. Returns { result, next } where
// `next` is the updated state for subsequent calls.
function runCircuit(
  contract: any,
  circuitName: string,
  state: TestState,
  ...args: any[]
): { result: any; next: TestState } {
  const ctx = createCircuitContext(
    dummyContractAddress(),
    TEST_COIN_PUBLIC_KEY,
    state.currentContractState,
    state.currentPrivateState,
  );
  const result = contract.circuits[circuitName](ctx, ...args);
  return {
    result,
    next: {
      currentContractState: result.context.currentQueryContext.state.state,
      currentPrivateState: result.context.currentPrivateState,
    },
  };
}

// Read the ledger (public state) from a test state.
function getLedger(state: TestState) {
  const cs = state.currentContractState;
  // The constructor returns a ContractState (whose .data is a ChargedState),
  // while circuit runs return a StateValue directly. The ledger() function
  // accepts either a StateValue or a ChargedState.
  const charged = cs.data ?? cs;
  return ShadowKyc.ledger(charged);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Shadow-KYC / ZK-AML contract', () => {
  let authorityContract: any;
  let userContract: any;
  let initialState: TestState;

  beforeEach(() => {
    authorityContract = createContract(AUTHORITY_SECRET);
    userContract = createContract(USER_SECRET);
    initialState = createInitialState(authorityContract, 'Shadow-KYC Authority');
  });

  describe('constructor', () => {
    it('sets the authority name publicly', () => {
      const ledger = getLedger(initialState);
      expect(Buffer.from(ledger.authorityName).toString()).toBe('Shadow-KYC Authority');
    });

    it('initializes credential sets to empty', () => {
      const ledger = getLedger(initialState);
      expect(ledger.pendingCredentials.size()).toBe(0n);
      expect(ledger.credentials.size()).toBe(0n);
      expect(ledger.revokedCredentials.size()).toBe(0n);
      expect(ledger.eligibilityCount).toBe(0n);
    });
  });

  describe('issueCredential', () => {
    it('adds a credential commitment to pending set', () => {
      const { next } = runCircuit(userContract, 'issueCredential', initialState);
      const ledger = getLedger(next);
      expect(ledger.pendingCredentials.size()).toBe(1n);
      expect(ledger.credentials.size()).toBe(0n);
    });

    it('rejects duplicate credential requests', () => {
      // First issue succeeds
      const { next } = runCircuit(userContract, 'issueCredential', initialState);
      // Second issue with the same secret must fail (commitment already pending)
      expect(() => runCircuit(userContract, 'issueCredential', next)).toThrow();
    });
  });

  describe('approveCredential', () => {
    it('authority can approve a pending credential', () => {
      // User issues a credential
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];

      // Authority approves it against the shared state
      const approved = runCircuit(authorityContract, 'approveCredential', issued.next, commitment);
      const approvedLedger = getLedger(approved.next);
      expect(approvedLedger.pendingCredentials.size()).toBe(0n);
      expect(approvedLedger.credentials.size()).toBe(1n);
      expect(approvedLedger.credentials.member(commitment)).toBe(true);
    });

    it('rejects approval from non-authority', () => {
      // User issues a credential
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];

      // User (not authority) tries to approve
      expect(() => runCircuit(userContract, 'approveCredential', issued.next, commitment)).toThrow();
    });
  });

  describe('proveEligibility', () => {
    it('user can prove eligibility for an approved credential', () => {
      // User issues a credential
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];

      // Authority approves it
      const approved = runCircuit(authorityContract, 'approveCredential', issued.next, commitment);

      // User proves eligibility — the ZK proof of holding the credential
      const proved = runCircuit(userContract, 'proveEligibility', approved.next, commitment);
      const provedLedger = getLedger(proved.next);
      expect(provedLedger.eligibilityCount).toBe(1n);
    });

    it('rejects eligibility proof for unapproved credential', () => {
      // User issues a credential but it is NOT approved
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];

      // User tries to prove eligibility — should fail, credential not approved
      expect(() => runCircuit(userContract, 'proveEligibility', issued.next, commitment)).toThrow();
    });

    it('rejects eligibility proof for revoked credential', () => {
      // User issues a credential
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];

      // Authority approves it
      const approved = runCircuit(authorityContract, 'approveCredential', issued.next, commitment);

      // Authority revokes it
      const revoked = runCircuit(authorityContract, 'revokeCredential', approved.next, commitment);
      const revokedLedger = getLedger(revoked.next);
      expect(revokedLedger.revokedCredentials.member(commitment)).toBe(true);

      // User tries to prove eligibility — should fail, credential revoked
      expect(() => runCircuit(userContract, 'proveEligibility', revoked.next, commitment)).toThrow();
    });
  });

  describe('revokeCredential', () => {
    it('authority can revoke an approved credential', () => {
      // User issues a credential
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];

      // Authority approves it
      const approved = runCircuit(authorityContract, 'approveCredential', issued.next, commitment);

      // Authority revokes it
      const revoked = runCircuit(authorityContract, 'revokeCredential', approved.next, commitment);
      const revokedLedger = getLedger(revoked.next);
      expect(revokedLedger.credentials.size()).toBe(0n);
      expect(revokedLedger.revokedCredentials.size()).toBe(1n);
      expect(revokedLedger.revokedCredentials.member(commitment)).toBe(true);
    });

    it('rejects revocation from non-authority', () => {
      // User issues a credential
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];

      // User (not authority) tries to revoke
      expect(() => runCircuit(userContract, 'revokeCredential', issued.next, commitment)).toThrow();
    });
  });

  describe('PRIVACY: private inputs are never exposed', () => {
    it('the user secret never appears in any ledger state or output', () => {
      // User issues a credential and proves eligibility
      const issued = runCircuit(userContract, 'issueCredential', initialState);
      const pendingLedger = getLedger(issued.next);
      const commitment = [...pendingLedger.pendingCredentials][0];
      const approved = runCircuit(authorityContract, 'approveCredential', issued.next, commitment);
      const proved = runCircuit(userContract, 'proveEligibility', approved.next, commitment);

      const ledger = getLedger(proved.next);

      // Serialize the ENTIRE public ledger state
      const serialized = JSON.stringify({
        authority: Array.from(ledger.authority),
        authorityName: Buffer.from(ledger.authorityName).toString(),
        pendingCredentials: [...ledger.pendingCredentials].map((c: Uint8Array) => Array.from(c)),
        credentials: [...ledger.credentials].map((c: Uint8Array) => Array.from(c)),
        revokedCredentials: [...ledger.revokedCredentials].map((c: Uint8Array) => Array.from(c)),
        eligibilityCount: ledger.eligibilityCount.toString(),
      });

      // The user's secret bytes (0xbb repeated) must NOT appear anywhere
      expect(serialized).not.toContain(JSON.stringify(Array.from(USER_SECRET)));
      expect(serialized).not.toContain(Buffer.from(USER_SECRET).toString('hex'));
    });

    it('the authority secret never appears in any ledger state or output', () => {
      const ledger = getLedger(initialState);
      const serialized = JSON.stringify({
        authority: Array.from(ledger.authority),
        authorityName: Buffer.from(ledger.authorityName).toString(),
      });

      // The authority's secret bytes (0xaa repeated) must NOT appear anywhere
      expect(serialized).not.toContain(JSON.stringify(Array.from(AUTHORITY_SECRET)));
      expect(serialized).not.toContain(Buffer.from(AUTHORITY_SECRET).toString('hex'));
    });

    it('the proof data public transcript does not contain the private secret', () => {
      // Run a circuit and inspect the proof data
      const { result } = runCircuit(userContract, 'issueCredential', initialState);
      const proofData = result.proofData;

      // The public transcript must not contain the secret in any form
      const transcriptStr = JSON.stringify(proofData.publicTranscript);
      expect(transcriptStr).not.toContain(Buffer.from(USER_SECRET).toString('hex'));
      expect(transcriptStr).not.toContain(JSON.stringify(Array.from(USER_SECRET)));
    });
  });
});