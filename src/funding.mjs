import { appendFile } from 'node:fs/promises';
import { phloLimitForNode, vaultAddress } from './chain.mjs';

export function fundingTerm(from, recipients) {
  const entries = recipients.map(({ address, amount }) => `(${JSON.stringify(address)}, ${amount})`).join(', ');
  return `new lookup(\`rho:registry:lookup\`), deployer(\`rho:system:deployerId\`),
    deployId(\`rho:system:deployId\`), sysCh, vaultCh, authCh, next in {
    lookup!(\`rho:vault:system\`, *sysCh) |
    for (@(_, sys) <- sysCh) {
      @sys!("findOrCreate", ${JSON.stringify(from)}, *vaultCh) |
      @sys!("deployerAuthKey", *deployer, *authCh) |
      for (@(true, vault) <- vaultCh; auth <- authCh) {
        contract next(@remaining, @results) = {
          match remaining {
            [] => deployId!(results)
            [(address, amount) ...rest] => {
              new targetCh, resultCh in {
                @sys!("findOrCreate", address, *targetCh) |
                for (@(true, _) <- targetCh) {
                  @vault!("transfer", address, amount, *auth, *resultCh) |
                  for (@result <- resultCh) {
                    match result {
                      (true, _) => next!(rest, results.set(address, amount))
                      _ => deployId!({"error": result, "address": address})
                    }
                  }
                }
              }
            }
          }
        } |
        next!([${entries}], {})
      }
    }
  }`;
}

function balancesTerm(addresses) {
  return `new return, lookup(\`rho:registry:lookup\`), sysCh, next in {
    lookup!(\`rho:vault:system\`, *sysCh) |
    for (@(_, sys) <- sysCh) {
      contract next(@addresses, @balances) = {
        match addresses {
          [] => return!(balances)
          [address ...rest] => {
            new vaultCh, balanceCh in {
              @sys!("findOrCreate", address, *vaultCh) |
              for (@(true, vault) <- vaultCh) {
                @vault!("balance", *balanceCh) |
                for (@balance <- balanceCh) { next!(rest, balances.set(address, balance)) }
              }
            }
          }
        }
      } |
      next!(${JSON.stringify(addresses)}, {})
    }
  }`;
}

export async function fundAccounts(chain, funderKey, accounts, log, journal) {
  const status = await chain.request('/status');
  const from = vaultAddress(funderKey);
  const phloLimit = phloLimitForNode(100_000_000, chain.maxPhloLimit);
  // Preserve the original provisioning allowance of one million phlo per
  // recipient when a node's cap requires smaller funding transactions.
  const batchSize = Math.max(1, Math.min(100, Math.floor(phloLimit / 1_000_000)));
  for (let offset = 0; offset < accounts.length; offset += batchSize) {
    const requested = accounts.slice(offset, offset + batchSize);
    const block = await chain.finalizedBlock();
    const balances = {};
    for (let index = 0; index < requested.length; index += 10) {
      const [part] = await chain.explore(balancesTerm(requested.slice(index, index + 10).map(a => a.address)), block.blockHash);
      if (!part) throw new Error('Could not read account balances before funding');
      Object.assign(balances, part);
    }
    const batch = requested.map(({ address, amount }) => {
      if (balances[address] === undefined) throw new Error(`Balance missing: ${address}`);
      return { address, amount: Number(BigInt(amount) - BigInt(balances[address])) };
    }).filter(a => a.amount > 0);
    if (!batch.length) { log(`Already funded ${offset + requested.length}/${accounts.length} accounts`); continue; }
    const result = await chain.deploy(funderKey, fundingTerm(from, batch), {
      shardId: status.shardId, phloLimit, validAfterBlockNumber: (await chain.finalizedBlock()).blockNumber,
    });
    await appendFile(journal, JSON.stringify({ deployId: result.id, accounts: batch, result: result.data,
      cost: result.detail?.cost, phloLimit }) + '\n', { mode: 0o600 });
    if (result.data.length !== 1 || batch.some(({ address, amount }) => result.data[0]?.[address] !== amount)) {
      throw new Error(`Funding batch at ${offset} did not transfer every expected amount; inspect ${journal}`);
    }
    log(`Funded ${offset + requested.length}/${accounts.length} fresh accounts`);
  }
}
