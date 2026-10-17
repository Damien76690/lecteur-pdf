"""Lecteur PDF libre : version application de bureau (fenêtre Windows, sans navigateur).

Lancement :  python bureau.py        (nécessite  pip install pywebview)
Vérification sans fenêtre :  python bureau.py --verifier
C'est ce fichier que l'application Windows (LecteurPDF.exe) exécute.
"""
import os
import shutil
import socket
import sys
import threading

# Fichiers de travail dans le profil de l'utilisateur (le dossier du programme
# n'est pas modifiable une fois installé dans « Program Files »).
os.environ.setdefault("LECTEUR_PDF_TRAVAIL", os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LecteurPDF", "travail"))

import app as serveur  # noqa: E402
import pdftools  # noqa: E402

FILTRES = {
    "pdf": "Document PDF (*.pdf)",
    "docx": "Document Word (*.docx)",
    "xlsx": "Classeur Excel (*.xlsx)",
    "txt": "Texte (*.txt)",
}


class Api:
    """Fonctions appelées depuis la page (window.pywebview.api...)."""

    def __init__(self):
        self.window = None

    def enregistrer(self, doc_id, fmt):
        import webview
        with serveur.app.test_request_context():
            path, name = serveur.export(doc_id, fmt)
        choix = self.window.create_file_dialog(
            webview.FileDialog.SAVE, save_filename=name, file_types=(FILTRES[fmt],))
        if not choix:
            return {"message": "Enregistrement annulé."}
        dest = choix if isinstance(choix, str) else choix[0]
        if not dest.lower().endswith("." + fmt):
            dest += "." + fmt
        shutil.copyfile(path, dest)
        return {"message": f"Enregistré : {dest}"}


def port_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def verifier():
    """Contrôle que tout fonctionne dans l'application installée (utilisé par la compilation)."""
    import tempfile
    exemples = os.path.join(getattr(sys, "_MEIPASS", serveur.HERE), "exemples")
    tmp = tempfile.mkdtemp()
    pdftools.to_word(os.path.join(exemples, "facture.pdf"), os.path.join(tmp, "f.docx"))
    assert pdftools.to_excel(os.path.join(exemples, "facture.pdf"), os.path.join(tmp, "f.xlsx")) == 1, "Excel"
    client = serveur.app.test_client()
    assert client.get("/").status_code == 200, "page"
    scan = os.path.join(exemples, "facture-scannee.pdf")
    pdftools.ocr_pdf(scan, os.path.join(tmp, "ocr.pdf"))
    assert "Dupont" in pdftools.extract_text(os.path.join(tmp, "ocr.pdf")), "OCR"
    print("Tout fonctionne.")


def main():
    if sys.stdout is None:  # application sans console : messages dans journal.txt
        journal = os.path.join(os.path.dirname(serveur.WORK), "journal.txt")
        sys.stdout = sys.stderr = open(journal, "w", encoding="utf-8", buffering=1)
    if "--verifier" in sys.argv:
        try:
            verifier()
        except Exception as e:
            print("Erreur :", repr(e))
            sys.exit(1)
        return

    import webview
    port = port_libre()
    threading.Thread(target=lambda: serveur.app.run(host="127.0.0.1", port=port),
                     daemon=True).start()
    api = Api()
    api.window = webview.create_window("Lecteur PDF libre", f"http://127.0.0.1:{port}",
                                       js_api=api, width=1280, height=860, min_size=(800, 500))
    webview.start(gui="edgechromium" if sys.platform == "win32" else None)


if __name__ == "__main__":
    main()
