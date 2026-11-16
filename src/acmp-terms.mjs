import { bridgeCall, uri } from './terms.mjs';
import { vaultAddress } from './chain.mjs';

export function rhoBytes(hex) {
  if (!/^(?:0x)?(?:[a-f0-9]{2})+$/i.test(hex)) throw new Error('Invalid byte string');
  return `${JSON.stringify(hex.replace(/^0x/, ''))}.hexToBytes()`;
}
export function trustEndpoint(endpoint, chain, id) {
  return bridgeCall(endpoint, `bridge!("set", ("trustedEndpoint", ${chain}, ${rhoBytes(id)}), *owner, *ret) |
    for (@result <- ret) { deployId!(result) }`,
  ', owner(`rho:system:deployerId`), deployId(`rho:system:deployId`), ret');
}

// Each private sendKey stays inside its registered application. Only the named
// user's system deployer capability can send. No capability is returned publicly.
export function registerSenders(endpoint, keys, destinations, chain) {
  return bridgeCall(endpoint, keys.map((key, user) => `new sender, registered, saved, uriCh,
      insert(\`rho:registry:insertArbitrary\`), address(\`rho:vault:address\`) in {
    bridge!("registerSender", Nil, Nil, *registered) |
    for (@registration <- registered) {
      if (registration.get("status") == "ok") {
        saved!((registration.get("sourceAppId"), registration.get("sendKey"))) |
        insert!(bundle+{*sender}, *uriCh) |
        for (@senderUri <- uriCh) { deployId!({"user": ${user}, "uri": senderUri,
          "sourceAppId": registration.get("sourceAppId").bytesToHex()}) }
      } else { deployId!(registration) }
    } |
    contract sender(@payload, @caller, @sourceDeploy, ret) = {
      new addressCh in {
        address!("fromDeployerId", caller, *addressCh) |
        for (@callerAddress <- addressCh) {
          if (callerAddress == ${JSON.stringify(vaultAddress(key))}) {
            for (@(app, sendKey) <<- saved) { new sentCh, tagCh in {
              bridge!("send", (app, ${chain}, ${rhoBytes(destinations[user])}, payload), sendKey, *sentCh) |
              for (@sent <- sentCh) {
                if (sent.get("status") == "ok") {
                  bridge!("setSourceDeploy", (app, sent.get("recordNonce"), sourceDeploy), sendKey, *tagCh) |
                  for (@tag <- tagCh) { if (tag.get("status") == "ok") { ret!(sent) } else { ret!(tag) } }
                } else { ret!(sent) }
              }
            } }
          } else { ret!({"status": "error", "error": "Unauthorized"}) }
        }
      }
    }
  }`).join(' | '), ', deployId(`rho:system:deployId`)');
}
export function messageTerm(sender, payload) {
  return `new lookup(\`rho:registry:lookup\`), ch, ret, caller(\`rho:system:deployerId\`),
    deployId(\`rho:system:deployId\`) in {
    lookup!(${uri(sender)}, *ch) | for (app <- ch) {
      app!(${rhoBytes(payload)}, *caller, (*deployId).toString().hexToBytes(), *ret) |
      for (@result <- ret) { deployId!(result) }
    }
  }`;
}
export const packetFields = {
  version: 'packetVersion', sourceChainId: 'packetSourceChain', sourceEndpointId: 'packetSourceEndpoint',
  sourceAppId: 'packetSourceApp', destinationChainId: 'packetDestChain', destinationEndpointId: 'packetDestEndpoint',
  destinationAppId: 'packetDestApp', channelNonce: 'packetChannelNonce', guid: 'packetGuid',
  payloadHash: 'packetPayloadHash', payload: 'packetPayload', sourceDeploy: 'packetSourceDeploy',
};
export function packetQuery(endpoint, nonce) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid record nonce');
  const fields = Object.entries(packetFields);
  return `new return in { ${bridgeCall(endpoint, `
    ${fields.map(([, method], i) => `bridge!("get", ("${method}", ${nonce}), Nil, *q${i})`).join(' | ')} |
    for (${fields.map((_, i) => `@v${i} <- q${i}`).join('; ')}) {
      return!({${fields.map(([field], i) => `"${field}": v${i}`).join(', ')}})
    }`, ', ' + fields.map((_, i) => `q${i}`).join(', '))} }`;
}

// A bounded batch uses one observer execution slot and one finalized snapshot.
export function packetBatchQuery(endpoint, nonces) {
  if (!nonces.length || nonces.length > 10 || nonces.some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error('Expected 1–10 packet record nonces');
  }
  const fields = Object.entries(packetFields);
  return `new return in { ${bridgeCall(endpoint, `
    contract next(@remaining, @records) = {
      match remaining {
        [] => return!(records)
        [nonce ...rest] => { new ${fields.map((_, i) => `q${i}`).join(', ')} in {
          ${fields.map(([, method], i) => `bridge!("get", ("${method}", nonce), Nil, *q${i})`).join(' | ')} |
          for (${fields.map((_, i) => `@v${i} <- q${i}`).join('; ')}) {
            next!(rest, records.set(nonce, {${fields.map(([field], i) => `"${field}": v${i}`).join(', ')}}))
          }
        } }
      }
    } | next!(${JSON.stringify(nonces)}, {})`, ', next')} }`;
}
