const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getArtistBackdrop } = require('./artist-image');

const app = express();
const PORT = 3000;
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// 1. Credenciales Primarias
const PRIMARY_CLIENT_ID = "e528b6952a33455093bc8dde5fb433a5";
const PRIMARY_CLIENT_SECRET = "31ebe14970d5404c897632cf7e2897dc";
const PRIMARY_REDIRECT_URI = "http://192.168.100.20:3000/callback";
const PRIMARY_TOKEN_FILE = path.join(__dirname, 'spotify_session.json');

// 2. Credenciales Compartidas
const SHARED_CLIENT_ID = "d420a117a32841c2b3474932e49fb54b";
const SHARED_REDIRECT_URI = "http://127.0.0.1:8989/login";
const SHARED_TOKEN_FILE = path.join(__dirname, 'spotify_session_shared.json');

const SCOPES = 'user-top-read user-read-recently-played playlist-read-private playlist-read-collaborative user-library-read user-read-playback-state user-modify-playback-state';

let primarySession = { accessToken: null, refreshToken: null, expiresAt: 0 };
if (fs.existsSync(PRIMARY_TOKEN_FILE)) {
    try { primarySession = JSON.parse(fs.readFileSync(PRIMARY_TOKEN_FILE, 'utf-8')); } catch (e) {}
}

let sharedSession = { accessToken: null, refreshToken: null, expiresAt: 0, codeVerifier: null };
if (fs.existsSync(SHARED_TOKEN_FILE)) {
    try { sharedSession = JSON.parse(fs.readFileSync(SHARED_TOKEN_FILE, 'utf-8')); } catch (e) {}
}

// ----------------------------------------------------------------------------
// STREAMING DE AUDIO OPTIMIZADO CON SOPORTE COMPLETO DE RANGOS HTTP (206)
// ----------------------------------------------------------------------------
app.get('/stream/:file', (req, res) => {
    const fileName = req.params.file;
    const filePath = path.join(CACHE_DIR, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("Archivo no encontrado en caché.");
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;

    // Manejo de imágenes de fondo optimizadas
    if (fileName.endsWith('.jpg')) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', totalSize);
        return fs.createReadStream(filePath).pipe(res);
    }

    // Manejo de archivos de audio M4A/AAC
    if (fileName.endsWith('.m4a')) {
        const range = req.headers.range;

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'audio/mp4');

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

            if (start >= totalSize || end >= totalSize) {
                res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
                return res.end();
            }

            const chunkSize = (end - start) + 1;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
            res.setHeader('Content-Length', chunkSize);

            const stream = fs.createReadStream(filePath, { start, end });

            req.on('close', () => {
                stream.destroy();
            });

            stream.pipe(res);
        } else {
            res.setHeader('Content-Length', totalSize);
            const stream = fs.createReadStream(filePath);

            req.on('close', () => {
                stream.destroy();
            });

            stream.pipe(res);
        }
    } else {
        res.sendFile(filePath);
    }
});

// Conservamos hasta 10 canciones en disco para que cambiar de pista no borre el archivo en uso
function cleanupCache(maxFiles = 10) {
    fs.readdir(CACHE_DIR, (err, files) => {
        if (err) return;
        const audioFiles = files.filter(f => f.endsWith('.m4a')).map(f => path.join(CACHE_DIR, f));
        if (audioFiles.length > maxFiles) {
            audioFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            const toDelete = audioFiles.slice(maxFiles);
            toDelete.forEach(file => { try { fs.unlinkSync(file); } catch (e) {} });
        }
    });
}

// --- GESTIÓN DE TOKENS ---
async function getValidPrimaryAccessToken() {
    if (!primarySession.refreshToken) throw new Error("Sesión primaria no autorizada. Entra a /login");
    if (primarySession.accessToken && Date.now() < primarySession.expiresAt - 60000) return primarySession.accessToken;

    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: primarySession.refreshToken });
    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${PRIMARY_CLIENT_ID}:${PRIMARY_CLIENT_SECRET}`).toString('base64')
        },
        body: body.toString()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description);
    primarySession.accessToken = data.access_token;
    primarySession.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) primarySession.refreshToken = data.refresh_token;
    fs.writeFileSync(PRIMARY_TOKEN_FILE, JSON.stringify(primarySession, null, 2));
    return primarySession.accessToken;
}

async function getValidSharedAccessToken() {
    if (!sharedSession.refreshToken) throw new Error("Sesión compartida no autorizada. Entra a http://127.0.0.1:8989/login");
    if (sharedSession.accessToken && Date.now() < sharedSession.expiresAt - 60000) return sharedSession.accessToken;

    const body = new URLSearchParams({
        client_id: SHARED_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: sharedSession.refreshToken
    });
    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || JSON.stringify(data));
    sharedSession.accessToken = data.access_token;
    sharedSession.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) sharedSession.refreshToken = data.refresh_token;
    fs.writeFileSync(SHARED_TOKEN_FILE, JSON.stringify(sharedSession, null, 2));
    return sharedSession.accessToken;
}

async function fetchWithRateLimitRetry(url, options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const response = await fetch(url, options);
        if (response.status === 429) {
            const retryAfterSecs = parseInt(response.headers.get('retry-after') || '2', 10);
            console.log(`[Rate Limit] 429 en Spotify. Reintentando en ${retryAfterSecs}s...`);
            await new Promise(resolve => setTimeout(resolve, retryAfterSecs * 1000));
            continue;
        }
        return response;
    }
    throw new Error("Límite de tasa excedido (429).");
}

function cleanDescription(str) {
    if (!str) return "Spotify";
    return str
        .replace(/<[^>]*>?/gm, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'");
}

async function optimizarImagenParaLumia(inputUrl, outputPath) {
    const res = await fetch(inputUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
    });

    if (!res.ok) throw new Error(`Fallo al descargar imagen [HTTP ${res.status}]`);

    const arrayBuffer = await res.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-i', 'pipe:0',
            '-vf', "scale='min(1024,iw)':-1",
            '-q:v', '2',
            outputPath
        ]);

        ffmpeg.stdin.write(imageBuffer);
        ffmpeg.stdin.end();

        let stderrMsg = '';
        ffmpeg.stderr.on('data', (d) => { stderrMsg += d.toString(); });

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg error (código ${code}): ${stderrMsg}`));
        });

        ffmpeg.on('error', reject);
    });
}

// --- RUTAS DE LOGIN PRINCIPAL ---
app.get('/login', (req, res) => {
    res.redirect(`https://accounts.spotify.com/authorize?client_id=${PRIMARY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(PRIMARY_REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("Código ausente.");
    try {
        const body = new URLSearchParams({ grant_type: 'authorization_code', code: code, redirect_uri: PRIMARY_REDIRECT_URI });
        const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(`${PRIMARY_CLIENT_ID}:${PRIMARY_CLIENT_SECRET}`).toString('base64')
            },
            body: body.toString()
        });
        const data = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(data.error_description);
        primarySession.accessToken = data.access_token;
        primarySession.refreshToken = data.refresh_token;
        primarySession.expiresAt = Date.now() + (data.expires_in * 1000);
        fs.writeFileSync(PRIMARY_TOKEN_FILE, JSON.stringify(primarySession, null, 2));
        res.send("<h1>¡Sesión Primaria vinculada con éxito!</h1>");
    } catch (err) { res.status(500).send(err.message); }
});

// --- ENDPOINTS API ---
app.get('/api/for-you', async (req, res) => {
    try {
        const token = await getValidPrimaryAccessToken();
        const topRes = await fetch("https://api.spotify.com/v1/me/top/tracks?limit=10&time_range=short_term", { headers: { "Authorization": `Bearer ${token}` } });
        if (!topRes.ok) throw new Error(`API error: ${topRes.status}`);
        const data = await topRes.json();
        const cleanList = (data.items || []).map(t => ({
            id: t.id, title: t.name, artist: t.artists.map(a => a.name).join(', '),
            album: t.album ? t.album.name : '', coverUrl: t.album && t.album.images.length > 0 ? t.album.images[0].url : '',
            uri: t.uri, durationMs: t.duration_ms
        }));
        res.json(cleanList);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/home/recently-played', async (req, res) => {
    try {
        const token = await getValidPrimaryAccessToken();
        const response = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=50', {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = await response.json();

        const uniqueItems = [];
        const seenUris = new Set();
        (data.items || []).forEach(item => {
            const track = item.track;
            if (!track) return;
            if (!seenUris.has(track.uri)) {
                seenUris.add(track.uri);
                uniqueItems.push({
                    titulo: track.name, bajada: track.artists.map(a => a.name).join(", "),
                    portada: track.album.images?.[0]?.url || "", uri: track.uri
                });
            }
        });
        res.json(uniqueItems.slice(0, 8));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// ENDPOINT: SUGERENCIAS / BIBLIOTECA DE PLAYLISTS (Estilo Spotifast Sidebar)
// ============================================================================
app.get('/api/home/suggestions', async (req, res) => {
    try {
        // Intentamos usar primero el token compartido (que tiene acceso sin restricciones a playlists editoriales)
        // y si no está vinculado, usamos el token primario como fallback.
        let token;
        try {
            token = await getValidSharedAccessToken();
        } catch (e) {
            token = await getValidPrimaryAccessToken();
        }

        // Consultamos la biblioteca de playlists con el límite máximo permitido por página (50)
        const response = await fetchWithRateLimitRetry('https://api.spotify.com/v1/me/playlists?limit=50', {
            headers: { 
                "Authorization": `Bearer ${token}`,
                "Accept-Language": "es-AR,es;q=0.9"
            }
        });

        if (!response.ok) {
            throw new Error(`Error API Spotify playlists: HTTP ${response.status}`);
        }

        const data = await response.json();

        // Mapeamos los elementos extrayendo el nombre del propietario tal como lo hace Spotifast
        const playlists = (data.items || []).filter(Boolean).map(item => {
            const ownerDisplayName = item.owner?.display_name || item.owner?.id || "Spotify";
            
            return {
                titulo: item.name || "Sin título",
                tipo: "Playlist",
                artista: ownerDisplayName, // "Spotify", "Joaquín", etc.
                portada: item.images && item.images.length > 0 ? item.images[0].url : "",
                uri: item.uri || ""
            };
        });

        // Devolvemos la lista completa obtenida (o las primeras 20 para la cuadrícula principal)
        res.json(playlists.slice(0, 20));
    } catch (err) {
        console.error("[Suggestions/Library Error]:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/home/made-for-you', async (req, res) => {
    try {
        const token = await getValidSharedAccessToken();
        const headers = {
            "Authorization": `Bearer ${token}`,
            "Accept-Language": "es-AR,es;q=0.9"
        };

        const [resDiscover, resRadar, resDaily] = await Promise.all([
            fetchWithRateLimitRetry('https://api.spotify.com/v1/search?' + new URLSearchParams({
                q: 'Discover Weekly',
                type: 'playlist',
                limit: '5'
            }), { headers }),

            fetchWithRateLimitRetry('https://api.spotify.com/v1/search?' + new URLSearchParams({
                q: 'Release Radar',
                type: 'playlist',
                limit: '5'
            }), { headers }),

            fetchWithRateLimitRetry('https://api.spotify.com/v1/search?' + new URLSearchParams({
                q: 'Daily Mix',
                type: 'playlist',
                limit: '15'
            }), { headers })
        ]);

        const dataDiscover = resDiscover.ok ? await resDiscover.json() : { playlists: { items: [] } };
        const dataRadar = resRadar.ok ? await resRadar.json() : { playlists: { items: [] } };
        const dataDaily = resDaily.ok ? await resDaily.json() : { playlists: { items: [] } };

        let discoverWeekly = null;
        let releaseRadar = null;
        const dailyMixes = [];

        for (const item of (dataDiscover.playlists?.items || []).filter(Boolean)) {
            const name = (item.name || "").trim().toLowerCase();
            const isSpotify = item.owner?.display_name?.toLowerCase() === 'spotify' || item.owner?.id === 'spotify';
            if (isSpotify && (name === "discover weekly" || name === "descubrimiento semanal")) {
                discoverWeekly = item;
                break;
            }
        }

        for (const item of (dataRadar.playlists?.items || []).filter(Boolean)) {
            const name = (item.name || "").trim().toLowerCase();
            const isSpotify = item.owner?.display_name?.toLowerCase() === 'spotify' || item.owner?.id === 'spotify';
            if (isSpotify && (name === "release radar" || name === "radar de novedades")) {
                releaseRadar = item;
                break;
            }
        }

        const seenMixes = new Set();
        for (const item of (dataDaily.playlists?.items || []).filter(Boolean)) {
            const name = (item.name || "").trim();
            const isSpotify = item.owner?.display_name?.toLowerCase() === 'spotify' || item.owner?.id === 'spotify';
            if (!isSpotify || name.toLowerCase().includes("radio")) continue;

            if (/^(daily mix|mix diario)\s*\d+/i.test(name) && !seenMixes.has(name.toLowerCase())) {
                seenMixes.add(name.toLowerCase());
                dailyMixes.push(item);
            }
        }

        dailyMixes.sort((a, b) => {
            const numA = parseInt((a.name.match(/\d+/) || [0])[0], 10);
            const numB = parseInt((b.name.match(/\d+/) || [0])[0], 10);
            return numA - numB;
        });

        const orderedPlaylists = [];
        if (discoverWeekly) orderedPlaylists.push(discoverWeekly);
        if (releaseRadar) orderedPlaylists.push(releaseRadar);
        orderedPlaylists.push(...dailyMixes);

        const result = orderedPlaylists.slice(0, 8).map(item => ({
            titulo: item.name,
            tipo: "Playlist",
            artista: cleanDescription(item.description) || "Spotify",
            portada: item.images && item.images.length > 0 ? item.images[0].url : "",
            uri: item.uri || ""
        }));

        res.json(result);
    } catch (err) {
        console.error("[Made For You Err]", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint de carga de reproducción
app.post('/api/player/load', async (req, res) => {
    const uri = req.query.uri;
    if (!uri) return res.status(400).send("Falta parámetro uri.");
    const trackId = uri.split(':').pop();

    const filePath = path.join(CACHE_DIR, `${trackId}.m4a`);
    cleanupCache(10);

    // Si ya existe y tiene contenido válido (> 10 KB)
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 10240) {
        return res.status(200).json({ url: `http://192.168.100.20:3000/stream/${trackId}.m4a` });
    }

    const requestConversion = async (attempt = 1) => {
        try {
            const response = await fetch(`http://127.0.0.1:4000/?uri=${encodeURIComponent(uri)}&out=${encodeURIComponent(filePath)}`);
            if (response.ok && fs.existsSync(filePath) && fs.statSync(filePath).size > 10240) {
                return res.status(200).json({ url: `http://192.168.100.20:3000/stream/${trackId}.m4a` });
            }
            throw new Error(`Daemon devolvió HTTP ${response.status} o archivo incompleto`);
        } catch (err) {
            if (attempt <= 2) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                return requestConversion(attempt + 1);
            }
            return res.status(500).send("Fallo del motor de reproducción tras reintentos.");
        }
    };

    await requestConversion();
});

// Supervisor 24/7 de audio
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');
let pyDaemon = null;
let isShuttingDown = false;

function startDaemon() {
    if (isShuttingDown) return;
    pyDaemon = spawn('python3', [path.join(__dirname, 'daemon.py')]);

    pyDaemon.stdout.on('data', (data) => {
        console.log(`[Daemon] ${data.toString().trim()}`);
    });

    pyDaemon.stderr.on('data', (data) => {
        const errText = data.toString().trim();
        console.error(`[Daemon Err] ${errText}`);

        if (errText.includes("InvalidCredentials") || errText.includes("SessionError")) {
            console.log("⚠️ Credenciales no válidas. Solicitando nuevo inicio de sesión...");
            try { fs.unlinkSync(CREDENTIALS_FILE); } catch (e) {}
        }
    });

    pyDaemon.on('close', (code) => {
        if (!isShuttingDown) {
            console.log(`[Daemon] Proceso cerrado (código ${code}). Verificando estado en 2s...`);
            setTimeout(verificarEIniciarAudio, 2000);
        }
    });
}

function verificarEIniciarAudio() {
    let credencialesValidas = false;

    if (fs.existsSync(CREDENTIALS_FILE)) {
        try {
            const stats = fs.statSync(CREDENTIALS_FILE);
            if (stats.size > 10) credencialesValidas = true;
        } catch (e) {}
    }

    if (!credencialesValidas) {
        console.log("\n========================================================");
        console.log("🔐 NO SE DETECTARON CREDENCIALES DE AUDIO VÁLIDAS");
        console.log("🚀 Ejecutando login.py de forma automática...");
        console.log("========================================================\n");

        const loginProc = spawn('python3', [path.join(__dirname, 'login.py')], {
            stdio: 'inherit'
        });

        loginProc.on('close', (code) => {
            if (code === 0) {
                console.log("\n✅ ¡Sesión vinculada con éxito! Arrancando daemon.py...\n");
                startDaemon();
            } else {
                console.error(`\n❌ login.py terminó con error (${code}). Reintentando en 10s...`);
                setTimeout(verificarEIniciarAudio, 10000);
            }
        });
    } else {
        console.log("🔐 [Audio Engine] Credenciales válidas encontradas. Iniciando daemon.py...");
        startDaemon();
    }
}

verificarEIniciarAudio();

// ============================================================================
// PARLANTE VIRTUAL SPOTIFY CONNECT (MODO ESPEJO DUMMY)
// ============================================================================
const VIRTUAL_DEVICE_NAME = "Windows Phone";
let connectDaemon = null;
let cachedDeviceId = null;

function startConnectReceiver() {
    if (isShuttingDown) return;

    // Usamos /app/cache donde ya reside cache/credentials.json compatible con librespot Rust
    connectDaemon = spawn('librespot', [
        '--name', VIRTUAL_DEVICE_NAME,
        '--device-type', 'smartphone',
        '--backend', 'pipe',
        '--device', '/dev/null',
        '--cache', CACHE_DIR,
        '--disable-audio-cache',
        '--initial-volume', '100'
    ]);

    connectDaemon.stdout.on('data', (data) => {
        console.log(`[Connect Virtual] ${data.toString().trim()}`);
    });

    connectDaemon.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // Filtramos logs informativos rutinarios si lo deseas
        console.log(`[Connect Info] ${msg}`);
    });

    connectDaemon.on('close', (code) => {
        cachedDeviceId = null;
        if (!isShuttingDown) {
            console.log(`[Connect Virtual] Proceso cerrado (${code}). Reiniciando en 3s...`);
            setTimeout(startConnectReceiver, 3000);
        }
    });
}

// Iniciar el receptor virtual Spotify Connect
startConnectReceiver();

// Busca el device_id del parlante virtual en la API de Spotify
async function getVirtualDeviceId(token, forceRefresh = false) {
    if (cachedDeviceId && !forceRefresh) return cachedDeviceId;

    const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
        headers: { "Authorization": `Bearer ${token}` }
    });

    if (res.ok) {
        const data = await res.json();
        const device = (data.devices || []).find(d => d.name === VIRTUAL_DEVICE_NAME);
        if (device && device.id) {
            cachedDeviceId = device.id;
            return cachedDeviceId;
        }
    }
    return null;
}

// Endpoint que recibe el estado real desde el Lumia y lo refleja en Spotify Cloud
app.post('/api/player/sync', async (req, res) => {
    const { action, uri, positionMs } = req.query;

    try {
        const token = await getValidPrimaryAccessToken();
        let deviceId = await getVirtualDeviceId(token, false);

        if (!deviceId) {
            // Reintento forzando refresco de lista de dispositivos
            deviceId = await getVirtualDeviceId(token, true);
        }

        if (!deviceId) {
            return res.status(503).json({ error: "Parlante virtual aún no disponible en Spotify Connect." });
        }

        const pos = Math.max(0, parseInt(positionMs || '0', 10));

        if (action === 'play') {
            // Si enviamos URI iniciamos esa pista en la posición indicada; si no hay URI, reanudamos
            const bodyObj = uri ? { uris: [uri], position_ms: pos } : { position_ms: pos };

            let playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
                method: 'PUT',
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(bodyObj)
            });

            // Si el deviceId cambió por reconexión, refrescamos una vez
            if (playRes.status === 404) {
                deviceId = await getVirtualDeviceId(token, true);
                if (deviceId) {
                    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
                        method: 'PUT',
                        headers: {
                            "Authorization": `Bearer ${token}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(bodyObj)
                    });
                }
            }
        } else if (action === 'pause') {
            await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
                method: 'PUT',
                headers: { "Authorization": `Bearer ${token}` }
            });
        } else if (action === 'seek') {
            await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${pos}&device_id=${deviceId}`, {
                method: 'PUT',
                headers: { "Authorization": `Bearer ${token}` }
            });
        }

        res.json({ success: true, action, positionMs: pos });
    } catch (err) {
        console.error("[Sync Error]:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint de fondo optimizado con detección de caché previa
app.get('/api/player/backdrop', async (req, res) => {
    const trackUri = req.query.uri;
    if (!trackUri) return res.status(400).json({ error: "Falta parámetro uri." });

    const trackId = trackUri.split(':').pop();

    try {
        const token = await getValidPrimaryAccessToken();
        const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (!trackRes.ok) throw new Error(`Error API Spotify tracks: HTTP ${trackRes.status}`);

        const trackData = await trackRes.json();
        const artist = trackData.artists?.[0];

        if (!artist || !artist.id) {
            return res.status(404).json({ error: "No se encontró artista para esta pista." });
        }

        const localFileName = `backdrop_${artist.id}.jpg`;
        const localFilePath = path.join(CACHE_DIR, localFileName);
        const estabaEnCache = fs.existsSync(localFilePath);

        const backdropData = await getArtistBackdrop(artist.id);

        if (backdropData.seleccionada) {
            if (!estabaEnCache) {
                console.log(`[Backdrop] Optimizando imagen de ${backdropData.nombre} para Lumia...`);
                await optimizarImagenParaLumia(backdropData.seleccionada, localFilePath);
                console.log(`[Backdrop] ✅ Guardada en cache/${localFileName}`);
            }

            return res.json({
                success: true,
                artistId: artist.id,
                artistName: backdropData.nombre,
                cached: estabaEnCache,
                backdropUrl: `http://192.168.100.20:3000/stream/${localFileName}`
            });
        }

        res.json({
            success: true,
            artistId: artist.id,
            artistName: backdropData.nombre,
            cached: estabaEnCache,
            backdropUrl: null
        });
    } catch (err) {
        console.error("[Backdrop Error]:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Gateway] Servidor principal activo en http://0.0.0.0:${PORT}`);
});

// Servidor de login compartido
const sharedApp = express();

sharedApp.get('/login', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        const codeVerifier = crypto.randomBytes(64).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        sharedSession.codeVerifier = codeVerifier;
        fs.writeFileSync(SHARED_TOKEN_FILE, JSON.stringify(sharedSession, null, 2));

        const authUrl = `https://accounts.spotify.com/authorize?` + new URLSearchParams({
            client_id: SHARED_CLIENT_ID,
            response_type: 'code',
            redirect_uri: SHARED_REDIRECT_URI,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge,
            scope: SCOPES
        }).toString();
        return res.redirect(authUrl);
    }

    try {
        const body = new URLSearchParams({
            client_id: SHARED_CLIENT_ID,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: SHARED_REDIRECT_URI,
            code_verifier: sharedSession.codeVerifier
        });
        const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
        const data = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(data.error_description || JSON.stringify(data));

        sharedSession.accessToken = data.access_token;
        sharedSession.refreshToken = data.refresh_token;
        sharedSession.expiresAt = Date.now() + (data.expires_in * 1000);
        sharedSession.codeVerifier = null;
        fs.writeFileSync(SHARED_TOKEN_FILE, JSON.stringify(sharedSession, null, 2));
        res.send("<h1>¡Sesión Compartida vinculada con éxito! Ya puedes cerrar esta pestaña.</h1>");
    } catch (err) { res.status(500).send(err.message); }
});

sharedApp.listen(8989, '0.0.0.0', () => {
    console.log(`[Shared Auth] Servidor de autenticación pública NUEVO CON M4A activo en puerto 8989`);
});