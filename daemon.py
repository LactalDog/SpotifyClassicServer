import sys
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from librespot.core import Session
from librespot.metadata import TrackId
from librespot.audio.decoders import AudioQuality, VorbisOnlyAudioQuality

cred_file = '/app/credentials.json'
if not os.path.exists(cred_file):
    cred_file = os.path.join(os.path.dirname(__file__), 'credentials.json')

if not os.path.exists(cred_file):
    print("[Daemon Error] No existe credentials.json.", flush=True)
    sys.exit(1)

# Intercepta caídas en hilos secundarios de librespot
def thread_exception_handler(args):
    print(f"[Motor Err] Excepción en hilo '{args.thread.name}': {args.exc_value}", flush=True)
    if "session" in args.thread.name.lower() or "packet" in args.thread.name.lower() or isinstance(args.exc_value, (ConnectionResetError, ConnectionRefusedError, OSError)):
        print("[Motor] Conexión de Spotify perdida en segundo plano. Reiniciando proceso...", flush=True)
        os._exit(1)

threading.excepthook = thread_exception_handler

try:
    session = Session.Builder().stored_file(cred_file).create()
    print("[Daemon] ¡Conectado a Spotify! Motor M4A estabilizado en puerto 4000.", flush=True)
except Exception as e:
    print(f"[Daemon Error] Fallo al iniciar sesión: {e}", flush=True)
    os._exit(1)

class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write(f"[Motor HTTP] {self.address_string()} - {format % args}\n")

    def do_GET(self):
        out_path = None
        try:
            query = parse_qs(urlparse(self.path).query)
            if 'uri' not in query or 'out' not in query:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Faltan parametros uri y out")
                return

            uri, out_path = query['uri'][0], query['out'][0]
            track_id = TrackId.from_uri(uri)

            stream = session.content_feeder().load(
                track_id, 
                VorbisOnlyAudioQuality(AudioQuality.NORMAL), 
                False, 
                None
            )

            # PARÁMETROS CLAVE PARA EVITAR EL PETARDAZO EN HARDWARE ANTIGUO:
            # 1. -ar 44100: Fija la frecuencia nativa del DAC del Lumia 925.
            # 2. -c:a aac -profile:a aac_low: Perfil LC estándar compatible con Media Foundation.
            # 3. -movflags +faststart: Mueve la tabla de índices al inicio del archivo.
            # Aplicamos un micro-desvanecimiento inicial (afade) de 250 ms al inicio
            # y forzamos el perfil AAC-LC estándar con frecuencia fija de 44.1 kHz.
            ffmpeg_cmd = [
                'ffmpeg', '-y', '-i', 'pipe:0',
                '-c:a', 'aac',
                '-profile:a', 'aac_low',
                '-b:a', '160k',
                '-ar', '44100',
                '-ac', '2',
                '-af', 'afade=t=in:ss=0:d=0.25,volume=0.92',
                '-movflags', '+faststart',
                '-threads', '0',
                out_path
            ]
            process = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

            while True:
                chunk = stream.input_stream.stream().read(8192)
                if not chunk or chunk == -1 or isinstance(chunk, int):
                    break
                try:
                    process.stdin.write(bytes(chunk) if isinstance(chunk, list) else chunk)
                except (BrokenPipeError, IOError):
                    break

            process.stdin.close()
            process.wait()

            if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
                raise RuntimeError("El archivo M4A resultante no fue creado o quedo vacio.")

            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")

        except Exception as e:
            print(f"[Motor Err] Error al procesar audio: {e}", flush=True)
            if out_path and os.path.exists(out_path):
                try:
                    os.remove(out_path)
                except Exception:
                    pass

            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))

            err_str = str(e).lower()
            if isinstance(e, (OSError, ConnectionResetError, ConnectionRefusedError)) or "bad file descriptor" in err_str:
                print("[Motor] Socket roto detectado en peticion. Reiniciando daemon...", flush=True)
                os._exit(1)

class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True

server = ReusableHTTPServer(('127.0.0.1', 4000), RequestHandler)
server.serve_forever()