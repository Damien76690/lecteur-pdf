<img src="logo/mim-pdf.svg" alt="Mim, le chat de Mim PDF" width="96" align="right">

# Mim PDF

Petit logiciel libre pour lire, modifier, corriger un PDF et le convertir en Word ou Excel.

## Version en ligne (rien à installer)

Ouvrez **https://lecteur-pdf-libre.vercel.app** dans votre navigateur (ordinateur, tablette ou téléphone).
Le PDF est traité **dans votre navigateur** : il n'est jamais envoyé sur Internet.

Elle propose les mêmes fonctions que l'application Windows ci-dessous, y compris l'OCR (aucun logiciel à ajouter).
La première reconnaissance de texte télécharge environ 4 Mo de données de langue.

Le site est hébergé sur Vercel (projet `lecteur-pdf-libre`) ; les tests sont relancés avant chaque publication et la bloquent s'ils échouent.

## Les menus

Les commandes sont rangées dans des onglets, comme dans Word : **Fichier**, **Accueil**, **Commenter**, **Signer**, **Modifier**, **Pages** et **Convertir**.

| Fonction | Où |
|---|---|
| Ouvrir, enregistrer, imprimer, fermer | **Fichier** ou **Accueil** (Ctrl+O, Ctrl+S, Ctrl+P) |
| Rechercher un mot dans tout le document | **Accueil › Rechercher** (Ctrl+F, puis Entrée ou F3 pour l'occurrence suivante, Maj+Entrée pour la précédente) ; majuscules et accents ignorés |
| Signets du PDF, pages en miniature | **Accueil › Panneau** : onglets **Signets** et **Pages**, cliquez pour y aller |
| Copier du texte | En mode Lecture, sélectionnez le texte à la souris puis Ctrl+C |
| Plusieurs documents | Chaque PDF ouvert a son onglet (Ctrl+Tab pour passer au suivant, Ctrl+W pour fermer) |
| Deux pages côte à côte, plein écran | **Accueil › Deux pages**, **⛶** (F11) ; Ctrl + molette pour zoomer |
| Documents récents (application Windows) | Page d'accueil ou **Fichier › Récents** |
| Annuler, rétablir | **Accueil** (Ctrl+Z, Ctrl+Y) |
| Zoom, largeur de page, page entière, aller à une page | **Accueil** |
| Surligner, souligner, barrer du texte | **Commenter**, puis faites glisser sur le texte |
| Note, zone de texte, crayon, rectangle, ellipse, flèche, tampon (Approuvé, Payé…) | **Commenter** ; **Liste** affiche, modifie et supprime les commentaires |
| Signer, parapher, dater | **Signer** : dessinez, tapez ou importez votre signature une fois, puis cliquez sur la page |
| Écrire sur la page (taille et couleur réglables) | **Modifier › Écrire**, puis cliquez à l'endroit voulu |
| Corriger un texte | **Modifier** : Rechercher / Remplacer par, puis **Remplacer** (toutes les occurrences) |
| Effacer une zone | **Modifier › Effacer une zone**, puis tracez un rectangle (le contenu est réellement supprimé) |
| PDF scanné → texte | **Modifier › Reconnaître le texte** : le PDF devient sélectionnable, modifiable et convertible. Les boutons Word, Excel et Texte le font d'eux-mêmes sur un scan, et chaque montant est relu une seconde fois, seul, en chiffres, puis chaque libellé peu sûr ligne par ligne |
| Pivoter, supprimer une page | **Pages**, ou boutons ⟳ et 🗑 en haut à droite de chaque page |
| Changer l'ordre des pages | Glissez une miniature du panneau **Pages** à sa nouvelle place |
| Un PDF par partie (Bilan, Compte de résultat, Annexe…) | **Pages › Découper par signets** : cochez les signets qui commencent chaque partie (dossier choisi dans l'application Windows, fichier ZIP en ligne) |
| Un seul tableau vers Excel | **Convertir › Tableau vers Excel**, puis encadrez le tableau sur la page (un scan est lu automatiquement) |
| Synthèse par Copilot | **Synthèse › Envoyer à Copilot** : Mim PDF copie votre demande et le texte du document, puis ouvre Copilot ; collez (Ctrl+V) et envoyez. Le texte part alors chez Microsoft |
| Résumé sur ce PC | **Synthèse › Résumé rapide** : phrases clés, montants et dates, instantané. **Synthèse › Résumé IA** : synthèse rédigée par un modèle libre (Qwen) qui tourne sur l'ordinateur ; il est téléchargé une seule fois (1,2 Go, ou 0,5 Go sans carte graphique compatible), le document n'est jamais envoyé, c'est gratuit |
| PDF signé (Docusign, certificat…) | Un bandeau le signale dès l'ouverture : vert si le document est intact, rouge s'il a été modifié après la signature (**Détails** pour en savoir plus) |
| Ajouter une page blanche, insérer un autre PDF, fusionner | **Pages › Page blanche / Insérer un PDF / Fusionner** (insérer : après la page affichée ; fusionner : à la fin) |
| Extraire des pages dans un nouveau PDF | **Pages › Extraire des pages**, puis par exemple `1-3, 5` : le résultat s'ouvre dans un nouvel onglet |
| Numéroter les pages, poser un filigrane | **Pages › Numéroter** (position, « Page 1 / 10 »…, première page numérotée) et **Pages › Filigrane** (CONFIDENTIEL, COPIE…) |
| Remplir un formulaire PDF | Cliquez dans un champ (zones bleutées) et tapez, Tab pour passer au suivant ; cases à cocher, boutons radio et listes se règlent d'un clic |
| Ouvrir un PDF protégé par mot de passe | Mim PDF demande le mot de passe ; la copie enregistrée garde la même protection |
| Protéger un PDF | **Fichier › Protéger** : mot de passe à l'ouverture (chiffrement AES 256 bits) et/ou interdire l'impression, la copie ou les modifications |
| Signer avec un certificat (signature électronique) | **Signer › Signer avec un certificat** : choisissez votre certificat (.p12 / .pfx) et son mot de passe, puis cliquez où placer le cadre. Signature PAdES (SHA-256) lisible par Adobe Reader ; plusieurs signatures successives restent valables |
| Savoir qui a signé un PDF | **Signer › Signatures du document** : signataire, date, motif, et si le contenu a été modifié depuis |
| Convertir | **Convertir** : Word, Excel, Texte ou PDF. Dans l'Excel, les comptes annuels et liasses fiscales gardent leurs colonnes : chaque code de case et chaque montant dans sa cellule, les titres sur plusieurs lignes réunis |
| Créer un PDF à partir de photos ou de scans | Ouvrez (ou glissez) des images PNG ou JPEG : elles forment un nouveau PDF, une page par image. Ou **Convertir › PDF depuis images** |
| Enregistrer une page en image | **Convertir › Page en PNG / Page en JPEG** (150 ppp) |
| Réduire le poids d'un PDF | **Convertir › Compresser** : Écran (e-mail), Standard ou Haute qualité ; la taille avant / après s'affiche |
| Aplatir (fixer commentaires et champs remplis) | **Convertir › Aplatir** |

**PDF signés électroniquement (Docusign, certificat…)** : un bandeau le signale à l'ouverture. Les commentaires, surlignages, tampons, signatures image et champs de formulaire remplis sont ajoutés à la suite du fichier, sans toucher aux octets signés : la signature d'origine reste valable. Les autres modifications (rotation, suppression de page, texte écrit, OCR…) l'invalident dans la copie : Mim PDF prévient avant d'enregistrer.

## Application Windows (le plus simple)

1. Téléchargez **[MimPDF-installation.exe](https://github.com/Damien76690/lecteur-pdf/releases/latest/download/MimPDF-installation.exe)**.
2. Double-cliquez dessus. Si Windows affiche « Windows a protégé votre ordinateur », cliquez sur **Informations complémentaires** puis **Exécuter quand même** (l'application n'est pas encore signée).
3. Suivez les étapes : aucun droit administrateur n'est demandé. Lancez ensuite **Mim PDF** depuis le menu Démarrer ou l'icône du Bureau.

L'application affiche exactement la version en ligne, mais tout est inclus dans l'ordinateur : elle fonctionne **sans Internet**, reconnaissance de texte (OCR) en français comprise. Les fichiers sont enregistrés où vous le choisissez.
**Mises à jour automatiques :** une fois installé, Mim PDF vérifie au démarrage (puis toutes les 6 heures) s'il existe une nouvelle version. Il la télécharge en arrière-plan, affiche un bandeau « Redémarrer et mettre à jour », et sinon l'installe tout seul quand vous le fermez. Vos réglages et votre signature enregistrée sont conservés.

**Ouvrir un PDF directement :** clic droit sur un PDF > **Ouvrir avec** > **Mim PDF** (ou double-clic si vous avez choisi Mim PDF comme lecteur par défaut dans Windows). Si Mim PDF est déjà ouvert, le fichier s'ouvre dans la fenêtre existante. L'installation ne change pas votre lecteur PDF par défaut : pour l'utiliser à chaque double-clic, choisissez « Ouvrir avec » > « Choisir une autre application » > Mim PDF > « Toujours ».

Vous aviez l'ancien « Lecteur PDF libre » ? Fermez-le, puis installez Mim PDF une fois avec le lien ci-dessus : il remplace l'ancienne version (et supprime ses fichiers devenus inutiles), puis se mettra à jour seul.

Une version sans installation existe aussi : [MimPDF-portable.zip](https://github.com/Damien76690/lecteur-pdf/releases/latest/download/MimPDF-portable.zip) (décompressez, puis double-cliquez sur `MimPDF.exe`). Elle ne se met pas à jour toute seule.

## Pour les développeurs

Une seule base de code pour les deux versions : `web/` (`core.js` = traitements, `app.js` = interface).

- `npm ci && npm test` lance les tests, `npm run build` prépare le site dans `dist/` (publié sur Vercel).
- Application de bureau : `npm run build -- build/site`, puis `pip install -r requirements-bureau.txt` et `python bureau.py`.

## Fabrication de l'application Windows

Elle est compilée automatiquement par GitHub (fichier `.github/workflows/windows.yml`) à chaque modification de la branche `main`, puis publiée dans **Releases**. `bureau.py` sert le site `build/site` sur l'ordinateur (127.0.0.1 uniquement) et l'affiche dans une fenêtre. Recette : `windows/mim-pdf.spec` (PyInstaller) et `windows/installateur.iss` (Inno Setup). Chaque version est numérotée `1.0.<numéro de compilation>` (fichier `version.json` ajouté au site) ; l'application installée compare ce numéro à la dernière version publiée dans Releases.

Le logo (`logo/mim-pdf.svg`) est un dessin original ; `windows/icone.ico` et les icônes du site (`web/favicon.svg`, `web/icone-*.png`) en sont tirés.

## En ligne de commande (optionnel, Python)

`pip install -r requirements.txt` (et Tesseract pour l'OCR), puis :

```
python pdftools.py word   document.pdf
python pdftools.py excel  document.pdf
python pdftools.py ocr    scan.pdf
python pdftools.py remplacer document.pdf "ancien" "nouveau"
```

## Bon à savoir

- **Signature** : c'est une image posée sur le document. Elle convient pour un document courant mais n'a pas la valeur d'une signature électronique qualifiée (contrat engageant). Elle est mémorisée uniquement sur votre appareil.
- **Commentaires** : ce sont des annotations PDF standard, visibles et modifiables dans Adobe Reader, Edge, Chrome, etc.

- **Excel** : chaque tableau trouvé devient une feuille, les nombres « 1 234,56 » deviennent de vrais nombres. Sans tableau, le texte est mis en colonnes dans une feuille « Texte ».
- **Remplacer** écrit le nouveau texte en Helvetica à la même taille et couleur : la police d'origine n'est pas toujours conservée.
- **OCR** : vérifiez les chiffres importants (ex. « 3,75 » peut être lu « 9:75 » sur un scan de mauvaise qualité).
- Pour un scan, lancez l'OCR **avant** de remplacer du texte (la conversion en Excel/Word/Texte le lance toute seule).

## Briques libres utilisées

Version en ligne : MuPDF (AGPL), pdf-lib (MIT), Tesseract.js (Apache 2.0), SheetJS (Apache 2.0), docx (MIT).

Version à installer : PyMuPDF (AGPL), pdfplumber (MIT), pdf2docx (AGPL), openpyxl (MIT), Flask (BSD), Tesseract (Apache 2.0). Le projet doit donc être diffusé sous licence **AGPL-3.0** s'il est publié.
