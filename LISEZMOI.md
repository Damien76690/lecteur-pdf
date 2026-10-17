# Lecteur PDF libre

Petit logiciel libre pour lire, modifier, corriger un PDF et le convertir en Word ou Excel.

## Version en ligne (rien à installer)

Ouvrez **https://lecteur-pdf-libre.vercel.app** dans votre navigateur (ordinateur, tablette ou téléphone).
Le PDF est traité **dans votre navigateur** : il n'est jamais envoyé sur Internet.

Elle propose les mêmes fonctions que l'application Windows ci-dessous, y compris l'OCR (aucun logiciel à ajouter).
La première reconnaissance de texte télécharge environ 4 Mo de données de langue.

Le site est hébergé sur Vercel (projet `lecteur-pdf-libre`) ; les tests sont relancés avant chaque publication et la bloquent s'ils échouent.

## Les menus

Les commandes sont rangées dans des onglets, comme dans Word : **Fichier**, **Accueil**, **Modifier**, **Pages** et **Convertir**.

| Fonction | Où |
|---|---|
| Ouvrir, enregistrer, fermer | **Fichier** ou **Accueil** (Ctrl+O, Ctrl+S) |
| Annuler, rétablir | **Accueil** (Ctrl+Z, Ctrl+Y) |
| Zoom, largeur de page, page entière, aller à une page | **Accueil** |
| Écrire sur la page (taille et couleur réglables) | **Modifier › Écrire**, puis cliquez à l'endroit voulu |
| Corriger un texte | **Modifier** : Rechercher / Remplacer par, puis **Remplacer** (toutes les occurrences) |
| Effacer une zone | **Modifier › Effacer une zone**, puis tracez un rectangle (le contenu est réellement supprimé) |
| PDF scanné → texte | **Modifier › Reconnaître le texte** : le PDF devient sélectionnable, modifiable et convertible |
| Pivoter, supprimer une page | **Pages**, ou boutons ⟳ et 🗑 en haut à droite de chaque page |
| Convertir | **Convertir** : Word, Excel, Texte ou PDF |

## Application Windows (le plus simple)

1. Téléchargez **[LecteurPDF-installation.exe](https://github.com/Damien76690/lecteur-pdf/releases/latest/download/LecteurPDF-installation.exe)**.
2. Double-cliquez dessus. Si Windows affiche « Windows a protégé votre ordinateur », cliquez sur **Informations complémentaires** puis **Exécuter quand même** (l'application n'est pas encore signée).
3. Suivez les étapes : aucun droit administrateur n'est demandé. Lancez ensuite **Lecteur PDF libre** depuis le menu Démarrer ou l'icône du Bureau.

L'application affiche exactement la version en ligne, mais tout est inclus dans l'ordinateur : elle fonctionne **sans Internet**, reconnaissance de texte (OCR) en français comprise. Les fichiers sont enregistrés où vous le choisissez.
Une version sans installation existe aussi : [LecteurPDF-portable.zip](https://github.com/Damien76690/lecteur-pdf/releases/latest/download/LecteurPDF-portable.zip) (décompressez, puis double-cliquez sur `LecteurPDF.exe`).

## Pour les développeurs

Une seule base de code pour les deux versions : `web/` (`core.js` = traitements, `app.js` = interface).

- `npm ci && npm test` lance les tests, `npm run build` prépare le site dans `dist/` (publié sur Vercel).
- Application de bureau : `npm run build -- build/site`, puis `pip install -r requirements-bureau.txt` et `python bureau.py`.

## Fabrication de l'application Windows

Elle est compilée automatiquement par GitHub (fichier `.github/workflows/windows.yml`) à chaque modification de la branche `main`, puis publiée dans **Releases**. `bureau.py` sert le site `build/site` sur l'ordinateur (127.0.0.1 uniquement) et l'affiche dans une fenêtre. Recette : `windows/lecteur-pdf.spec` (PyInstaller) et `windows/installateur.iss` (Inno Setup).

## En ligne de commande (optionnel, Python)

`pip install -r requirements.txt` (et Tesseract pour l'OCR), puis :

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

## Briques libres utilisées

Version en ligne : MuPDF (AGPL), pdf-lib (MIT), Tesseract.js (Apache 2.0), SheetJS (Apache 2.0), docx (MIT).

Version à installer : PyMuPDF (AGPL), pdfplumber (MIT), pdf2docx (AGPL), openpyxl (MIT), Flask (BSD), Tesseract (Apache 2.0). Le projet doit donc être diffusé sous licence **AGPL-3.0** s'il est publié.
