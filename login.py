from librespot.core import Session


print("\nConectando a Spotify...")

Session.Builder().stored_file('/app/credentials.json').oauth(

    lambda url: print(f'\n\n---> COPIA Y ABRE ESTE LINK EN TU NAVEGADOR:\n{url}\n\n')

).create()

print("\n¡Credenciales guardadas correctamente en /app/credentials.json!")
