"""Lecteur PDF libre : interface web locale.

Lancement :  python app.py   puis ouvrir http://127.0.0.1:5000
Les fichiers restent sur votre ordinateur (dossier « travail » à côté de ce script).
"""
import os
import shutil
import uuid
import webbrowser

import pymupdf
from flask import Flask, abort, jsonify, render_template, request, send_file

import pdftools

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "travail")
os.makedirs(WORK, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024


# Chaque document a un dossier ; chaque modification crée une nouvelle version
# (v0.pdf, v1.pdf, ...), ce qui permet d'annuler.

def _dir(doc_id):
    if not doc_id.isalnum():
        abort(400)
    path = os.path.join(WORK, doc_id)
    if not os.path.isdir(path):
        abort(404)
    return path


def _versions(doc_id):
    d = _dir(doc_id)
    return sorted((int(f[1:-4]) for f in os.listdir(d) if f.startswith("v") and f.endswith(".pdf")))


def _current(doc_id):
    return os.path.join(_dir(doc_id), f"v{_versions(doc_id)[-1]}.pdf")


def _name(doc_id):
    with open(os.path.join(_dir(doc_id), "nom.txt"), encoding="utf-8") as f:
        return f.read()


def _info(doc_id):
    with pymupdf.open(_current(doc_id)) as doc:
        return {
            "id": doc_id,
            "name": _name(doc_id),
            "version": _versions(doc_id)[-1],
            "pages": [{"w": p.rect.width, "h": p.rect.height} for p in doc],
            "needs_ocr": pdftools.needs_ocr(doc),
        }


def _edit(doc_id, fn):
    """Ouvre la version courante, applique `fn(doc)`, enregistre une nouvelle version."""
    src = _current(doc_id)
    dst = os.path.join(_dir(doc_id), f"v{_versions(doc_id)[-1] + 1}.pdf")
    with pymupdf.open(src) as doc:
        result = fn(doc)
        doc.save(dst, garbage=3, deflate=True)
    return result


@app.route("/")
def index():
    return render_template("index.html")


@app.post("/api/open")
def open_pdf():
    f = request.files.get("file")
    if not f or not f.filename.lower().endswith(".pdf"):
        return jsonify(error="Choisissez un fichier PDF."), 400
    doc_id = uuid.uuid4().hex
    d = os.path.join(WORK, doc_id)
    os.makedirs(d)
    f.save(os.path.join(d, "v0.pdf"))
    try:
        pymupdf.open(os.path.join(d, "v0.pdf")).close()
    except Exception:
        shutil.rmtree(d)
        return jsonify(error="Ce fichier n'est pas un PDF lisible."), 400
    with open(os.path.join(d, "nom.txt"), "w", encoding="utf-8") as fh:
        fh.write(os.path.splitext(os.path.basename(f.filename))[0])
    return jsonify(_info(doc_id))


@app.get("/api/<doc_id>/page/<int:n>.png")
def page_image(doc_id, n):
    zoom = min(float(request.args.get("zoom", 1.5)), 4)
    with pymupdf.open(_current(doc_id)) as doc:
        if not 0 <= n < len(doc):
            abort(404)
        png = doc[n].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).tobytes("png")
    from io import BytesIO
    return send_file(BytesIO(png), mimetype="image/png")


@app.post("/api/<doc_id>/edit")
def edit(doc_id):
    a = request.get_json(force=True)
    action = a.get("action")
    if action == "add_text":
        _edit(doc_id, lambda d: pdftools.add_text(d, a["page"], a["x"], a["y"], a["text"],
                                                   float(a.get("size", 12)), a.get("color")))
        msg = "Texte ajouté."
    elif action == "whiteout":
        _edit(doc_id, lambda d: pdftools.whiteout(d, a["page"], a["x0"], a["y0"], a["x1"], a["y1"]))
        msg = "Zone effacée."
    elif action == "replace":
        if not a.get("old"):
            return jsonify(error="Indiquez le texte à remplacer."), 400
        n = _edit(doc_id, lambda d: pdftools.replace_text(d, a["old"], a.get("new", "")))
        if n == 0:
            os.remove(_current(doc_id))
            return jsonify(error=f"« {a['old']} » introuvable. Si le PDF est un scan, lancez d'abord la reconnaissance de texte (OCR)."), 400
        msg = f"{n} remplacement(s)."
    elif action == "rotate":
        _edit(doc_id, lambda d: pdftools.rotate_page(d, a["page"], 90))
        msg = "Page pivotée."
    elif action == "delete_page":
        _edit(doc_id, lambda d: pdftools.delete_page(d, a["page"]))
        msg = "Page supprimée."
    elif action == "undo":
        if len(_versions(doc_id)) > 1:
            os.remove(_current(doc_id))
        msg = "Annulé."
    else:
        return jsonify(error="Action inconnue."), 400
    return jsonify({**_info(doc_id), "message": msg})


@app.post("/api/<doc_id>/ocr")
def ocr(doc_id):
    src = _current(doc_id)
    dst = os.path.join(_dir(doc_id), f"v{_versions(doc_id)[-1] + 1}.pdf")
    try:
        pdftools.ocr_pdf(src, dst, language=request.args.get("lang", "fra+eng"))
    except Exception as e:  # Tesseract absent, langue manquante...
        if os.path.exists(dst):
            os.remove(dst)
        return jsonify(error=f"OCR impossible : {e}. Vérifiez que Tesseract est installé (voir LISEZMOI)."), 500
    return jsonify({**_info(doc_id), "message": "Texte reconnu : le PDF est maintenant sélectionnable et convertible."})


@app.get("/api/<doc_id>/download/<fmt>")
def download(doc_id, fmt):
    src, name = _current(doc_id), _name(doc_id)
    d = _dir(doc_id)
    if fmt == "pdf":
        return send_file(src, as_attachment=True, download_name=f"{name}-modifie.pdf")
    if fmt == "docx":
        out = pdftools.to_word(src, os.path.join(d, "export.docx"))
        return send_file(out, as_attachment=True, download_name=f"{name}.docx")
    if fmt == "xlsx":
        out = os.path.join(d, "export.xlsx")
        pdftools.to_excel(src, out)
        return send_file(out, as_attachment=True, download_name=f"{name}.xlsx")
    if fmt == "txt":
        out = os.path.join(d, "export.txt")
        with open(out, "w", encoding="utf-8") as f:
            f.write(pdftools.extract_text(src))
        return send_file(out, as_attachment=True, download_name=f"{name}.txt")
    abort(404)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    if not os.environ.get("NO_BROWSER"):
        webbrowser.open(f"http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port)
