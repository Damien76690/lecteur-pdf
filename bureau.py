"""Lecteur PDF libre : application de bureau (fenêtre Windows, sans navigateur).

Elle affiche exactement la version en ligne (dossier web/), servie depuis l'ordinateur :
tout fonctionne sans Internet, OCR compris, et chaque fonction n'est écrite qu'une fois.

Préparation :  npm ci && npm run build -- build/site      puis  pip install -r requirements-bureau.txt
Lancement :  python bureau.py
Vérification sans fenêtre :  python bureau.py --verifier
Essai de la fenêtre (ouvre la facture d'exemple puis se ferme seule) :  python bureau.py --essai-fenetre
C'est ce fichier que l'application Windows (LecteurPDF.exe) exécute.
"""
import base64
import functools
import os
import sys
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ICI = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(getattr(sys, "_MEIPASS", ICI), "site") if hasattr(sys, "_MEIPASS") \
    else os.path.join(ICI, "build", "site")
JOURNAL = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LecteurPDF", "journal.txt")

FILTRES = {
    "pdf": "Document PDF (*.pdf)",
    "docx": "Document Word (*.docx)",
    "xlsx": "Classeur Excel (*.xlsx)",
    "txt": "Texte (*.txt)",
}


class Pages(SimpleHTTPRequestHandler):
    """Sert le site sur 127.0.0.1 uniquement (rien n'est accessible depuis le réseau)."""
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                      ".gz": "application/gzip"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def demarrer_serveur():
    if not os.path.isfile(os.path.join(SITE, "index.html")):
        raise SystemExit(f"Site introuvable dans {SITE} : lancez d'abord  npm run build -- build/site")
    serveur = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Pages, directory=SITE))
    threading.Thread(target=serveur.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{serveur.server_address[1]}/"


class Api:
    """Fonctions appelées depuis la page (window.pywebview.api...)."""

    def __init__(self):
        self._window = None

    def enregistrer(self, nom, contenu_base64):
        import webview
        fmt = nom.rsplit(".", 1)[-1].lower()
        choix = self._window.create_file_dialog(
            webview.FileDialog.SAVE, save_filename=nom, file_types=(FILTRES.get(fmt, "Tous les fichiers (*.*)"),))
        if not choix:
            return {"message": "Enregistrement annulé."}
        dest = choix if isinstance(choix, str) else choix[0]
        if not dest.lower().endswith("." + fmt):
            dest += "." + fmt
        with open(dest, "wb") as f:
            f.write(base64.b64decode(contenu_base64))
        return {"message": f"Enregistré : {dest}"}


def verifier():
    """Contrôle que l'application installée contient tout le site (utilisé par la compilation)."""
    url = demarrer_serveur()
    attendus = {
        "": "text/html", "app.js": "text/javascript", "core.js": "text/javascript",
        "vendor/mupdf/mupdf-wasm.wasm": "application/wasm",
        "vendor/tesseract/lang/fra.traineddata.gz": "application/gzip",
        "exemples/facture.pdf": "application/pdf",
    }
    for chemin, type_attendu in attendus.items():
        with urllib.request.urlopen(url + chemin) as r:
            assert r.status == 200 and r.headers["Content-Type"].startswith(type_attendu), chemin
            assert len(r.read()) > 0, chemin
    print("Tout fonctionne.")


def main():
    if sys.stdout is None:  # application sans console : messages dans journal.txt
        os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
        sys.stdout = sys.stderr = open(JOURNAL, "w", encoding="utf-8", buffering=1)
    if "--verifier" in sys.argv:
        try:
            verifier()
        except Exception as e:
            print("Erreur :", repr(e))
            sys.exit(1)
        return

    import webview
    api = Api()
    api._window = webview.create_window("Lecteur PDF libre", demarrer_serveur(),
                                       js_api=api, width=1280, height=860, min_size=(800, 500))
    essai = None
    if "--essai-fenetre" in sys.argv:
        resultat = {}

        def attendre(window, expression, secondes=90):
            for _ in range(secondes):
                try:
                    if window.evaluate_js(expression):
                        return True
                except Exception as e:
                    print("Attente de la fenêtre :", repr(e))
                threading.Event().wait(1)
            print("Délai dépassé :", expression, "| message affiché :",
                  window.evaluate_js("document.querySelector('#msg') && document.querySelector('#msg').textContent"))
            return False

        def essai(window):
            # Le lecteur (MuPDF) doit se charger sans Internet, puis ouvrir la facture d'exemple.
            if attendre(window, "!!(window.pywebview && window.pywebview.api && window.pywebview.api.enregistrer)"
                                " && /Ouvrez un PDF/.test(document.querySelector('#msg').textContent)"):
                window.evaluate_js("document.querySelector('#sample').click()")
                resultat["ok"] = attendre(window, "document.querySelectorAll('#pages .page img[src]').length > 0")
            window.destroy()

    webview.start(essai, api._window, gui="edgechromium" if sys.platform == "win32" else None)
    if essai:
        print("Fenêtre OK" if resultat.get("ok") else "Fenêtre : le lecteur ne s'est pas chargé")
        sys.exit(0 if resultat.get("ok") else 1)


if __name__ == "__main__":
    main()
