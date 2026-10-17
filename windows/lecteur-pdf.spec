# Recette PyInstaller de l'application Windows (utilisée par .github/workflows/windows.yml).
# Le dossier build/tesseract (Tesseract + langues fra/eng) est préparé avant la compilation.
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

RACINE = os.path.abspath(os.path.join(SPECPATH, ".."))
TESSERACT = os.path.join(RACINE, "build", "tesseract")

donnees = [
    (os.path.join(RACINE, "templates"), "templates"),
    (os.path.join(RACINE, "exemples"), "exemples"),
    (os.path.join(RACINE, "LICENSE"), "."),
]
if os.path.isdir(TESSERACT):
    donnees.append((TESSERACT, "tesseract"))
donnees += collect_data_files("pdfminer") + collect_data_files("pdf2docx")

a = Analysis(
    [os.path.join(RACINE, "bureau.py")],
    pathex=[RACINE],
    datas=donnees,
    hiddenimports=collect_submodules("pdf2docx") + ["webview.platforms.edgechromium",
                                                    "webview.platforms.winforms"],
    excludes=["tkinter", "matplotlib", "IPython", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="LecteurPDF",
    icon=os.path.join(SPECPATH, "icone.ico"),
    console=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="LecteurPDF")
