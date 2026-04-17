<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

> **Lo stagista locale per Claude Code.** 28 strumenti, report dettagliati basati su evidenze, artefatti duraturi.

Un server MCP che fornisce a Claude Code un **stagista locale** con regole, livelli, una scrivania e un archivio. Claude sceglie lo _strumento_; lo strumento sceglie il _livello_ (Instant / Workhorse / Deep / Embed); il livello scrive un file che puoi aprire la prossima settimana.

Nessun cloud. Nessuna telemetria. Niente di "autonomo". Ogni operazione mostra il suo lavoro.

---

## Esempio principale: una singola operazione, un singolo artefatto

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

Restituisce un "envelope" che punta a un file su disco:

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

Quel file Markdown è l'output della scrivania dello stagista: titoli, blocco di evidenze con ID citati, istruzioni investigative `next_checks`, banner `weak: true` se le evidenze sono scarse. È deterministico: il renderer è codice, non un prompt. Aprilo domani, confrontalo la settimana prossima, esportalo in un manuale con `ollama_artifact_export_to_path`.

Ogni concorrente in questa categoria inizia con "risparmia token". Noi iniziamo con _"ecco il file che lo stagista ha scritto"_.

---

## Cosa c'è qui: quattro livelli, 28 strumenti

| Livello | Conteggio | Cosa si trova qui |
|---|---|---|
| **Atoms** | 15 | Primitivi strutturati. `classify`, `extract`, `triage_logs`, `summarize_fast` / `deep`, `draft`, `research`, `corpus_search` / `answer` / `index` / `refresh` / `list`, `embed_search`, `embed`, `chat`. Gli atomi in grado di gestire batch (`classify`, `extract`, `triage_logs`) accettano `items: [{id, text}]`. |
| **Briefs** | 3 | Report strutturati basati su evidenze. `incident_brief`, `repo_brief`, `change_brief`. Ogni affermazione cita un ID di evidenza; le informazioni sconosciute vengono eliminate lato server. Le evidenze deboli mostrano `weak: true` invece di una narrazione falsa. |
| **Packs** | 3 | Lavori composti con pipeline fisse che scrivono Markdown + JSON duraturi in `~/.ollama-intern/artifacts/`. `incident_pack`, `repo_pack`, `change_pack`. Renderer deterministici: nessuna chiamata al modello sulla forma dell'artefatto. |
| **Artifacts** | 7 | Interfaccia uniforme sugli output dei pacchetti. `artifact_list` / `read` / `diff` / `export_to_path`, più tre snippet deterministici: `incident_note`, `onboarding_section`, `release_note`. |

Totale: **18 primitivi + 3 pacchetti + 7 strumenti per artefatti = 28**.

Linee congelate:
- Gli atomi sono congelati a 18 (atomi + report). Nessun nuovo strumento atomico.
- I pacchetti sono congelati a 3. Nessun nuovo tipo di pacchetto.
- Il livello degli artefatti è congelato a 7.

Il riferimento completo agli strumenti si trova nel [manuale](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/).

---

## Installazione

```bash
npm install -g ollama-intern-mcp
```

Richiede [Ollama](https://ollama.com) in esecuzione localmente e i modelli dei livelli scaricati.

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

Lo stesso blocco, scritto in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Download dei modelli

**Profilo di sviluppo predefinito (RTX 5080 16GB e simili):**

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
```

**Profilo M5 Max (128GB unificati):**

```bash
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
ollama pull llama3.3:70b-instruct-q4_K_M
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

Le variabili d'ambiente per livello (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) sovrascrivono ancora le scelte del profilo per utilizzi singoli.

---

## "Envelope" uniforme

Ogni strumento restituisce la stessa struttura:

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

La "residenza" proviene da Ollama's `/api/ps`. Quando `evicted: true` o `size_vram < size`, il modello viene spostato su disco e l'inferenza diminuisce di 5-10 volte. Mostra questo all'utente in modo che sappia di riavviare Ollama o ridurre il numero di modelli caricati.

Ogni operazione viene registrata come una singola riga in formato NDJSON in `~/.ollama-intern/log.ndjson`. Filtra per `hardware_profile` per escludere i dati di sviluppo dai benchmark pubblicabili.

---

## Profili hardware

| Profilo | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (predefinito) | qwen2.5 7B | qwen2.5-coder 7B | qwen2.5 14B | nomic-embed-text |
| `dev-rtx5080-llama` | qwen2.5 7B | qwen2.5-coder 7B | **llama3.1 8B** | nomic-embed-text |
| `m5-max` | qwen2.5 14B | qwen2.5-coder 32B | llama3.3 70B | nomic-embed-text |

**Confronto tra modelli della stessa famiglia sulla configurazione di sviluppo predefinita:** eventuali risultati scadenti sono problemi di progettazione o di implementazione, non di incompatibilità tra modelli di famiglie diverse. `dev-rtx5080-llama` è il punto di riferimento: eseguire le stesse valutazioni standard con Llama 8B prima di utilizzare Llama su M5 Max.

---

## Norme probatorie

Queste regole vengono applicate sul server, non nel prompt:

- **Sono richieste le citazioni.** Ogni affermazione breve cita un identificativo di prova.
- **Gli elementi sconosciuti vengono rimossi lato server.** I modelli che citano identificativi non presenti nel pacchetto di prove vedono tali identificativi rimossi, con un avviso, prima che il risultato venga restituito.
- **"Debole" significa "debole".** Le prove deboli sono contrassegnate con `weak: true` e includono note sulla copertura. Non vengono mai "corrette" per creare una narrazione falsa.
- **Funzione investigativa, non prescrittiva.** Sono disponibili solo `next_checks` / `read_next` / `likely_breakpoints`. I prompt non devono contenere istruzioni come "applica questa correzione".
- **Renderer deterministici.** La formattazione Markdown degli artefatti è codice, non un prompt. `draft` è riservato al testo in cui la formulazione del modello è importante.
- **Solo differenze all'interno dello stesso pacchetto.** Le differenze tra pacchetti (`artifact_diff`) vengono rifiutate; i payload rimangono distinti.

---

## Artefatti e continuità

I pacchetti scrivono in `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. Il livello degli artefatti fornisce un'interfaccia di continuità senza trasformare questo strumento in un gestore di file:

- `artifact_list` — indice contenente solo metadati, filtrabile per pacchetto, data, glob del nome.
- `artifact_read` — lettura tipizzata tramite `{pacchetto, nome}` o `{percorso_json}`.
- `artifact_diff` — confronto strutturato all'interno dello stesso pacchetto; evidenziazione delle modifiche "deboli".
- `artifact_export_to_path` — scrive un artefatto esistente (con intestazione di provenienza) in una directory consentita specificata dal chiamante (`allowed_roots`). Rifiuta i file esistenti a meno che `overwrite: true` sia impostato.
- `artifact_incident_note_snippet` — frammento di nota dell'operatore.
- `artifact_onboarding_section_snippet` — frammento della guida introduttiva.
- `artifact_release_note_snippet` — frammento di nota di rilascio (Bozza).

Nessuna chiamata a modelli in questo livello. Tutto viene generato a partire da contenuti memorizzati.

---

## Modello di minaccia e telemetria

**Dati accessibili:** percorsi di file forniti esplicitamente dal chiamante (`ollama_research`, strumenti per corpus), testo inline e artefatti richiesti dal chiamante per essere scritti in `~/.ollama-intern/artifacts/` o in una directory consentita specificata dal chiamante (`allowed_roots`).

**Dati NON accessibili:** qualsiasi cosa al di fuori di `source_paths` / `allowed_roots`. `..` viene rifiutato prima della normalizzazione. `artifact_export_to_path` rifiuta i file esistenti a meno che `overwrite: true` sia impostato. Le bozze indirizzate a percorsi protetti (`memory/`, `.claude/`, `docs/canon/`, ecc.) richiedono esplicitamente `confirm_write: true`, applicato lato server.

**Traffico in uscita:** **disabilitato per impostazione predefinita.** L'unico traffico in uscita è verso l'endpoint HTTP locale di Ollama. Nessuna chiamata al cloud, nessun ping di aggiornamento, nessuna segnalazione di crash.

**Telemetria:** **nessuna.** Ogni chiamata viene registrata come una riga NDJSON in `~/.ollama-intern/log.ndjson` sulla tua macchina. Nessun dato lascia il sistema.

**Errori:** formato strutturato `{ codice, messaggio, suggerimento, riprovare }`. Le tracce dello stack non vengono mai esposte nei risultati degli strumenti.

Politica completa: [SECURITY.md](SECURITY.md).

---

## Standard

Conforme agli standard di [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). Superamento dei test A–D; vedere [SHIP_GATE.md](SHIP_GATE.md) e [SCORECARD.md](SCORECARD.md).

- **A. Sicurezza** — SECURITY.md, modello di minaccia, nessuna telemetria, sicurezza dei percorsi, `confirm_write` per percorsi protetti.
- **B. Errori** — formato strutturato in tutti i risultati degli strumenti; nessuna traccia dello stack grezza.
- **C. Documentazione** — README aggiornato, CHANGELOG, LICENZA; schemi degli strumenti auto-documentati.
- **D. Igiene** — `npm run verify` (395 test), CI con scansione delle dipendenze, Dependabot, lockfile, `engines.node`.

---

## Roadmap (miglioramenti, non ampliamento delle funzionalità)

- **Fase 1 — Strato di delega** ✓ completata: interfaccia atomica, struttura uniforme, routing a livelli, meccanismi di protezione.
- **Fase 2 — Strato di accuratezza** ✓ completata: suddivisione dello schema versione 2, BM25 + RRF, corpora dinamici, sintesi basate su evidenze, pacchetto di valutazione del recupero.
- **Fase 3 — Strato di pacchetti e artefatti** ✓ completata: pacchetti con pipeline fissa e artefatti duraturi + livello di continuità.
- **Fase 4 — Strato di adozione** — osservazioni sull'utilizzo reale con la RTX 5080, ottimizzazione delle aree problematiche.
- **Fase 5 — Benchmark M5 Max** — dati pubblicabili una volta disponibile l'hardware (circa 24 aprile 2026).

Fasi di miglioramento per ogni livello. L'interfaccia atomica/pacchetto/artefatto rimane stabile.

---

## Licenza

MIT — vedere [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
