// artist-image.js

const puppeteer = require('puppeteer');

const artistMediaCache = new Map();
let globalBrowser = null;

async function getBrowserInstance() {
    if (!globalBrowser || !globalBrowser.connected) {
        globalBrowser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1920,1080'
            ]
        });
    }
    return globalBrowser;
}

function extractArtistId(input) {
    if (!input) return null;
    const clean = input.trim();
    const match = clean.match(/(?:artist[/:])([a-zA-Z0-9]{22})/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9]{22}$/.test(clean)) return clean;
    return null;
}

async function getArtistBackdrop(rawInput) {
    const artistId = extractArtistId(rawInput);
    if (!artistId) throw new Error('Identificador de artista inválido.');

    if (artistMediaCache.has(artistId)) {
        const cached = artistMediaCache.get(artistId);
        imprimirResultadosConsola(cached, true);
        return cached;
    }

    const browser = await getBrowserInstance();
    const page = await browser.newPage();

    let artistUnionData = null;
    let fallbackBannerUrl = null;

    try {
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setCacheEnabled(false);
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        page.on('response', async (res) => {
            const url = res.url();
            if (url.includes('pathfinder') || url.includes('/query')) {
                try {
                    const text = await res.text();
                    if (text.includes('artistUnion')) {
                        const json = JSON.parse(text);
                        if (json?.data?.artistUnion) {
                            artistUnionData = json.data.artistUnion;
                        }
                    }
                } catch (e) {}
            }

            if (url.includes('ab676186') && !fallbackBannerUrl) {
                fallbackBannerUrl = url;
            }
        });

        const targetUrl = `https://open.spotify.com/intl-es/artist/${artistId}`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const startTime = Date.now();
        const timeoutMs = 15000;
        let scrolled = false;

        while (!artistUnionData && (Date.now() - startTime < timeoutMs)) {
            if (!scrolled && (Date.now() - startTime > 3000)) {
                scrolled = true;
                await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    } catch (err) {
        console.error('[Scraper Error]:', err.message);
    } finally {
        await page.close();
    }

    const galleryUrls = [];
    let bannerUrl = fallbackBannerUrl;
    const artistName = artistUnionData?.profile?.name || artistId;

    if (artistUnionData) {
        const galleryItems = artistUnionData.visuals?.gallery?.items || [];
        for (const item of galleryItems) {
            const sources = item.sources || [];
            if (sources.length > 0) {
                const bestSource = sources.reduce((prev, curr) =>
                    ((curr.width || 0) > (prev.width || 0) ? curr : prev), sources[0]);
                if (bestSource?.url && !galleryUrls.includes(bestSource.url)) {
                    galleryUrls.push(bestSource.url);
                }
            }
        }

        const headerSources = artistUnionData.headerImage?.data?.sources || [];
        if (headerSources.length > 0) {
            const bestHeader = headerSources.reduce((prev, curr) =>
                ((curr.maxWidth || curr.width || 0) > (prev.maxWidth || prev.width || 0) ? curr : prev), headerSources[0]);
            bannerUrl = bestHeader.url;
        }
    }

    const todasLasImagenes = [];
    if (bannerUrl) {
        todasLasImagenes.push(bannerUrl);
    }
    for (const url of galleryUrls) {
        if (!todasLasImagenes.includes(url)) {
            todasLasImagenes.push(url);
        }
    }

    // --- NUEVA LÓGICA DE PRIORIDAD ---
    // 1. Prioridad: Banner Panorámico
    // 2. Prioridad: Primera imagen de la Galería "Acerca de"
    // 3. Ninguna imagen
    let imagenSeleccionada = null;
    let tipoSeleccionado = 'Ninguna';

    if (bannerUrl) {
        imagenSeleccionada = bannerUrl;
        tipoSeleccionado = 'Banner Panorámico';
    } else if (galleryUrls.length > 0) {
        imagenSeleccionada = galleryUrls[0];
        tipoSeleccionado = 'Primera foto de la Galería "Acerca de"';
    }

    const resultado = {
        id: artistId,
        nombre: artistName,
        seleccionada: imagenSeleccionada,
        tipo: tipoSeleccionado,
        banner: bannerUrl,
        galeria: galleryUrls,
        totalEncontradas: todasLasImagenes.length,
        todas: todasLasImagenes
    };

    if (imagenSeleccionada) {
        artistMediaCache.set(artistId, resultado);
    }

    imprimirResultadosConsola(resultado, false);
    return resultado;
}

function imprimirResultadosConsola(res, esCache) {
    console.log('\n========================================');
    console.log(`        RESULTADOS: ${res.nombre.toUpperCase()} ${esCache ? '[CACHÉ]' : ''}`);
    console.log('========================================');
    console.log(`Artista ID:            ${res.id}`);
    console.log(`Fotos en Galería:      ${res.galeria.length}`);
    console.log(`Banner disponible:     ${res.banner ? 'Sí' : 'No'}`);
    console.log(`Total de imágenes:     ${res.totalEncontradas}`);
    console.log('----------------------------------------');
    console.log(`🎯 IMAGEN SELECCIONADA (${res.tipo}):`);
    console.log(res.seleccionada || 'No se encontraron imágenes horizontales');
    console.log('----------------------------------------');

    if (res.todas.length > 0) {
        console.log('📋 Lista completa de imágenes encontradas:');
        res.todas.forEach((url, index) => {
            const origen = url === res.banner ? 'Banner' : 'Galería';
            console.log(`  [${index + 1}] (${origen}) ${url}`);
        });
    }
}

module.exports = { getArtistBackdrop };