import { connectBluetooth } from "./lib/bluetooth.js";
import { exportIdentity, generateIdentity, importIdentity, stablePeerId } from "./lib/crypto.js";
import { kvGet, kvSet, loadRecentMessages } from "./lib/db.js";
import { MeshNode } from "./lib/mesh.js";

const ui = {
  room: document.querySelector("#room"),
  join: document.querySelector("#join"),
  status: document.querySelector("#status"),
  me: document.querySelector("#me"),
  peers: document.querySelector("#peers"),
  log: document.querySelector("#log"),
  messages: document.querySelector("#messages"),
  target: document.querySelector("#target"),
  ttl: document.querySelector("#ttl"),
  onion: document.querySelector("#onion"),
  input: document.querySelector("#messageText"),
  send: document.querySelector("#send"),
  bluetooth: document.querySelector("#bluetooth"),
  qr: document.querySelector("#qr"),
};

let mesh = null;
let identity = null;

function logLine(text) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  ui.log.prepend(line);
}

function setStatus(text) {
  ui.status.textContent = text;
}

function renderPeerList(peers) {
  ui.peers.textContent = "";

  if (!peers.length) {
    const li = document.createElement("li");
    li.textContent = "No peers connected";
    ui.peers.append(li);
    return;
  }

  for (const peer of peers) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${peer.id}</span><small>${peer.connected ? "connected" : "connecting"} / ${peer.secure ? "secure" : "handshake"}</small>`;
    ui.peers.append(li);
  }
}

function addMessage(msg) {
  const row = document.createElement("article");
  row.className = `message ${msg.local ? "mine" : "other"}`;
  const route = Array.isArray(msg.route) ? msg.route.join(" -> ") : "";

  row.innerHTML = `
    <header>
      <strong>${msg.src || "unknown"}</strong>
      <small>${new Date(msg.ts || Date.now()).toLocaleTimeString()}</small>
    </header>
    <p>${msg.text || ""}</p>
    <footer>${msg.dst === "*" ? "broadcast" : `to ${msg.dst}`} ${route ? ` | route: ${route}` : ""}</footer>
  `;

  ui.messages.append(row);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

async function loadIdentity() {
  const serialized = await kvGet("identity");
  if (serialized) {
    return importIdentity(serialized);
  }

  const fresh = await generateIdentity();
  await kvSet("identity", await exportIdentity(fresh));
  return fresh;
}

function renderQr(room, peerId) {
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  url.searchParams.set("peer", peerId);
  const data = encodeURIComponent(url.toString());
  ui.qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${data}`;
}

async function bootstrap() {
  identity = await loadIdentity();
  const me = stablePeerId(identity.signingPublicRaw);
  ui.me.textContent = me;

  const history = await loadRecentMessages(80);
  for (const msg of history) {
    addMessage(msg);
  }

  const roomFromQuery = new URLSearchParams(location.search).get("room") || "mesh-room";
  ui.room.value = roomFromQuery;
  renderQr(roomFromQuery, me);

  ui.join.addEventListener("click", async () => {
    const room = ui.room.value.trim() || "mesh-room";

    if (mesh) {
      mesh.stop();
      mesh = null;
    }

    mesh = new MeshNode({
      identity,
      room,
      callbacks: {
        log: logLine,
        peers: renderPeerList,
        message: (msg) => addMessage(msg),
        status: setStatus,
      },
    });

    try {
      await mesh.start();
      setStatus(`Connected to room ${room}`);
      renderQr(room, mesh.getPeerId());
    } catch (error) {
      logLine(`Start failed: ${error.message}`);
      setStatus("Failed to start mesh node");
    }
  });

  ui.send.addEventListener("click", async () => {
    if (!mesh) {
      logLine("Join a room first");
      return;
    }

    const text = ui.input.value.trim();
    if (!text) {
      return;
    }

    const target = ui.target.value.trim() || "*";
    const ttl = Number(ui.ttl.value);
    const onion = ui.onion.checked;

    await mesh.sendChat(text, target, ttl, onion);
    addMessage({
      id: crypto.randomUUID(),
      ts: Date.now(),
      src: mesh.getPeerId(),
      dst: target,
      text,
      local: true,
      route: [mesh.getPeerId()],
    });

    ui.input.value = "";
  });

  ui.bluetooth.addEventListener("click", async () => {
    try {
      await connectBluetooth(logLine);
    } catch (error) {
      logLine(`Bluetooth failed: ${error.message}`);
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      logLine(`Service worker registration failed: ${error.message}`);
    });
  }
}

bootstrap().catch((error) => {
  logLine(`Bootstrap failed: ${error.message}`);
});
