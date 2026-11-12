const quote = value => JSON.stringify(value);
export function uri(value) {
  if (!/^rho:id:[a-z0-9]+$/.test(value)) throw new Error('Invalid registry URI');
  return `\`${value}\``;
}
export function voteTerm(ballot, choice) {
  return `new deployId(\`rho:system:deployId\`), voter(\`rho:system:deployerId\`),
    lookup(\`rho:registry:lookup\`), ch, ret in {
    lookup!(${uri(ballot)}, *ch) |
    for (ballot <- ch) {
      ballot!("vote", *voter, ${quote(choice)}, *ret) |
      for (@result <- ret) { deployId!(result) }
    }
  }`;
}
export function snapshotTerm(ballot) {
  return `new return, ch, lookup(\`rho:registry:lookup\`) in {
    lookup!(${uri(ballot)}, *ch) |
    for (ballot <- ch) { ballot!("snapshot", Nil, "", *return) }
  }`;
}
export function bridgeCall(bridge, body, declarations = '') {
  return `new lookup(\`rho:registry:lookup\`), entryCh, bridgeCh ${declarations} in {
    lookup!(${uri(bridge)}, *entryCh) |
    for (entry <- entryCh) {
      match *entry { (_, bridge) => bridgeCh!(bridge) _ => bridgeCh!(*entry) }
    } |
    for (bridge <- bridgeCh) { ${body} }
  }`;
}
export function lockTerm(bridge, amount, recipient, destinationChainId) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(destinationChainId)) {
    throw new Error('Invalid lock amount or destination chain ID');
  }
  return bridgeCall(bridge, `
    lookup!(\`rho:vault:system\`, *systemCh) |
    for (@(_, SystemVault) <- systemCh) {
      VaultAddress!("fromDeployerId", *deployerId, *addressCh) |
      @SystemVault!("deployerAuthKey", *deployerId, *authCh) |
      for (@address <- addressCh; auth <- authCh) {
        bridge!("lock", (address, ${amount}, ${quote(recipient)}, ${destinationChainId}), *auth, *ret) |
        for (@result <- ret) { deployId!(result) }
      }
    }`, `, deployId(\`rho:system:deployId\`), deployerId(\`rho:system:deployerId\`),
       VaultAddress(\`rho:vault:address\`), systemCh, addressCh, authCh, ret`);
}
export function bridgeQuery(bridge, method, param) {
  const args = param === undefined ? quote(method) : `(${quote(method)}, ${param})`;
  return `new return in { ${bridgeCall(bridge, `bridge!("get", ${args}, Nil, *return)`)} }`;
}
export function allowDestination(bridge, chainId) {
  return bridgeCall(bridge, `
    VaultAddress!("fromDeployerId", *deployerId, *addressCh) |
    for (@address <- addressCh) {
      bridge!("set", ("allowDestination", address, ${chainId}), Nil, *ret) |
      for (@result <- ret) { deployId!(result) }
    }`, `, deployId(\`rho:system:deployId\`), deployerId(\`rho:system:deployerId\`),
        VaultAddress(\`rho:vault:address\`), addressCh, ret`);
}
