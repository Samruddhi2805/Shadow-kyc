/**
 * Check wallet balance on the local Midnight devnet
 */
import { WebSocket } from 'ws';

// Midnight SDK imports
import { resolveNetwork, getOrCreateSeed } from './network';
// unshieldedToken is re-exported from ./wallet (originally @midnight-ntwrk/midnight-js-protocol/ledger).
import { createWallet, persistWalletState, unshieldedToken } from './wallet';

// Enable WebSocket for GraphQL subscriptions
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// ─── Network configuration ─────────────────────────────────────────────────────

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   Wallet Balance Checker                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  try {
    console.log('  Building wallet...');
    const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
    const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
    if (restoredCount > 0) {
      console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state — sync will resume from saved point.`);
    }

    console.log('  Syncing with network...');
    console.log('  ℹ  This may take several minutes depending on network size.');
    console.log('     RPC disconnection messages during sync are normal and can be safely ignored.\n');
    const syncStart = Date.now();

    const sub = walletCtx.wallet.state().subscribe((state) => {
      const elapsed = Math.round((Date.now() - syncStart) / 1000);
      
      const shieldedApplied = state.shielded.progress.appliedIndex;
      const shieldedTip = state.shielded.progress.highestRelevantWalletIndex;
      const shieldedPct = shieldedTip > 0n ? ((Number(shieldedApplied) / Number(shieldedTip)) * 100).toFixed(1) : '0.0';
      
      const dustApplied = state.dust.progress.appliedIndex;
      const dustTip = state.dust.progress.highestRelevantWalletIndex;
      const dustPct = dustTip > 0n ? ((Number(dustApplied) / Number(dustTip)) * 100).toFixed(1) : '0.0';

      const unshieldedSynced = state.unshielded.progress.isStrictlyComplete() ? 'Synced' : 'Syncing';
      
      process.stdout.write(
        `\r  ⏳ Syncing... [Shielded: ${shieldedPct}% (${shieldedApplied}/${shieldedTip})] [Dust: ${dustPct}% (${dustApplied}/${dustTip})] [Unshielded: ${unshieldedSynced}] (${elapsed}s elapsed)   `
      );
    });

    const SYNC_TIMEOUT_MS = 1_800_000; // 30 minutes
    let state;
    try {
      const syncPromise = walletCtx.wallet.waitForSyncedState();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Sync timed out after ${SYNC_TIMEOUT_MS / 60000} minutes.`)), SYNC_TIMEOUT_MS)
      );
      state = await Promise.race([syncPromise, timeoutPromise]) as any;
    } catch (err: any) {
      sub.unsubscribe();
      console.error(`\n❌ Sync error: ${err.message}`);
      await walletCtx.wallet.stop();
      process.exit(1);
    }

    sub.unsubscribe();
    process.stdout.write('\r  ✓ Synced with network.                                      \n');

    const address = walletCtx.unshieldedKeystore.getBech32Address();
    const tNightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    const dustBalance = state.dust.balance(new Date());

    console.log('\n─── Wallet Details ─────────────────────────────────────────────\n');
    console.log(`  Address: ${address}`);
    console.log(`  Network: ${networkConfig.networkId}\n`);

    console.log('─── Balances ───────────────────────────────────────────────────\n');
    console.log(`  tNight: ${tNightBalance.toLocaleString()}`);
    console.log(`  DUST:   ${dustBalance.toLocaleString()}\n`);

    if (tNightBalance === 0n) {
      if (network === 'undeployed') {
        console.log('  ⚠ Wallet has no tNight. Make sure the local devnet is running');
        console.log('     (npm run setup) — the genesis seed is pre-funded by the dev preset.\n');
      } else if (networkConfig.faucet) {
        console.log(`  ⚠ Wallet has no tNight. Fund it from the faucet:`);
        console.log(`     ${networkConfig.faucet}`);
        console.log(`     Wallet address: ${address}\n`);
      } else {
        console.log('  ⚠ Wallet has no tNight.\n');
      }
    } else {
      console.log('  ✅ Wallet is funded and ready!\n');
    }

    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
