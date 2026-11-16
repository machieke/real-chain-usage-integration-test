import protobuf from 'protobufjs';
import { blake2b } from '@noble/hashes/blake2b';
import { secp256k1 } from '@noble/curves/secp256k1';
import { publicKey } from './chain.mjs';

// Same (deploy timestamp, public key, registry version) signature as rust-client's registry helper.
const Par = protobuf.parse(`syntax = "proto3";
  message Par { repeated Expr exprs = 5; }
  message Expr { oneof value { sint64 gInt = 2; ETuple tuple = 21; bytes publicKey = 25; } }
  message ETuple { repeated Par ps = 1; }
`).root.lookupType('Par');

export function renderBridge(template, key, timestamp) {
  const publicKeyHex = publicKey(key);
  const payload = { exprs: [{ tuple: { ps: [
    { exprs: [{ gInt: timestamp }] },
    { exprs: [{ publicKey: Buffer.from(publicKeyHex, 'hex') }] },
    { exprs: [{ gInt: timestamp }] },
  ] } }] };
  const digest = blake2b(Par.encode(Par.fromObject(payload)).finish(), { dkLen: 32 });
  const signature = secp256k1.sign(digest, key.replace(/^0x/, ''), { lowS: true }).toDERHex();
  for (const [placeholder, value] of [
    ['__ASI_REGISTRY_PUBLIC_KEY__', publicKeyHex], ['-9223372036854775807', String(timestamp)],
    ['__ASI_REGISTRY_SIGNATURE__', signature],
  ]) {
    if (template.split(placeholder).length !== 2) throw new Error(`Expected one bridge placeholder: ${placeholder}`);
    template = template.replace(placeholder, value);
  }
  return template;
}
