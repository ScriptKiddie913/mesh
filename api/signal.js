const STREAM_TTL_SECONDS = 60 * 60 * 12;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function redisCommand(command) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`KV command failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function redisPipeline(commands) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("Missing KV_REST_API_URL or KV_REST_API_TOKEN");
  }

  const response = await fetch(`${baseUrl}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commands }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`KV pipeline failed: ${response.status} ${text}`);
  }

  return response.json();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const room = String(body?.room || "").trim();
      const from = String(body?.from || "").trim();
      const to = body?.to ? String(body.to).trim() : "";
      const kind = String(body?.kind || "").trim();
      const payload = body?.payload || null;

      if (!room || !from || !kind) {
        return json(res, 400, { ok: false, error: "room, from, kind are required" });
      }

      const streamKey = `signal:${room}`;
      const message = {
        room,
        from,
        to,
        kind,
        payload,
        ts: Date.now(),
      };

      const addResult = await redisCommand(["XADD", streamKey, "*", "json", JSON.stringify(message)]);
      await redisPipeline([
        ["EXPIRE", streamKey, String(STREAM_TTL_SECONDS)],
        ["XTRIM", streamKey, "MAXLEN", "~", "3000"],
      ]);

      return json(res, 200, { ok: true, id: addResult?.result || null });
    }

    if (req.method === "GET") {
      const room = String(req.query?.room || "").trim();
      const peer = String(req.query?.peer || "").trim();
      const since = String(req.query?.since || "0-0").trim();

      if (!room || !peer) {
        return json(res, 400, { ok: false, error: "room and peer are required" });
      }

      const streamKey = `signal:${room}`;
      const rangeResult = await redisCommand(["XRANGE", streamKey, `(${since}`, "+", "COUNT", "100"]);
      const rows = Array.isArray(rangeResult?.result) ? rangeResult.result : [];

      const events = [];
      let lastId = since;

      for (const row of rows) {
        const id = row?.[0];
        const kv = row?.[1] || [];
        let eventJson = "";

        for (let i = 0; i < kv.length; i += 2) {
          if (kv[i] === "json") {
            eventJson = kv[i + 1];
            break;
          }
        }

        if (!id || !eventJson) {
          continue;
        }

        let event;
        try {
          event = JSON.parse(eventJson);
        } catch {
          continue;
        }

        lastId = id;

        if (!event || event.from === peer) {
          continue;
        }

        if (event.to && event.to !== peer) {
          continue;
        }

        events.push({ id, ...event });
      }

      return json(res, 200, { ok: true, events, lastId });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "Unknown error" });
  }
};
