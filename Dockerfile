# Etapa 1: Compilar el binario nativo de librespot usando las dependencias exactas (--locked)
FROM rust:slim-bookworm AS librespot-builder
RUN apt-get update && apt-get install -y git pkg-config build-essential libssl-dev --no-install-recommends
RUN cargo install librespot --locked --no-default-features --features "native-tls"

# Etapa 2: Imagen final del servidor
FROM node:20-bookworm-slim

# Copiamos el binario compilado de librespot desde la Etapa 1
COPY --from=librespot-builder /usr/local/cargo/bin/librespot /usr/local/bin/librespot

# 1. Instalar Chromium, fuentes, herramientas de audio (ffmpeg) y entorno Python
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. Instalar librespot en Python (para daemon.py)
RUN pip3 install --no-cache-dir --break-system-packages librespot

# 3. Configurar Puppeteer para usar el Chromium instalado en el sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# 4. Instalar librerías de Node.js
COPY package*.json ./
RUN npm install

# 5. Copiar el resto del servidor
COPY . .

EXPOSE 3000 8989

CMD ["node", "server.js"]