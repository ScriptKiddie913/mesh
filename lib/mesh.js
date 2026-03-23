import {
  decryptJsonWithKey,
  deriveSharedSecret,
  encryptJsonWithKey,
  initChains,
  nextMessageKey,
  signJson,
  stablePeerId,
  toB64,
  verifyJson,
} from "./crypto.js";
import { saveMessage } from "./db.js";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function randomId() {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function clampTtl(ttl) {
  if (typeof ttl !== "number" || Number.isNaN(ttl)) {
    return 5;
  }
  return Math.max(0, Math.min(10, Math.floor(ttl)));
}

export class MeshNode {
  constructor({ identity, room, signalBase = "/api/signal", callbacks = {} }) {
    this.identity = identity;
    this.room = room;
    this.signalBase = signalBase;

    this.peerId = stablePeerId(identity.signingPublicRaw);
    this.peers = new Map();
    this.routes = new Map();
    this.seen = new Set();

    this.lastSignalId = "0-0";
    this.pollTimer = null;
    this.announceTimer = null;
    this.localBus = null;

    this.callbacks = {
      log: callbacks.log || (() => {}),
      peers: callbacks.peers || (() => {}),
      message: callbacks.message || (() => {}),
      status: callbacks.status || (() => {}),
    };
  }

  async start() {
    this.callbacks.status(`Online as ${this.peerId}`);
    this.callbacks.log("Mesh node starting...");

    if ("BroadcastChannel" in window) {
      this.localBus = new BroadcastChannel("mesh-local-discovery");
      this.localBus.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === "announce" && data.from !== this.peerId) {
          this.maybeConnectToPeer(data.from);
        }
      };
      this.localBus.postMessage({ type: "announce", from: this.peerId, room: this.room });
    }

    await this.signalSend("announce", {
      signAlgo: this.identity.signAlgo,
      signPub: toB64(this.identity.signingPublicRaw),
      ecdhPub: toB64(this.identity.ecdhPublicRaw),
    });

    await this.pollSignals();
    this.pollTimer = setInterval(() => {
      this.pollSignals().catch((error) => this.callbacks.log(`Signal poll failed: ${error.message}`));
    }, 1200);

    this.announceTimer = setInterval(() => {
      this.signalSend("announce", {
        signAlgo: this.identity.signAlgo,
        signPub: toB64(this.identity.signingPublicRaw),
        ecdhPub: toB64(this.identity.ecdhPublicRaw),
      }).catch((error) => this.callbacks.log(`Announce failed: ${error.message}`));
    }, 5000);
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.announceTimer);

    if (this.localBus) {
      this.localBus.close();
      this.localBus = null;
    }

    for (const state of this.peers.values()) {
      try {
        state.dc?.close();
      } catch {
        // no-op
      }
      try {
        state.pc?.close();
      } catch {
        // no-op
      }
    }

    this.peers.clear();
    this.callbacks.peers([]);
  }

  async signalSend(kind, payload, to = "") {
    await fetch(this.signalBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: this.room,
        from: this.peerId,
        to,
        kind,
        payload,
      }),
    });
  }

  async pollSignals() {
    const url = `${this.signalBase}?room=${encodeURIComponent(this.room)}&peer=${encodeURIComponent(this.peerId)}&since=${encodeURIComponent(this.lastSignalId)}`;
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Signal endpoint returned ${response.status}`);
    }

    const data = await response.json();
    if (!data?.ok) {
      throw new Error(data?.error || "Signal endpoint error");
    }

    this.lastSignalId = data.lastId || this.lastSignalId;

    for (const event of data.events || []) {
      await this.handleSignalEvent(event);
    }
  }

  async handleSignalEvent(event) {
    const from = event.from;
    const kind = event.kind;
    const payload = event.payload || {};

    if (!from || from === this.peerId) {
      return;
    }

    if (kind === "announce") {
      this.maybeConnectToPeer(from);
      return;
    }

    if (kind === "offer") {
      await this.acceptOffer(from, payload);
      return;
    }

    if (kind === "answer") {
      const state = this.peers.get(from);
      if (state && payload?.sdp) {
        await state.pc.setRemoteDescription(payload.sdp);
      }
      return;
    }

    if (kind === "ice") {
      const state = this.peers.get(from);
      if (state && payload?.candidate) {
        await state.pc.addIceCandidate(payload.candidate).catch(() => {});
      }
    }
  }

  maybeConnectToPeer(targetPeerId) {
    if (!targetPeerId || targetPeerId === this.peerId) {
      return;
    }

    if (this.peers.has(targetPeerId)) {
      return;
    }

    // Simple glare avoidance: lexicographically larger id initiates.
    if (this.peerId > targetPeerId) {
      this.createOffer(targetPeerId).catch((error) => this.callbacks.log(`Offer error for ${targetPeerId}: ${error.message}`));
    }
  }

  createPeerState(peerId, pc, dc = null) {
    const state = {
      peerId,
      pc,
      dc,
      connected: false,
      handshakeDone: false,
      signAlgo: "",
      signPub: "",
      ecdhPub: "",
      chains: null,
      localPathHints: new Set(),
    };

    this.peers.set(peerId, state);
    this.publishPeerList();

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalSend("ice", { candidate: event.candidate }, peerId).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        this.callbacks.log(`Connection closed: ${peerId}`);
        this.peers.delete(peerId);
        this.publishPeerList();
      }
    };

    return state;
  }

  wireDataChannel(state, channel) {
    state.dc = channel;

    channel.onopen = () => {
      state.connected = true;
      this.callbacks.log(`Data channel open with ${state.peerId}`);
      this.publishPeerList();
      this.sendHello(state.peerId).catch((error) => this.callbacks.log(`HELLO send failed: ${error.message}`));
    };

    channel.onclose = () => {
      state.connected = false;
      this.publishPeerList();
    };

    channel.onerror = () => {
      this.callbacks.log(`Channel error with ${state.peerId}`);
    };

    channel.onmessage = (event) => {
      this.handleWirePacket(state.peerId, event.data).catch((error) => {
        this.callbacks.log(`Wire parse failure (${state.peerId}): ${error.message}`);
      });
    };
  }

  async createOffer(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel("mesh", { ordered: true });

    const state = this.createPeerState(peerId, pc, dc);
    this.wireDataChannel(state, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.signalSend("offer", { sdp: pc.localDescription }, peerId);
  }

  async acceptOffer(peerId, payload) {
    const existing = this.peers.get(peerId);
    if (existing) {
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const state = this.createPeerState(peerId, pc);

    pc.ondatachannel = (event) => {
      this.wireDataChannel(state, event.channel);
    };

    await pc.setRemoteDescription(payload.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await this.signalSend("answer", { sdp: pc.localDescription }, peerId);
  }

  publishPeerList() {
    const peers = Array.from(this.peers.values()).map((p) => ({
      id: p.peerId,
      connected: p.connected,
      secure: Boolean(p.handshakeDone && p.chains),
    }));

    this.callbacks.peers(peers);
  }

  async sendHello(peerId) {
    const state = this.peers.get(peerId);
    if (!state?.dc || state.dc.readyState !== "open") {
      return;
    }

    const helloBody = {
      peerId: this.peerId,
      signAlgo: this.identity.signAlgo,
      signPub: toB64(this.identity.signingPublicRaw),
      ecdhPub: toB64(this.identity.ecdhPublicRaw),
      ts: Date.now(),
    };

    const sig = await signJson(this.identity, helloBody);

    state.dc.send(
      JSON.stringify({
        type: "hello",
        body: helloBody,
        sig,
      })
    );
  }

  async handleWirePacket(fromPeerId, rawData) {
    const state = this.peers.get(fromPeerId);
    if (!state) {
      return;
    }

    let packet;
    try {
      packet = JSON.parse(rawData);
    } catch {
      return;
    }

    if (packet.type === "hello") {
      const body = packet.body || {};
      const valid = await verifyJson(body.signAlgo, body.signPub, body, packet.sig || "");
      if (!valid) {
        this.callbacks.log(`Rejected invalid HELLO from ${fromPeerId}`);
        return;
      }

      state.signAlgo = body.signAlgo;
      state.signPub = body.signPub;
      state.ecdhPub = body.ecdhPub;

      const secret = await deriveSharedSecret(this.identity.ecdh.privateKey, body.ecdhPub);
      state.chains = await initChains(secret, this.peerId, fromPeerId);
      state.handshakeDone = true;
      this.publishPeerList();
      return;
    }

    if (packet.type !== "secure") {
      return;
    }

    if (!state.chains) {
      return;
    }

    const step = await nextMessageKey(state.chains.recv);
    state.chains.recv = step.nextChain;

    let envelope;
    try {
      envelope = await decryptJsonWithKey(step.messageKey, packet.data);
    } catch {
      this.callbacks.log(`Decrypt failed from ${fromPeerId}`);
      return;
    }

    await this.handleEnvelope(fromPeerId, envelope);
  }

  async handleEnvelope(fromPeerId, envelope) {
    if (!envelope?.id || this.seen.has(envelope.id)) {
      return;
    }

    this.seen.add(envelope.id);
    if (this.seen.size > 5000) {
      this.seen.clear();
      this.seen.add(envelope.id);
    }

    if (envelope.src && envelope.dst && fromPeerId) {
      this.routes.set(envelope.src, fromPeerId);
    }

    if (envelope.kind === "chat" && envelope.dst === this.peerId) {
      const message = {
        id: envelope.id,
        ts: envelope.ts || Date.now(),
        src: envelope.src,
        dst: envelope.dst,
        text: envelope.payload?.text || "",
        route: envelope.route || [],
      };
      await saveMessage(message);
      this.callbacks.message(message);
      return;
    }

    if (envelope.kind === "broadcast" && envelope.src !== this.peerId) {
      const message = {
        id: envelope.id,
        ts: envelope.ts || Date.now(),
        src: envelope.src,
        dst: "*",
        text: envelope.payload?.text || "",
        route: envelope.route || [],
      };
      await saveMessage(message);
      this.callbacks.message(message);
    }

    if (envelope.ttl <= 0) {
      return;
    }

    const nextEnvelope = { ...envelope, ttl: envelope.ttl - 1 };

    if (nextEnvelope.dst && nextEnvelope.dst !== "*" && nextEnvelope.dst !== this.peerId) {
      const nextHop = nextEnvelope.onion?.nextHop || this.routes.get(nextEnvelope.dst) || "";
      if (nextHop) {
        await this.secureSend(nextHop, {
          ...nextEnvelope,
          route: [...(nextEnvelope.route || []), this.peerId],
        });
      } else {
        await this.forwardFlood(nextEnvelope, fromPeerId);
      }
      return;
    }

    if (nextEnvelope.dst === "*") {
      await this.forwardFlood(nextEnvelope, fromPeerId);
    }
  }

  async secureSend(peerId, envelope) {
    const state = this.peers.get(peerId);
    if (!state?.connected || !state?.chains || !state?.dc || state.dc.readyState !== "open") {
      return;
    }

    const step = await nextMessageKey(state.chains.send);
    state.chains.send = step.nextChain;

    const wrapped = await encryptJsonWithKey(step.messageKey, envelope);

    state.dc.send(
      JSON.stringify({
        type: "secure",
        data: wrapped,
      })
    );
  }

  async forwardFlood(envelope, exceptPeerId = "") {
    const peers = Array.from(this.peers.values()).filter(
      (state) => state.connected && state.handshakeDone && state.peerId !== exceptPeerId
    );

    for (const state of peers) {
      await this.secureSend(state.peerId, {
        ...envelope,
        route: [...(envelope.route || []), this.peerId],
      });
    }
  }

  pickOnionNextHop(dst) {
    const connected = Array.from(this.peers.values())
      .filter((p) => p.connected && p.handshakeDone)
      .map((p) => p.peerId);

    if (connected.length === 0) {
      return "";
    }

    if (connected.includes(dst)) {
      return dst;
    }

    const randomPeer = connected[Math.floor(Math.random() * connected.length)];
    return randomPeer || "";
  }

  async sendChat(text, dst, ttl = 5, useOnion = true) {
    const content = String(text || "").trim();
    if (!content) {
      return;
    }

    const target = String(dst || "").trim() || "*";
    const messageId = randomId();

    const envelope = {
      id: messageId,
      src: this.peerId,
      dst: target,
      kind: target === "*" ? "broadcast" : "chat",
      payload: { text: content },
      ttl: clampTtl(ttl),
      ts: Date.now(),
      route: [this.peerId],
      onion: useOnion && target !== "*" ? { nextHop: this.pickOnionNextHop(target) } : null,
    };

    await saveMessage({
      id: messageId,
      ts: envelope.ts,
      src: this.peerId,
      dst: target,
      text: content,
      route: envelope.route,
      local: true,
    });

    if (target === "*") {
      await this.forwardFlood(envelope);
      return;
    }

    const nextHop = envelope.onion?.nextHop || this.routes.get(target) || target;
    if (!nextHop) {
      this.callbacks.log(`No route to ${target} yet. Waiting for discovery.`);
      return;
    }

    await this.secureSend(nextHop, envelope);
  }

  getPeerId() {
    return this.peerId;
  }

  getPeers() {
    return Array.from(this.peers.values()).map((state) => ({
      id: state.peerId,
      connected: state.connected,
      secure: Boolean(state.handshakeDone && state.chains),
    }));
  }
}
