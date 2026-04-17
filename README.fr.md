<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.md">English</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ollama-intern-mcp/readme.png" alt="Ollama Intern MCP" width="500">
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/ollama-intern-mcp/actions"><img alt="CI" src="https://github.com/mcp-tool-shop-org/ollama-intern-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://mcp-tool-shop-org.github.io/ollama-intern-mcp/"><img alt="Landing Page" src="https://img.shields.io/badge/landing-page-8b5cf6"></a>
  <a href="https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/"><img alt="Handbook" src="https://img.shields.io/badge/handbook-docs-10b981"></a>
</p>

> **L'assistant local pour Claude Code.** 28 outils structurés, rapports basés sur des preuves, artefacts durables.

Un serveur MCP qui fournit à Claude Code un **assistant local** avec des règles, des niveaux, un bureau et un classeur. Claude choisit l' _outil_ ; l'outil choisit le _niveau_ (Instantané / Polyvalent / Approfondi / Intégration) ; le niveau écrit un fichier que vous pourrez ouvrir la semaine prochaine.

Pas de cloud. Pas de télémétrie. Rien d'"autonome". Chaque appel montre son travail.

---

## Exemple principal — un appel, un artefact

```jsonc
// Claude → ollama-intern-mcp
{
  "tool": "ollama_incident_pack",
  "arguments": {
    "title": "sprite pipeline 5 AM paging regression",
    "logs": "[2026-04-16 05:07] worker-3 OOM killed\n[2026-04-16 05:07] ollama /api/ps reports evicted=true size=8.1GB\n...",
    "source_paths": ["F:/AI/sprite-foundry/src/worker.ts", "memory/sprite-foundry-visual-mastery.md"]
  }
}
```

Renvoie une enveloppe pointant vers un fichier sur le disque :

```jsonc
{
  "result": {
    "pack": "incident",
    "slug": "2026-04-16-sprite-pipeline-5-am-paging-regression",
    "artifact_md":   "~/.ollama-intern/artifacts/incident/2026-04-16-sprite-pipeline-5-am-paging-regression.md",
    "artifact_json": "~/.ollama-intern/artifacts/incident/2026-04-16-sprite-pipeline-5-am-paging-regression.json",
    "weak": false,
    "evidence_count": 6,
    "next_checks": ["residency.evicted across last 24h", "OLLAMA_MAX_LOADED_MODELS vs loaded size"]
  },
  "tier_used": "deep",
  "model": "qwen2.5:14b-instruct-q4_K_M",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

Ce fichier Markdown est la sortie du bureau de l'assistant — titres, bloc de preuves avec identifiants cités, instructions d'investigation `next_checks`, bannière `faible : vrai` si les preuves sont limitées. Il est déterministe : le rendu est du code, pas une invite. Ouvrez-le demain, comparez-le la semaine prochaine, exportez-le dans un manuel avec `ollama_artifact_export_to_path`.

Chaque concurrent dans cette catégorie commence par "économiser les jetons". Nous commençons par _voici le fichier que l'assistant a écrit_.

---

## Ce qu'il y a ici — quatre niveaux, 28 outils

| Niveau | Nombre | Ce qui se trouve ici |
|---|---|---|
| **Atoms** | 15 | Primitives structurées. `classifier`, `extraire`, `trier_journaux`, `résumer_rapide` / `approfondi`, `brouillon`, `recherche`, `recherche_corpus` / `répondre` / `indexer` / `actualiser` / `lister`, `recherche_intégration`, `intégration`, `chat`. Les opérations par lots (`classifier`, `extraire`, `trier_journaux`) acceptent `items: [{id, text}]`. |
| **Briefs** | 3 | Rapports structurés basés sur des preuves. `rapport_incident`, `rapport_dépôt`, `rapport_modification`. Chaque affirmation cite un identifiant de preuve ; les inconnues sont supprimées côté serveur. Les preuves faibles affichent `faible : vrai` plutôt qu'une narration fausse. |
| **Packs** | 3 | Tâches composées avec un pipeline fixe qui écrit du Markdown + JSON durables dans `~/.ollama-intern/artifacts/`. `paquet_incident`, `paquet_dépôt`, `paquet_modification`. Rendu déterministe — aucun appel de modèle sur la forme de l'artefact. |
| **Artifacts** | 7 | Interface de continuité sur les sorties des paquets. `liste_artefacts` / `lire` / `différencier` / `exporter_vers_chemin`, plus trois extraits déterministes : `note_incident`, `section_intégration`, `note_version`. |

Total : **18 primitives + 3 paquets + 7 outils d'artefact = 28**.

Lignes figées :
- Les primitives sont figées à 18 (primitives + rapports). Aucun nouvel outil de primitive.
- Les paquets sont figés à 3. Aucun nouveau type de paquet.
- Le niveau d'artefact est figé à 7.

La référence complète des outils se trouve dans le [manuel](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/).

---

## Installation

```bash
npm install -g ollama-intern-mcp
```

Nécessite [Ollama](https://ollama.com) installé localement et les modèles de niveau téléchargés.

### Claude Code

```json
{
  "mcpServers": {
    "ollama-intern": {
      "command": "npx",
      "args": ["-y", "ollama-intern-mcp"],
      "env": {
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}
```

### Claude Desktop

Le même bloc, écrit dans `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Téléchargement des modèles

**Profil de développement par défaut (RTX 5080 16 Go et similaire) :**

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
```

**Profil M5 Max (128 Go unifiés) :**

```bash
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
ollama pull llama3.3:70b-instruct-q4_K_M
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

Les variables d'environnement par niveau (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) remplacent toujours les choix de profil pour les cas ponctuels.

---

## Enveloppe uniforme

Chaque outil renvoie la même structure :

```ts
{
  result: <tool-specific>,
  tier_used: "instant" | "workhorse" | "deep" | "embed",
  model: string,
  hardware_profile: string,     // "dev-rtx5080" | "dev-rtx5080-llama" | "m5-max"
  tokens_in: number,
  tokens_out: number,
  elapsed_ms: number,
  residency: {
    in_vram: boolean,
    size_bytes: number,
    size_vram_bytes: number,
    evicted: boolean
  } | null
}
```

`résidence` provient de l'API Ollama `/api/ps`. Lorsque `évincé : vrai` ou `taille_vram < taille`, le modèle est paginé sur le disque et l'inférence est réduite de 5 à 10 fois — affichez cela à l'utilisateur pour qu'il sache de redémarrer Ollama ou de réduire le nombre de modèles chargés.

Chaque appel est enregistré sous forme d'une seule ligne NDJSON dans `~/.ollama-intern/log.ndjson`. Filtrez par `hardware_profile` pour empêcher les chiffres de développement d'être inclus dans les benchmarks publiés.

---

## Profils matériels

| Profil | Instantané | Polyvalent | Approfondi | Intégration |
|---|---|---|---|---|
| **`dev-rtx5080`** (par défaut) | qwen2.5 7B | qwen2.5-coder 7B | qwen2.5 14B | nomic-embed-text |
| `dev-rtx5080-llama` | qwen2.5 7B | qwen2.5-coder 7B | **llama3.1 8B** | nomic-embed-text |
| `m5-max` | qwen2.5 14B | qwen2.5-coder 32B | llama3.3 70B | nomic-embed-text |

**Comparaison au sein de la même famille sur l'environnement de développement par défaut** : les résultats médiocres sont donc des problèmes de conception ou d'outils, et non des incompatibilités entre différentes familles de modèles. `dev-rtx5080-llama` est la référence : exécutez les mêmes évaluations de référence avec Llama 8B avant de déployer Llama sur M5 Max.

---

## Principes directeurs

Ces règles sont appliquées côté serveur, et non dans la requête :

- **Citations obligatoires.** Chaque affirmation est étayée par un identifiant de source.
- **Informations inconnues supprimées côté serveur.** Les modèles qui citent des identifiants qui ne figurent pas dans le paquet de sources voient ces identifiants supprimés, avec un avertissement, avant que le résultat ne soit renvoyé.
- **"Faible" signifie "faible".** Les sources de qualité inférieure sont marquées `weak: true` avec des notes explicatives. Elles ne sont jamais "améliorées" pour créer une narration artificielle.
- **Axé sur l'investigation, pas sur la prescription.** Seuls les éléments `next_checks` / `read_next` / `likely_breakpoints` sont autorisés. Les requêtes qui demandent "appliquer cette correction" sont interdites.
- **Rendu déterministe.** La forme du balisage des artefacts est du code, et non une requête. `draft` est réservé aux textes où la formulation du modèle est importante.
- **Comparaisons au sein du même paquet uniquement.** Les comparaisons `artifact_diff` entre différents paquets sont refusées ; les charges utiles restent distinctes.

---

## Artefacts et continuité

Les paquets écrivent dans `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. La couche d'artefacts vous offre une continuité sans en faire un outil de gestion de fichiers :

- `artifact_list` — index contenant uniquement des métadonnées, filtrable par paquet, date, motif de slug
- `artifact_read` — lecture typée par `{pack, slug}` ou `{json_path}`
- `artifact_diff` — comparaison structurée au sein du même paquet ; les modifications de qualité inférieure sont signalées
- `artifact_export_to_path` — écrit un artefact existant (avec un en-tête de provenance) dans un répertoire déclaré par l'appelant (`allowed_roots`). Refuse les fichiers existants, sauf si `overwrite: true`.
- `artifact_incident_note_snippet` — fragment de note d'incident
- `artifact_onboarding_section_snippet` — fragment de guide d'utilisation
- `artifact_release_note_snippet` — fragment de note de version (DRAFT)

Aucun appel de modèle dans cette couche. Tout est généré à partir de contenu stocké.

---

## Modèle de menace et télémétrie

**Données traitées :** chemins de fichiers que l'appelant fournit explicitement (`ollama_research`, outils de corpus), texte intégré et artefacts que l'appelant demande d'être écrits dans `~/.ollama-intern/artifacts/` ou dans un répertoire déclaré par l'appelant (`allowed_roots`).

**Données NON traitées :** tout ce qui se trouve en dehors de `source_paths` / `allowed_roots`. `..` est rejeté avant la normalisation. `artifact_export_to_path` refuse les fichiers existants, sauf si `overwrite: true`. Les brouillons ciblant les chemins protégés (`memory/`, `.claude/`, `docs/canon/`, etc.) nécessitent une confirmation explicite (`confirm_write: true`), qui est appliquée côté serveur.

**Trafic sortant :** **désactivé par défaut.** Le seul trafic sortant est vers le point de terminaison HTTP local d'Ollama. Aucun appel cloud, aucun ping de mise à jour, aucun rapport de crash.

**Télémétrie :** **aucune.** Chaque appel est enregistré sous forme d'une seule ligne NDJSON dans `~/.ollama-intern/log.ndjson` sur votre machine. Rien ne quitte l'appareil.

**Erreurs :** format structuré `{ code, message, hint, retryable }`. Les traces de pile ne sont jamais exposées dans les résultats des outils.

Politique complète : [SECURITY.md](SECURITY.md).

---

## Normes

Conçu selon les normes [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). Les tests A à D doivent être réussis ; voir [SHIP_GATE.md](SHIP_GATE.md) et [SCORECARD.md](SCORECARD.md).

- **A. Sécurité** — SECURITY.md, modèle de menace, pas de télémétrie, sécurité des chemins, `confirm_write` pour les chemins protégés
- **B. Erreurs** — format structuré pour tous les résultats des outils ; pas de piles brutes
- **C. Documentation** — README à jour, CHANGELOG, LICENSE ; schémas des outils auto-documentés
- **D. Hygiène** — `npm run verify` (395 tests), CI avec analyse des dépendances, Dependabot, fichier de verrouillage, `engines.node`

---

## Plan d'action (renforcement de la sécurité, et non extension des fonctionnalités)

- **Phase 1 — Infrastructure de délégation** ✓ Livré : interface atomique, enveloppe uniforme, routage par niveaux, mécanismes de sécurité.
- **Phase 2 — Infrastructure de vérification** ✓ Livré : segmentation de schéma v2, BM25 + RRF, corpus dynamiques, résumés étayés par des preuves, ensemble d'outils d'évaluation de la récupération.
- **Phase 3 — Infrastructure de regroupement et d'artefacts** ✓ Livré : ensembles de données avec artefacts durables + niveau de continuité.
- **Phase 4 — Infrastructure d'adoption (du produit)** — Observations d'utilisation réelle sur le RTX 5080, correction des aspects problématiques qui apparaissent.
- **Phase 5 — Tests de performance du M5 Max** — Publication des résultats une fois que le matériel est disponible (environ le 24 avril 2026).

Phase par couche de renforcement de la sécurité. L'interface atomique/de regroupement/d'artefacts reste figée.

---

## Licence

MIT — voir [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
