# Lecteur PDF libre

Petit logiciel libre pour lire, modifier, corriger un PDF et le convertir en Word ou Excel.

## Version en ligne (rien à installer)

Ouvrez **https://lecteur-pdf-libre.vercel.app** dans votre navigateur (ordinateur, tablette ou téléphone).
Le PDF est traité **dans votre navigateur** : il n'est jamais envoyé sur Internet.

Elle propose les mêmes fonctions que la version à installer ci-dessous, y compris l'OCR (aucun logiciel à ajouter).
La première reconnaissance de texte télécharge environ 4 Mo de données de langue.

Pour les développeurs : le code est dans `web/` (`core.js` = traitements, `app.js` = interface).
`npm ci && npm test` lance les tests, `npm run build` prépare le site dans `dist/`.
Chaque modification fusionnée dans `main` est publiée automatiquement.

## Version à installer (Python)

Elle tourne **sur votre ordinateur** et s'utilise aussi dans le navigateur.

| Fonction | Comment |
|---|---|
| Écrire sur un PDF | Bouton **Écrire**, puis cliquez à l'endroit voulu (taille et couleur réglables) |
| Corriger un texte | Champs **Rechercher / Remplacer par**, puis **Remplacer** (toutes les occurrences) |
| Effacer une zone | **Effacer une zone**, puis tracez un rectangle (le contenu est réellement supprimé) |
| Pivoter / supprimer une page | Boutons ⟳ et 🗑 en haut à droite de chaque page |
| Annuler | **↶ Annuler** (autant de fois que nécessaire) |
| PDF scanné → texte | **Reconnaître le texte (OCR)** : le PDF devient sélectionnable, modifiable et convertible |
| Convertir | **Enregistrer : PDF / Word / Excel / Texte** |

## Installation (une seule fois)

1. Installez **Python 3** : https://www.python.org/downloads/ (sous Windows, cochez « Add Python to PATH »).
2. Pour l'OCR, installez **Tesseract** avec la langue française :
   - Windows : installeur « UB Mannheim » https://github.com/UB-Mannheim/tesseract/wiki (cochez *French* dans « Additional language data »).
   - Mac : `brew install tesseract tesseract-lang`
   - Linux : `sudo apt install tesseract-ocr tesseract-ocr-fra`

## Lancement

- Windows : double-cliquez sur `lancer-windows.bat`
- Mac / Linux : `./lancer-mac-linux.sh`

La première fois, les composants s'installent (une minute environ). Le navigateur s'ouvre ensuite sur http://127.0.0.1:5000. Fermez la fenêtre noire pour arrêter.

## En ligne de commande (optionnel)

```
python pdftools.py word   document.pdf
python pdftools.py excel  document.pdf
python pdftools.py ocr    scan.pdf
python pdftools.py remplacer document.pdf "ancien" "nouveau"
```

## Bon à savoir

- **Excel** : chaque tableau trouvé devient une feuille, les nombres « 1 234,56 » deviennent de vrais nombres. Sans tableau, le texte est mis en colonnes dans une feuille « Texte ».
- **Remplacer** écrit le nouveau texte en Helvetica à la même taille et couleur : la police d'origine n'est pas toujours conservée.
- **OCR** : vérifiez les chiffres importants (ex. « 3,75 » peut être lu « 9:75 » sur un scan de mauvaise qualité).
- Pour un scan, lancez l'OCR **avant** de remplacer du texte ou de convertir en Excel/Word.
- Les fichiers de travail sont dans le dossier `travail/` ; vous pouvez le vider quand vous voulez.

## Briques libres utilisées

Version en ligne : MuPDF (AGPL), pdf-lib (MIT), Tesseract.js (Apache 2.0), SheetJS (Apache 2.0), docx (MIT).

Version à installer : PyMuPDF (AGPL), pdfplumber (MIT), pdf2docx (AGPL), openpyxl (MIT), Flask (BSD), Tesseract (Apache 2.0). Le projet doit donc être diffusé sous licence **AGPL-3.0** s'il est publié.
