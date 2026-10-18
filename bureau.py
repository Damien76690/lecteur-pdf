"""Mim PDF : application de bureau (fenêtre Windows, sans navigateur).

Elle affiche exactement la version en ligne (dossier web/), servie depuis l'ordinateur :
tout fonctionne sans Internet, OCR compris, et chaque fonction n'est écrite qu'une fois.

Préparation :  npm ci && npm run build -- build/site      puis  pip install -r requirements-bureau.txt
Lancement :  python bureau.py
Vérification sans fenêtre :  python bureau.py --verifier
Essai de la fenêtre (ouvre la facture d'exemple puis se ferme seule) :  python bureau.py --essai-fenetre
C'est ce fichier que l'application Windows (MimPDF.exe) exécute.

Mise à jour automatique : au lancement puis toutes les 6 heures, l'application installée regarde
la dernière version publiée sur GitHub (Releases), télécharge son installateur en arrière-plan,
propose de redémarrer et, sinon, l'installe sans rien demander quand on ferme la fenêtre.
"""
import base64
import functools
import json
import os
import subprocess
import sys
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ICI = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(getattr(sys, "_MEIPASS", ICI), "site") if hasattr(sys, "_MEIPASS") \
    else os.path.join(ICI, "build", "site")
DONNEES = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "MimPDF")
JOURNAL = os.path.join(DONNEES, "journal.txt")
DEPOT = "Damien76690/lecteur-pdf"
INSTALLATEUR = "MimPDF-installation.exe"
VERROU = "MimPDF"  # l'installateur attend que ce verrou disparaisse (fenêtre fermée) avant de remplacer les fichiers

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


def version_installee():
    try:
        with open(os.path.join(SITE, "version.json"), encoding="utf-8") as f:
            return json.load(f)["version"]
    except (OSError, ValueError, KeyError):
        return "0.0.0"


def numeros(version):
    return tuple(int(x) for x in version.lstrip("v").split(".") if x.isdigit())


class MiseAJour:
    """Cherche, télécharge puis lance l'installateur de la dernière version publiée."""

    def __init__(self, version):
        self.version = version
        self.prete = None      # (version, chemin de l'installateur téléchargé)
        self.lancee = False
        self.quand_prete = None

    @staticmethod
    def active():
        # Seulement pour l'application installée (pas la version portable ni le développement).
        return getattr(sys, "frozen", False) and os.path.isfile(os.path.join(os.path.dirname(sys.executable), "unins000.exe"))

    def chercher(self):
        demande = urllib.request.Request(f"https://api.github.com/repos/{DEPOT}/releases/latest",
                                         headers={"Accept": "application/vnd.github+json", "User-Agent": "MimPDF"})
        with urllib.request.urlopen(demande, timeout=30) as r:
            publication = json.load(r)
        nouvelle = publication["tag_name"].lstrip("v")
        if numeros(nouvelle) <= numeros(self.version):
            return None
        for fichier in publication.get("assets", []):
            if fichier["name"] == INSTALLATEUR:
                return nouvelle, fichier["browser_download_url"]
        return None

    def telecharger(self, version, url):
        dossier = os.path.join(DONNEES, "mise-a-jour")
        os.makedirs(dossier, exist_ok=True)
        chemin = os.path.join(dossier, f"MimPDF-installation-{version}.exe")
        if not os.path.isfile(chemin):
            demande = urllib.request.Request(url, headers={"User-Agent": "MimPDF"})
            with urllib.request.urlopen(demande, timeout=120) as r, open(chemin + ".part", "wb") as f:
                while bloc := r.read(1 << 16):
                    f.write(bloc)
            os.replace(chemin + ".part", chemin)
        for ancien in os.listdir(dossier):  # garde seulement la dernière version téléchargée
            if ancien != os.path.basename(chemin):
                try:
                    os.remove(os.path.join(dossier, ancien))
                except OSError:
                    pass
        return chemin

    def surveiller(self):
        while not self.lancee:
            try:
                trouvee = self.chercher()
                if trouvee and (not self.prete or self.prete[0] != trouvee[0]):
                    self.prete = (trouvee[0], self.telecharger(*trouvee))
                    print("Mise à jour prête :", trouvee[0], flush=True)
                    if self.quand_prete:
                        self.quand_prete(trouvee[0])
            except Exception as e:  # pas d'Internet, GitHub indisponible... on réessaiera plus tard
                print("Recherche de mise à jour :", repr(e), flush=True)
            threading.Event().wait(6 * 3600)

    def installer(self, relancer):
        if not self.prete or self.lancee:
            return False
        self.lancee = True
        options = ["/SILENT" if relancer else "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]
        if relancer:
            options.append("/RELANCER=1")
        subprocess.Popen([self.prete[1], *options], close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
        return True


class Api:
    """Fonctions appelées depuis la page (window.pywebview.api...)."""

    def __init__(self):
        self._window = None
        self._maj = None

    def mise_a_jour(self):
        """Version prête à installer (ou None), et version actuelle."""
        maj = self._maj
        return {"actuelle": maj.version if maj else version_installee(),
                "prete": maj.prete[0] if maj and maj.prete else None}

    def installer_mise_a_jour(self):
        if self._maj and self._maj.installer(relancer=True):
            threading.Timer(0.5, self._window.destroy).start()
            return {"message": "Installation de la mise à jour…"}
        return {"message": "Aucune mise à jour à installer."}

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
        "version.json": "application/json",
        "favicon.svg": "image/svg+xml",
    }
    for chemin, type_attendu in attendus.items():
        print("Vérification :", chemin or "index.html", flush=True)
        with urllib.request.urlopen(url + chemin, timeout=20) as r:
            assert r.status == 200 and r.headers["Content-Type"].startswith(type_attendu), chemin
            assert len(r.read()) > 0, chemin
    print("Version :", version_installee())
    print("Tout fonctionne.")


def garde_fou(secondes):
    """Arrête le programme s'il reste bloqué (essais automatiques uniquement)."""
    def arret():
        print(f"Bloqué depuis {secondes} s : arrêt.", flush=True)
        os._exit(3)
    t = threading.Timer(secondes, arret)
    t.daemon = True
    t.start()


def main():
    if sys.stdout is None:  # application sans console : messages dans journal.txt
        os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
        sys.stdout = sys.stderr = open(JOURNAL, "w", encoding="utf-8", buffering=1)
    if "--verifier" in sys.argv or "--essai-fenetre" in sys.argv:
        garde_fou(240)
    if "--verifier" in sys.argv:
        try:
            verifier()
        except Exception as e:
            print("Erreur :", repr(e))
            sys.exit(1)
        return

    import webview
    if sys.platform == "win32":
        import ctypes
        verrou = ctypes.windll.kernel32.CreateMutexW(None, False, VERROU)  # noqa: F841 (gardé ouvert)
    api = Api()
    api._window = webview.create_window("Mim PDF", demarrer_serveur(),
                                       js_api=api, width=1280, height=860, min_size=(800, 500))
    if MiseAJour.active() and "--essai-fenetre" not in sys.argv:
        api._maj = MiseAJour(version_installee())

        def annoncer(version):
            try:
                api._window.evaluate_js(f"window.mimMiseAJour && window.mimMiseAJour({json.dumps(version)})")
            except Exception as e:
                print("Annonce de la mise à jour :", repr(e), flush=True)
        api._maj.quand_prete = annoncer
        threading.Thread(target=api._maj.surveiller, daemon=True).start()
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
            print("Délai dépassé :", expression, flush=True)
            print("Message affiché :",
                  window.evaluate_js("document.querySelector('#msg') && document.querySelector('#msg').textContent"))
            return False

        def essai(window):
            print("Fenêtre ouverte, attente du lecteur…", flush=True)
            try:
                # Le lecteur (MuPDF) doit se charger sans Internet, puis ouvrir la facture d'exemple.
                if attendre(window, "!!(window.pywebview && window.pywebview.api && window.pywebview.api.enregistrer)"
                                    " && /Ouvrez un PDF/.test(document.querySelector('#msg').textContent)"):
                    window.evaluate_js("document.querySelector('[data-sample=facture]').click()")
                    resultat["ok"] = attendre(window, "document.querySelectorAll('#pages .page img[src]').length > 0")
            except Exception as e:
                print("Erreur pendant l'essai :", repr(e), flush=True)
            finally:
                window.destroy()

    webview.start(essai, api._window, gui="edgechromium" if sys.platform == "win32" else None)
    if api._maj:  # mise à jour téléchargée mais pas encore installée : on l'installe en partant
        api._maj.installer(relancer=False)
    if essai:
        print("Fenêtre OK" if resultat.get("ok") else "Fenêtre : le lecteur ne s'est pas chargé")
        sys.exit(0 if resultat.get("ok") else 1)


if __name__ == "__main__":
    main()
