# Recette PyInstaller de l'application Windows (utilisée par .github/workflows/windows.yml).
# L'application affiche la version en ligne : le site est préparé avant dans build/site
# (npm run build -- build/site), OCR et langues compris.
import os

RACINE = os.path.abspath(os.path.join(SPECPATH, ".."))
SITE = os.path.join(RACINE, "build", "site")
assert os.path.isfile(os.path.join(SITE, "index.html")), "lancez d'abord : npm run build -- build/site"

donnees = [
    (SITE, "site"),
    (os.path.join(RACINE, "LICENSE"), "."),
]

a = Analysis(
    [os.path.join(RACINE, "bureau.py")],
    pathex=[RACINE],
    datas=donnees,
    hiddenimports=["webview.platforms.edgechromium", "webview.platforms.winforms"],
    excludes=["tkinter", "matplotlib", "IPython", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="MimPDF",
    icon=os.path.join(SPECPATH, "icone.ico"),
    console=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="MimPDF")
