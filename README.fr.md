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

Un serveur MCP qui fournit à Claude Code un **assistant local** avec des règles, des niveaux, un bureau et un classeur. Claude choisit l' _outil_ ; l'outil choisit le _niveau_ (Instantané / Polyvalent / Approfondi / Intégré) ; le niveau écrit un fichier que vous pourrez ouvrir la semaine prochaine.

Pas de cloud. Pas de télémétrie. Rien d'"autonome". Chaque appel montre son travail.

---

## Exemple principal : un appel, un artefact

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
  "model": "hermes3:8b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

Ce fichier Markdown est la sortie du bureau de l'assistant : titres, bloc de preuves avec identifiants cités, instructions d'investigation `next_checks`, bannière `faible : vrai` si les preuves sont limitées. Il est déterministe : le rendu est du code, pas une invite. Ouvrez-le demain, comparez-le la semaine prochaine, exportez-le dans un manuel avec `ollama_artifact_export_to_path`.

Chaque concurrent dans cette catégorie commence par "économiser les jetons". Nous commençons par _voici le fichier que l'assistant a écrit_.

---

## Ce qu'il contient : quatre niveaux, 28 outils

| Niveau | Nombre | Ce qui s'y trouve |
|---|---|---|
| **Atoms** | 15 | Primitives structurées. `classifier`, `extraire`, `trier_journaux`, `résumer_rapide` / `approfondi`, `brouillon`, `recherche`, `recherche_corpus` / `répondre` / `indexer` / `actualiser` / `lister`, `recherche_intégrée`, `intégrer`, `chat`. Les opérations par lots (`classifier`, `extraire`, `trier_journaux`) acceptent `items: [{id, text}]`. |
| **Briefs** | 3 | Rapports structurés basés sur des preuves. `rapport_incident`, `rapport_dépôt`, `rapport_modification`. Chaque affirmation cite un identifiant de preuve ; les inconnues sont supprimées côté serveur. Les preuves faibles affichent `faible : vrai` plutôt qu'une narration fausse. |
| **Packs** | 3 | Tâches composées avec un pipeline fixe qui écrit du Markdown + JSON durables dans `~/.ollama-intern/artifacts/`. `paquet_incident`, `paquet_dépôt`, `paquet_modification`. Rendu déterministe : aucun appel de modèle sur la forme de l'artefact. |
| **Artifacts** | 7 | Interface de continuité sur les sorties des paquets. `liste_artefacts` / `lire` / `différencier` / `exporter_vers_chemin`, plus trois extraits déterministes : `note_incident`, `section_intégration`, `note_version`. |

Total : **18 primitives + 3 paquets + 7 outils d'artefact = 28**.

Lignes figées :
- Les primitives sont figées à 18 (primitives + rapports). Aucun nouvel outil de primitive.
- Les paquets sont figés à 3. Aucun nouveau type de paquet.
- Le niveau d'artefact est figé à 7.

La référence complète des outils se trouve dans le [manuel](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/).

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

### Utilisation avec Hermes

Ce MCP a été validé de bout en bout avec [Hermes Agent](https://github.com/NousResearch/Hermes) contre `hermes3:8b` sur Ollama (2026-04-19). Hermes est un agent externe qui *appelle* cette surface de primitives figée du MCP ; il effectue la planification, nous effectuons le travail.

Configuration de référence ([hermes.config.example.yaml](hermes.config.example.yaml) dans ce dépôt) :

```yaml
model:
  provider: custom
  base_url: http://localhost:11434/v1
  default: hermes3:8b
  context_length: 65536    # Hermes requires 64K floor under model.*

providers:
  local-ollama:
    name: local-ollama
    base_url: http://localhost:11434/v1
    api_mode: openai_chat
    api_key: ollama
    model: hermes3:8b

mcp_servers:
  ollama-intern:
    command: npx
    args: ["-y", "ollama-intern-mcp"]
    env:
      OLLAMA_HOST: http://localhost:11434
      INTERN_PROFILE: dev-rtx5080
      # hermes3:8b is the default ladder in v2.0.0, so tier overrides are
      # only needed if you're pinning a different local model.
```

**La forme de l'invite est importante.** Les invites d'invocation d'outils impératives ("Appeler X avec les arguments...") sont le test d'intégration ; elles fournissent à un modèle local de 8 Go suffisamment de structure pour générer des `tool_calls` propres. Les invites multi-tâches en forme de liste ("faire A, puis B, puis C") sont des références de performances pour les modèles plus importants ; n'interprétez pas un échec en forme de liste sur un modèle de 8 Go comme "le câblage est cassé". Consultez [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) pour la visite guidée complète de l'intégration et les limitations de transport connues (streaming Ollama `/v1` + shim non-streaming openai-SDK).

### Téléchargements de modèles

**Profil de développement par défaut (RTX 5080 16 Go et équivalent) :**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Environnement alternatif Qwen 3 (même matériel, pour les outils Qwen) :**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**Profil M5 Max (128 Go unifiés) :**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

Les variables d'environnement par niveau (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) continuent de remplacer les choix de profil pour les cas ponctuels.

---

## Enveloppe uniforme

Chaque outil renvoie la même structure :

```ts
{
  result: <tool-specific>,
  tier_used: "instant" | "workhorse" | "deep" | "embed",
  model: string,
  hardware_profile: string,     // "dev-rtx5080" | "dev-rtx5080-qwen3" | "m5-max"
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

La "résidence" provient de `/api/ps` d'Ollama. Si `evicted: true` ou `size_vram < size`, le modèle est déchargé sur le disque et la vitesse d'inférence diminue de 5 à 10 fois. Cette information est affichée à l'utilisateur pour qu'il sache de redémarrer Ollama ou de réduire le nombre de modèles chargés.

Chaque appel est enregistré sous forme d'une ligne NDJSON dans `~/.ollama-intern/log.ndjson`. Filtrez par `hardware_profile` pour éviter que les données de développement ne soient incluses dans les benchmarks publiés.

---

## Profils matériels

| Profil | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (par défaut) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

Le profil **"par défaut"** regroupe les trois niveaux de travail sur `hermes3:8b`, qui représente le chemin d'intégration validé de Hermes Agent. L'utilisation du même modèle du début à la fin simplifie la compréhension, réduit le coût de résidence et facilite la gestion. Les utilisateurs qui préfèrent Qwen 3 (avec sa fonctionnalité `THINK_BY_SHAPE`) peuvent choisir le profil `dev-rtx5080-qwen3`. Le profil `m5-max` est une version de Qwen 3 optimisée pour la mémoire unifiée.

---

## Règles de preuve

Ces règles sont appliquées côté serveur, et non dans la requête :

- **Citations obligatoires.** Chaque affirmation concise cite un identifiant de preuve.
- **Les inconnues sont supprimées côté serveur.** Les modèles qui citent des identifiants qui ne figurent pas dans le paquet de preuves voient ces identifiants supprimés, avec un avertissement, avant que le résultat ne soit renvoyé.
- **Les informations faibles sont considérées comme telles.** Les informations de faible qualité sont marquées `weak: true` avec des notes de couverture et ne sont jamais intégrées dans un récit fallacieux.
- **Fonctionnalité d'investigation, pas prescriptive.** Seuls les éléments `next_checks` / `read_next` / `likely_breakpoints` sont autorisés. Les requêtes qui demandent "appliquer cette correction" sont interdites.
- **Rendu déterministe.** La forme du balisage des artefacts est du code, et non une requête. `draft` reste réservé aux textes où le choix des mots du modèle est important.
- **Différences au sein du même paquet uniquement.** Les comparaisons `artifact_diff` entre différents paquets sont refusées ; les charges utiles restent distinctes.

---

## Artefacts et continuité

Les paquets écrivent dans `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. Le niveau des artefacts offre une continuité sans transformer cela en un outil de gestion de fichiers :

- `artifact_list` — index contenant uniquement des métadonnées, filtrable par paquet, date, motif de slug
- `artifact_read` — lecture typée par `{pack, slug}` ou `{json_path}`
- `artifact_diff` — comparaison structurée au sein du même paquet ; les modifications faibles sont mises en évidence
- `artifact_export_to_path` — écrit un artefact existant (avec un en-tête de provenance) dans un emplacement déclaré par l'utilisateur (`allowed_roots`). Refuse les fichiers existants, sauf si `overwrite: true` est spécifié.
- `artifact_incident_note_snippet` — fragment de note d'incident
- `artifact_onboarding_section_snippet` — fragment du manuel
- `artifact_release_note_snippet` — fragment de note de version (DRAFT)

Aucun appel de modèle dans ce niveau. Tout est généré à partir de contenu stocké.

---

## Modèle de menace et télémétrie

**Données traitées :** chemins de fichiers que l'utilisateur fournit explicitement (`ollama_research`, outils de corpus), texte intégré et artefacts que l'utilisateur demande d'être écrits dans `~/.ollama-intern/artifacts/` ou dans un emplacement déclaré par l'utilisateur (`allowed_roots`).

**Données non modifiées :** tout ce qui se trouve en dehors des chemins `source_paths` / `allowed_roots`. L'utilisation de `..` est bloquée avant la normalisation. La fonction `artifact_export_to_path` refuse d'écrire sur des fichiers existants, sauf si `overwrite: true` est spécifié. Les versions préliminaires ciblant des chemins protégés (`memory/`, `.claude/`, `docs/canon/`, etc.) nécessitent une confirmation explicite `confirm_write: true`, ce qui est appliqué côté serveur.

**Communication réseau sortante :** **désactivée par défaut.** Le seul trafic sortant est dirigé vers le point de terminaison HTTP local d'Ollama. Aucune communication avec le cloud, aucun signalement de mises à jour, aucun rapport de crash.

**Télémétrie :** **inexistante.** Chaque appel est enregistré sous forme d'une seule ligne NDJSON dans le fichier `~/.ollama-intern/log.ndjson` sur votre machine. Rien ne quitte l'appareil.

**Erreurs :** format structuré `{ code, message, hint, retryable }`. Les traces de pile ne sont jamais exposées dans les résultats des outils.

Politique complète : [SECURITY.md](SECURITY.md).

---

## Normes

Conforme aux exigences de [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). Les tests A à D sont obligatoires ; voir [SHIP_GATE.md](SHIP_GATE.md) et [SCORECARD.md](SCORECARD.md).

- **A. Sécurité** — SECURITY.md, modèle de menace, absence de télémétrie, sécurité des chemins, `confirm_write` sur les chemins protégés.
- **B. Erreurs** — Format structuré pour tous les résultats des outils ; pas de traces de pile brutes.
- **C. Documentation** — README à jour, CHANGELOG, LICENSE ; les schémas des outils sont auto-documentés.
- **D. Qualité** — `npm run verify` (395 tests), CI avec analyse des dépendances, Dependabot, fichier de verrouillage, `engines.node`.

---

## Feuille de route (renforcement de la sécurité, pas extension des fonctionnalités)

- **Phase 1 — Infrastructure de délégation** ✓ Implémentée : interface atomique, enveloppe uniforme, routage hiérarchique, protections.
- **Phase 2 — Infrastructure de vérité** ✓ Implémentée : segmentation de schéma v2, BM25 + RRF, corpus dynamiques, résumés étayés par des preuves, ensemble d'évaluation de la récupération.
- **Phase 3 — Infrastructure de paquets et d'artefacts** ✓ Implémentée : paquets avec pipelines fixes et artefacts durables + niveau de continuité.
- **Phase 4 — Infrastructure d'adoption (du produit)** — Observation de l'utilisation réelle sur le RTX 5080, correction des problèmes qui apparaissent.
- **Phase 5 — Benchmarks M5 Max** — Publication des résultats une fois le matériel disponible (environ le 24 avril 2026).

Phase par couche de renforcement de la sécurité. L'interface atomique/paquet/artefact reste figée.

---

## Licence

MIT — voir [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
