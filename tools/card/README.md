# Vérification de la carte

Outils de développement uniquement, exclus des fichiers servis. Node.js 22 ou 24
et Chromium sont requis. Les dépendances directes et transitives sont verrouillées
dans `package-lock.json` ; exécuter depuis la racine du dépôt :

```sh
npm --prefix tools/card ci --ignore-scripts
node tools/card/node_modules/playwright/cli.js install --with-deps chromium
node tools/card/check-card.mjs --root propositions/carte-visite
```

Dans l'export autonome, les outils gardent le même emplacement ; remplacer la
dernière commande par `node tools/card/check-card.mjs --root .`.
Sous Windows, utiliser éventuellement un Chrome déjà installé :

```powershell
$env:CARD_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tools/card/check-card.mjs --root propositions/carte-visite
```

Le serveur de test écoute uniquement sur une adresse de boucle locale et sert
une liste de ressources explicite sous `/card/`. Aucun service public n'est appelé
pendant les tests. Le test vérifie UTF-8, syntaxe JavaScript, ressources et liens,
CSP, téléchargement réel de la vCard avec e-mail unique, QR Contact et Lien décodés
indépendamment depuis les pixels rendus, affichages mobile et bureau, réduction
des animations, coordonnées sans JavaScript et pannes de la bibliothèque QR.
Une erreur produit un code de sortie 1, y compris si l'environnement est incomplet.

Les coordonnées sont lues depuis le HTML et comparées en mémoire ; les rapports
ne contiennent que noms de contrôles et statuts. Aucun fichier vCard, image,
trace ou contenu QR n'est conservé. Les téléchargements temporaires sont supprimés
avec le contexte Playwright. La suite ne remplace pas une vérification manuelle
de lecteur d'écran, un import sur téléphone ou les contrôles de conformité A2.

## Dépendances et limites

Versions `latest` vérifiées sur le registre primaire npm le 21 octobre 2026 :

| Outil | Version | Licence | Usage |
| --- | --- | --- | --- |
| Playwright | 1.64.1 | Apache-2.0 | Navigateur Chromium et téléchargements |
| jsQR | 1.4.0 | Apache-2.0 | Décodage indépendant du QR effectivement rendu |
| pngjs | 7.0.0 | MIT | Lecture du PNG de capture uniquement en mémoire |

Playwright exige Node >=20 ; le projet de tests exige >=22. jsQR et pngjs sont
les dernières versions publiées, mais ont une cadence faible (pngjs publié en
2023). Cela ne prouve aucune garantie de support : revue des alertes par
`npm --prefix tools/card audit`, entrées locales bornées, absence de runtime public
et réévaluation avant toute mise à jour sont nécessaires. Leur usage doit être
couvert par la décision technologique et l'exception de livraison du projet.
Les bibliothèques sont remplaçables sans modifier la carte ; aucune dépendance
de test n'est chargée par le navigateur public.

Les dépendances restent des outils exécutables sur le poste/runner. `npm ci`
doit être exécuté dans un environnement sans secrets de production. Les paquets
et intégrités attendues proviennent de `registry.npmjs.org`. L'installation
Chromium est distincte et utilise la version associée au Playwright verrouillé.
