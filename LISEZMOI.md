# Lecteur PDF libre

Petit logiciel libre qui tourne **sur votre ordinateur** (rien n'est envoyé sur Internet) et s'utilise dans le navigateur.

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

PyMuPDF (AGPL), pdfplumber (MIT), pdf2docx (AGPL), openpyxl (MIT), Flask (BSD), Tesseract (Apache 2.0). Le projet doit donc être diffusé sous licence **AGPL-3.0** s'il est publié.
