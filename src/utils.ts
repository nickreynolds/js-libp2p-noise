import { x25519, ed25519, HKDF, SHA256 } from 'bcrypto';
import protobuf from "protobufjs";
import { Buffer } from "buffer";
import PeerId from "peer-id";
import * as crypto from 'libp2p-crypto';

import { KeyPair } from "./@types/libp2p";
import {bytes, bytes32} from "./@types/basic";
import {Hkdf} from "./@types/handshake";

export async function loadPayloadProto () {
  const payloadProtoBuf = await protobuf.load("protos/payload.proto");
  return payloadProtoBuf.lookupType("pb.NoiseHandshakePayload");
}

export function generateKeypair(): KeyPair {
  const privateKey = x25519.privateKeyGenerate();
  const publicKey = x25519.publicKeyCreate(privateKey);

  return {
    publicKey,
    privateKey,
  }
}

export async function getPayload(
  localPeer: PeerId,
  staticPublicKey: bytes,
  earlyData?: bytes,
): Promise<bytes> {
  const signedPayload = await signPayload(localPeer, getHandshakePayload(staticPublicKey));
  const signedEarlyDataPayload = await signEarlyDataPayload(localPeer, earlyData || Buffer.alloc(0));

  return await createHandshakePayload(
    localPeer.marshalPubKey(),
    localPeer.marshalPrivKey(),
    signedPayload,
    signedEarlyDataPayload
  );
}

export async function createHandshakePayload(
  libp2pPublicKey: bytes,
  libp2pPrivateKey: bytes,
  signedPayload: bytes,
  signedEarlyData?: EarlyDataPayload,
): Promise<bytes> {
  const NoiseHandshakePayload = await loadPayloadProto();
  const earlyDataPayload = signedEarlyData ?
    {
      libp2pData: signedEarlyData.libp2pData,
      libp2pDataSignature: signedEarlyData.libp2pDataSignature,
    } : {};

  const payloadInit = NoiseHandshakePayload.create({
    libp2pKey: libp2pPublicKey,
    noiseStaticKeySignature: signedPayload,
    ...earlyDataPayload,
  });

  return Buffer.from(NoiseHandshakePayload.encode(payloadInit).finish());
}


export async function signPayload(peerId: PeerId, payload: bytes): Promise<bytes> {
  return peerId.privKey.sign(payload);
}

type EarlyDataPayload = {
  libp2pData: bytes;
  libp2pDataSignature: bytes;
}

export async function signEarlyDataPayload(peerId: PeerId, earlyData: bytes): Promise<EarlyDataPayload> {
  const payload = getEarlyDataPayload(earlyData);
  const signedPayload = await signPayload(peerId, payload);

  return {
    libp2pData: payload,
    libp2pDataSignature: signedPayload,
  }
}

export const getHandshakePayload = (publicKey: bytes ) => Buffer.concat([Buffer.from("noise-libp2p-static-key:"), publicKey]);

export const getEarlyDataPayload = (earlyData: bytes) => Buffer.concat([Buffer.from("noise-libp2p-early-data:"), earlyData]);

async function isValidPeerId(peerId: bytes, publicKeyProtobuf: bytes) {
  const generatedPeerId = await PeerId.createFromPubKey(publicKeyProtobuf);
  return generatedPeerId.id.equals(peerId);
}

export async function verifySignedPayload(noiseStaticKey: bytes, plaintext: bytes, peerId: bytes) {
  const NoiseHandshakePayload = await loadPayloadProto();
  const receivedPayload = NoiseHandshakePayload.toObject(NoiseHandshakePayload.decode(plaintext));

  if (!(await isValidPeerId(peerId, receivedPayload.libp2pKey)) ) {
    throw new Error("Peer ID doesn't match libp2p public key.");
  }

  const generatedPayload = getHandshakePayload(noiseStaticKey);
  // Unmarshaling from PublicKey protobuf and taking key buffer only.
  const publicKey = crypto.keys.unmarshalPublicKey(receivedPayload.libp2pKey);
  if (!publicKey.verify(generatedPayload, receivedPayload.noiseStaticKeySignature)) {
    throw new Error("Static key doesn't match to peer that signed payload!");
  }
}

export function getHkdf(ck: bytes32, ikm: bytes): Hkdf {
  const info = Buffer.alloc(0);
  const prk = HKDF.extract(SHA256, ikm, ck);
  const okm = HKDF.expand(SHA256, prk, info, 96);

  const k1 = okm.slice(0, 32);
  const k2 = okm.slice(32, 64);
  const k3 = okm.slice(64, 96);

  return [ k1, k2, k3 ];
}

export function isValidPublicKey(pk: bytes): boolean {
  return x25519.publicKeyVerify(pk);
}
