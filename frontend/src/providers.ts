/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from 'buffer';
import { type ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId, type NetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { Transaction, type FinalizedTransaction, type TransactionId } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { type WalletProvider, type MidnightProvider, type MidnightProviders, type UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import { inMemoryPrivateStateProvider } from './in-memory-private-state-provider';

export interface ShadowKycPrivateState {
  readonly localSecret: Uint8Array;
}

export async function initializeClientProviders(
  connectedAPI: ConnectedAPI
): Promise<MidnightProviders<any, string, ShadowKycPrivateState>> {
  console.log('[Providers] Fetching wallet connector configuration...');
  const config = await connectedAPI.getConfiguration();
  console.log('[Providers] Wallet Config:', config);
  
  // Set the network ID dynamically from the connected wallet
  const networkId = config.networkId || import.meta.env.VITE_NETWORK || 'preprod';
  setNetworkId(networkId as NetworkId);

  // Set the indexer and prover endpoints dynamically from the connected wallet
  const indexerUri = config.indexerUri;
  const indexerWsUri = config.indexerWsUri;
  const proverServerUri = `${window.location.origin}/api/prover`;

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    balanceTx: async (tx: UnboundTransaction, _ttl?: Date): Promise<FinalizedTransaction> => {
      console.log('[TX] balanceUnsealedTransaction started', tx);
      try {
        const serializedTx = Buffer.from(tx.serialize()).toString('hex');
        console.log('[TX] Calling walletApi.balanceUnsealedTransaction...');
        const balanced = await connectedAPI.balanceUnsealedTransaction(serializedTx);
        console.log('[TX] balanceUnsealedTransaction completed successfully:', balanced);
        return Transaction.deserialize(
          'signature',
          'proof',
          'binding',
          Buffer.from(balanced.tx, 'hex'),
        ) as FinalizedTransaction;
      } catch (err: any) {
        console.error('[TX] balanceUnsealedTransaction failed! Diagnostic Details:');
        console.error('Constructor:', err?.constructor?.name);
        console.error('Name:', err?.name);
        console.error('Message:', err?.message);
        console.error('Code:', err?.code);
        console.error('Reason:', err?.reason);
        console.error('Cause:', err?.cause);
        console.error('Stack:', err?.stack);
        console.error('Full Error Object:', err);
        throw err;
      }
    }
  };

  // Midnight provider wrapping the connectedAPI
  const midnightProvider: MidnightProvider = {
    submitTx: async (tx: FinalizedTransaction): Promise<TransactionId> => {
      console.log('[TX] submitTransaction started', tx);
      try {
        const serializedTx = Buffer.from(tx.serialize()).toString('hex');
        console.log('[TX] Calling walletApi.submitTransaction...');
        await connectedAPI.submitTransaction(serializedTx);
        console.log('[TX] submitTransaction completed successfully.');
        const txIdentifiers = tx.identifiers();
        console.log('[Providers] Submitted Tx IDs:', txIdentifiers);
        return txIdentifiers[0] as TransactionId;
      } catch (err: any) {
        console.error('[TX] submitTransaction failed! Diagnostic Details:');
        console.error('Constructor:', err?.constructor?.name);
        console.error('Name:', err?.name);
        console.error('Message:', err?.message);
        console.error('Code:', err?.code);
        console.error('Reason:', err?.reason);
        console.error('Cause:', err?.cause);
        console.error('Stack:', err?.stack);
        console.error('Full Error Object:', err);
        throw err;
      }
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
