const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const QUERY_TIMEOUT_MS = 4000;

const publicDir = path.join(__dirname, 'public');

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath, contentType = 'text/html; charset=utf-8') {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function readNullTerminatedString(buffer, offset) {
  const end = buffer.indexOf(0x00, offset);
  if (end === -1) {
    return { value: '', nextOffset: buffer.length };
  }
  return {
    value: buffer.toString('utf8', offset, end),
    nextOffset: end + 1
  };
}

function parseAddress(address) {
  const [host, portRaw] = address.split(':');
  return {
    host,
    port: Number(portRaw)
  };
}

function sendUdpMessage(host, port, message) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('UDP query timed out'));
    }, QUERY_TIMEOUT_MS);

    socket.once('error', (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });

    socket.once('message', (buffer) => {
      clearTimeout(timeout);
      socket.close();
      resolve(buffer);
    });

    socket.send(message, port, host, (error) => {
      if (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    });
  });
}

async function queryA2SInfo(host, port, challenge = null) {
  const basePayload = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
    Buffer.from('Source Engine Query\0', 'ascii')
  ]);
  const payload = challenge === null
    ? basePayload
    : Buffer.concat([basePayload, challenge]);

  const buffer = await sendUdpMessage(host, port, payload);
  if (buffer.readInt32LE(0) !== -1) {
    throw new Error('Unexpected A2S_INFO header');
  }

  if (buffer[4] === 0x41) {
    const nextChallenge = buffer.subarray(5, 9);
    return queryA2SInfo(host, port, nextChallenge);
  }

  if (buffer[4] !== 0x49) {
    throw new Error('Unexpected A2S_INFO response');
  }

  let offset = 6;
  const name = readNullTerminatedString(buffer, offset);
  offset = name.nextOffset;
  const map = readNullTerminatedString(buffer, offset);
  offset = map.nextOffset;
  const folder = readNullTerminatedString(buffer, offset);
  offset = folder.nextOffset;
  const game = readNullTerminatedString(buffer, offset);
  offset = game.nextOffset;

  const appId = buffer.readUInt16LE(offset);
  offset += 2;
  const players = buffer.readUInt8(offset++);
  const maxPlayers = buffer.readUInt8(offset++);
  const bots = buffer.readUInt8(offset++);
  const serverType = String.fromCharCode(buffer.readUInt8(offset++));
  const environment = String.fromCharCode(buffer.readUInt8(offset++));
  const visibility = buffer.readUInt8(offset++);
  const vac = buffer.readUInt8(offset++);
  const version = readNullTerminatedString(buffer, offset);

  return {
    name: name.value,
    map: map.value,
    folder: folder.value,
    game: game.value,
    appId,
    players,
    maxPlayers,
    bots,
    serverType,
    environment,
    visibility,
    vac,
    version: version.value
  };
}

async function queryA2SPlayers(host, port, challenge = -1) {
  const payload = Buffer.alloc(9);
  payload.writeInt32LE(-1, 0);
  payload.writeUInt8(0x55, 4);
  payload.writeInt32LE(challenge, 5);

  const buffer = await sendUdpMessage(host, port, payload);
  const header = buffer.readInt32LE(0);
  const type = buffer.readUInt8(4);

  if (header !== -1) {
    throw new Error('Unexpected A2S_PLAYER header');
  }

  if (type === 0x41) {
    const nextChallenge = buffer.readInt32LE(5);
    return queryA2SPlayers(host, port, nextChallenge);
  }

  if (type !== 0x44) {
    throw new Error('Unexpected A2S_PLAYER response');
  }

  let offset = 5;
  const count = buffer.readUInt8(offset++);
  const players = [];

  for (let i = 0; i < count && offset < buffer.length; i += 1) {
    offset += 1;
    const name = readNullTerminatedString(buffer, offset);
    offset = name.nextOffset;

    if (offset + 8 > buffer.length) {
      break;
    }

    const score = buffer.readInt32LE(offset);
    offset += 4;
    const durationSeconds = buffer.readFloatLE(offset);
    offset += 4;

    players.push({
      name: name.value || '(unnamed player)',
      score,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0
    });
  }

  return players;
}

async function queryServerDirect(address) {
  const { host, port } = parseAddress(address);

  try {
    const [info, players] = await Promise.all([
      queryA2SInfo(host, port),
      queryA2SPlayers(host, port).catch(() => [])
    ]);

    return {
      ok: true,
      source: 'direct-a2s',
      info,
      players
    };
  } catch (error) {
    return {
      ok: false,
      source: 'direct-a2s',
      error: error.message,
      players: []
    };
  }
}

function discoverSingaporeServers(servers) {
  return servers
    .filter((server) => {
      const countryCode = server?.country?.code;
      const regionCode = server?.region?.code;
      const name = String(server?.name || '').toLowerCase();
      const provider = String(server?.provider || '').toLowerCase();
      const tags = Array.isArray(server?.tags) ? server.tags.map((tag) => String(tag).toLowerCase()) : [];
      const isSingapore = countryCode === 'SG' || name.includes('[sg]') || name.includes('singapore') || provider.includes('singapore');
      const isAsia = regionCode === 'AS' || countryCode === 'SG';
      const isCs2 = server?.version_type === 'cs2' || tags.includes('cs2');
      return isSingapore && isAsia && isCs2 && server?.address;
    })
    .sort((a, b) => {
      const aPlayers = Array.isArray(a.players) ? a.players[0] || 0 : 0;
      const bPlayers = Array.isArray(b.players) ? b.players[0] || 0 : 0;
      if (bPlayers !== aPlayers) {
        return bPlayers - aPlayers;
      }
      return String(a.address).localeCompare(String(b.address));
    });
}

async function fetchServers() {
  const response = await fetch('https://hvh.wtf/api/servers', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HVH-SG-Tracker/1.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`Upstream returned ${response.status}`);
  }

  const servers = await response.json();
  const singaporeServers = discoverSingaporeServers(servers);
  const targetAddresses = singaporeServers.map((server) => server.address);
  const directResults = await Promise.all(targetAddresses.map((address) => queryServerDirect(address)));

  const filtered = targetAddresses.map((address, index) => {
    const server = singaporeServers.find((entry) => entry.address === address);
    const direct = directResults[index];

    if (!server && !direct.ok) {
      return {
        address,
        found: false,
        online: false,
        playersNow: null,
        maxPlayers: null,
        map: null,
        name: 'Unknown server',
        livePlayerNames: [],
        liveDataSource: 'unavailable',
        liveQueryOk: false,
        liveQueryError: direct.error || 'No data available'
      };
    }

    const [feedPlayersNow, feedMaxPlayers] = server && Array.isArray(server.players)
      ? server.players
      : [null, null];

    const playersNow = direct.ok ? direct.info.players : feedPlayersNow;
    const maxPlayers = direct.ok ? direct.info.maxPlayers : feedMaxPlayers;
    const map = direct.ok ? direct.info.map : (server?.map || null);
    const name = direct.ok ? direct.info.name : (server?.name || address);

    return {
      address: server?.address || address,
      found: Boolean(server || direct.ok),
      online: direct.ok ? true : Boolean(server?.online),
      playersNow,
      maxPlayers,
      map,
      name,
      country: server?.country?.name || null,
      countryCode: server?.country?.code || null,
      region: server?.region?.name || null,
      tags: server?.tags || [],
      provider: server?.provider || null,
      updatedAt: new Date().toISOString(),
      livePlayerNames: direct.players,
      liveDataSource: direct.ok ? 'direct-a2s' : 'hvh.wtf-feed',
      liveQueryOk: direct.ok,
      liveQueryError: direct.ok ? null : direct.error
    };
  });

  return {
    source: 'https://hvh.wtf/api/servers',
    refreshedAt: new Date().toISOString(),
    totalTracked: filtered.length,
    servers: filtered
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/servers') {
    try {
      const data = await fetchServers();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 502, {
        error: 'Failed to fetch upstream server list',
        detail: error.message
      });
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveFile(res, path.join(publicDir, 'index.html'));
    return;
  }

  if (url.pathname === '/styles.css') {
    serveFile(res, path.join(publicDir, 'styles.css'), 'text/css; charset=utf-8');
    return;
  }

  if (url.pathname === '/jdm-bg.svg' || url.pathname === '/mirage-map.svg' || url.pathname === '/flag-sg.svg' || url.pathname === '/killua-inspired-bg.svg') {
    serveFile(res, path.join(publicDir, path.basename(url.pathname)), 'image/svg+xml');
    return;
  }

  if (url.pathname === '/mirage-map.jpg') {
    serveFile(res, path.join(publicDir, 'mirage-map.jpg'), 'image/jpeg');
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`HVH SG tracker running on http://localhost:${PORT}`);
});
