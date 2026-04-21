const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const TARGETS = [
  '139.99.62.233:27015',
  '103.216.223.85:7023',
  '139.99.62.233:27017'
];

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
  const filtered = TARGETS.map((address) => {
    const server = servers.find((entry) => entry.address === address);
    if (!server) {
      return {
        address,
        found: false,
        online: false,
        playersNow: null,
        maxPlayers: null,
        map: null,
        name: 'Unknown server'
      };
    }

    const [playersNow, maxPlayers] = Array.isArray(server.players) ? server.players : [null, null];

    return {
      address: server.address,
      found: true,
      online: Boolean(server.online),
      playersNow,
      maxPlayers,
      map: server.map || null,
      name: server.name || server.address,
      country: server.country?.name || null,
      region: server.region?.name || null,
      tags: server.tags || [],
      provider: server.provider || null,
      updatedAt: new Date().toISOString()
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

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`HVH SG tracker running on http://localhost:${PORT}`);
});
