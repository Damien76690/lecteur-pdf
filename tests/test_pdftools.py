"""Tests rapides : python -m pytest tests  (ou  python tests/test_pdftools.py)"""
import os
import sys
import tempfile

import openpyxl
import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import pdftools  # noqa: E402

EX = os.path.join(os.path.dirname(HERE), "exemples")
TMP = tempfile.mkdtemp()


def test_remplacer_et_ecrire():
    with pymupdf.open(os.path.join(EX, "facture.pdf")) as doc:
        assert pdftools.replace_text(doc, "Dupont", "Martin") == 1
        pdftools.add_text(doc, 0, 72, 300, "Payé – 105 €")
        text = doc[0].get_text()
    assert "Martin" in text and "Dupont" not in text and "Payé – 105 €" in text


def test_excel():
    out = os.path.join(TMP, "f.xlsx")
    assert pdftools.to_excel(os.path.join(EX, "facture.pdf"), out) == 1
    rows = list(openpyxl.load_workbook(out).active.values)
    assert rows[0] == ("Article", "Quantité", "Prix unitaire", "Total")
    assert rows[1] == ("Papier A4", 10, 4.5, 45)


def test_word():
    out = os.path.join(TMP, "f.docx")
    pdftools.to_word(os.path.join(EX, "facture.pdf"), out)
    assert os.path.getsize(out) > 0


def test_ocr():
    src = os.path.join(EX, "facture-scannee.pdf")
    with pymupdf.open(src) as doc:
        assert pdftools.needs_ocr(doc)
    out = os.path.join(TMP, "ocr.pdf")
    pdftools.ocr_pdf(src, out)
    text = pdftools.extract_text(out)
    assert "Dupont" in text and "Papier" in text


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK", name)
