const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function sha256(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

async function deriveAesKey(rawKeyBytes) {
  return crypto.subtle.importKey("raw", rawKeyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function generateIdentity() {
  try {
    const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const signingPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey));

    const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const ecdhPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey));

    return {
      signAlgo: "Ed25519",
      signing,
      signingPublicRaw,
      ecdh,
      ecdhPublicRaw,
    };
  } catch {
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const signingPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey));

    const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const ecdhPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey));

    return {
      signAlgo: "ECDSA",
      signing,
      signingPublicRaw,
      ecdh,
      ecdhPublicRaw,
    };
  }
}

export async function exportIdentity(identity) {
  const signPrivateJwk = await crypto.subtle.exportKey("jwk", identity.signing.privateKey);
  const signPublicJwk = await crypto.subtle.exportKey("jwk", identity.signing.publicKey);
  const ecdhPrivateJwk = await crypto.subtle.exportKey("jwk", identity.ecdh.privateKey);
  const ecdhPublicJwk = await crypto.subtle.exportKey("jwk", identity.ecdh.publicKey);

  return {
    signAlgo: identity.signAlgo,
    signPrivateJwk,
    signPublicJwk,
    ecdhPrivateJwk,
    ecdhPublicJwk,
  };
}

export async function importIdentity(serialized) {
  const signAlgo = serialized.signAlgo === "Ed25519" ? "Ed25519" : "ECDSA";
  const signing = {
    privateKey: await crypto.subtle.importKey(
      "jwk",
      serialized.signPrivateJwk,
      signAlgo === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    ),
    publicKey: await crypto.subtle.importKey(
      "jwk",
      serialized.signPublicJwk,
      signAlgo === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    ),
  };

  const ecdh = {
    privateKey: await crypto.subtle.importKey(
      "jwk",
      serialized.ecdhPrivateJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    ),
    publicKey: await crypto.subtle.importKey(
      "jwk",
      serialized.ecdhPublicJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    ),
  };

  return {
    signAlgo,
    signing,
    signingPublicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey)),
    ecdh,
    ecdhPublicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey)),
  };
}

export function stablePeerId(publicKeyRaw) {
  return toBase64(publicKeyRaw).replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);
}

export async function signJson(identity, data) {
  const input = encoder.encode(JSON.stringify(data));
  let signature;

  if (identity.signAlgo === "Ed25519") {
    signature = await crypto.subtle.sign({ name: "Ed25519" }, identity.signing.privateKey, input);
  } else {
    signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.signing.privateKey,
      input
    );
  }

  return toBase64(new Uint8Array(signature));
}

export async function verifyJson(signAlgo, publicKeyRawB64, data, signatureB64) {
  try {
    const publicRaw = fromBase64(publicKeyRawB64);
    const input = encoder.encode(JSON.stringify(data));
    const signature = fromBase64(signatureB64);

    const key = await crypto.subtle.importKey(
      "raw",
      publicRaw,
      signAlgo === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    );

    if (signAlgo === "Ed25519") {
      return crypto.subtle.verify({ name: "Ed25519" }, key, signature, input);
    }

    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, input);
  } catch {
    return false;
  }
}

export async function deriveSharedSecret(localEcdhPrivateKey, remoteEcdhRawB64) {
  const remoteEcdhKey = await crypto.subtle.importKey(
    "raw",
    fromBase64(remoteEcdhRawB64),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: remoteEcdhKey },
    localEcdhPrivateKey,
    256
  );

  return new Uint8Array(bits);
}

export async function initChains(secretBytes, selfId, peerId) {
  const a = await sha256(encoder.encode("chain-A"));
  const b = await sha256(encoder.encode("chain-B"));
  const left = await hmacSha256(secretBytes, a);
  const right = await hmacSha256(secretBytes, b);

  if (selfId < peerId) {
    return { send: left, recv: right };
  }

  return { send: right, recv: left };
}

export async function nextMessageKey(chainKeyBytes) {
  const nextChain = await hmacSha256(chainKeyBytes, encoder.encode("next-chain"));
  const messageKey = await hmacSha256(chainKeyBytes, encoder.encode("msg-key"));
  return { nextChain, messageKey: messageKey.slice(0, 32) };
}

export async function encryptJsonWithKey(rawKeyBytes, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(rawKeyBytes);
  const encoded = encoder.encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    iv: toBase64(iv),
    cipher: toBase64(new Uint8Array(cipher)),
  };
}

export async function decryptJsonWithKey(rawKeyBytes, wrapped) {
  const key = await deriveAesKey(rawKeyBytes);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(wrapped.iv) },
    key,
    fromBase64(wrapped.cipher)
  );
  return JSON.parse(decoder.decode(new Uint8Array(plain)));
}

export function toB64(bytes) {
  return toBase64(bytes);
}

export function fromB64(base64) {
  return fromBase64(base64);
}
