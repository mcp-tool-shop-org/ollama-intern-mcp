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

> **Lo "stagista" locale per Claude Code.** 28 strumenti strutturati, report dettagliati basati su evidenze, artefatti duraturi.

Un server MCP che fornisce a Claude Code uno **"stagista" locale**, con regole, livelli, una scrivania e un archivio. Claude sceglie lo _strumento_; lo strumento sceglie il _livello_ (Instant / Workhorse / Deep / Embed); il livello scrive un file che puoi aprire la prossima settimana.

**Funziona anche con [Hermes Agent](https://github.com/NousResearch/hermes-agent) su `hermes3:8b`** — validato end-to-end il 19 aprile 2026. Il modello predefinito è `hermes3:8b`; `qwen3:*` è un'alternativa. Consultare la sezione [Utilizzo con Hermes](#use-with-hermes) sottostante.

**Requisiti hardware:** circa 6 GB di VRAM per `hermes3:8b`, oppure circa 16 GB di RAM per l'esecuzione su CPU. Consultare [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) per i dettagli completi.

**Non si utilizza Claude?** La directory [`examples/`](./examples/) contiene un client MCP Node.js e Python minimali che possono essere eseguiti tramite stdio. Consultare anche [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/).

Nessun cloud. Nessuna telemetria. Niente di "autonomo". Ogni operazione mostra il suo processo.

---

## Novità nella versione 2.1.0

L'estensione delle funzionalità esistenti non introduce nuove classi; "atoms+briefs" rimane a 18.

- **`ollama_log_tail`** — legge il log delle chiamate in formato NDJSON all'interno di una sessione MCP. [handbook/observability](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/observability/#the-ollama_log_tail-tool).
- **`ollama_batch_proof_check`** — esegue `tsc` / `eslint` / `pytest` su un insieme di percorsi; restituisce un singolo risultato con l'indicazione di superamento o fallimento per ogni controllo. Nuova interfaccia di esecuzione; consultare [SECURITY.md](./SECURITY.md).
- **`ollama_code_map`** — mappa strutturale di un albero di codice (esportazioni, schemi di grafo delle chiamate, TODO).
- **`ollama_code_citation`** — dato un simbolo, restituisce il file di definizione, la riga e il contesto circostante.
- **`ollama_corpus_amend`** — modifiche in-place a un corpus esistente; le risposte successive indicano `has_amended_content: true`.
- **`ollama_artifact_prune`** — eliminazione basata sull'età, con esecuzione di prova predefinita. [handbook/artifacts](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/artifacts/#artifact_prune).
- **Miglioramenti** — `summarize_deep` ora accetta `source_path`; `corpus_answer` mostra lo stato delle modifiche apportate al contenuto; nuovi eventi di monitoraggio documentati in dettaglio.
- **Nuove pagine del manuale** — [Observability](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/observability/) (log NDJSON + ricette jq) e [Comparison](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/comparison/) (matrice dettagliata rispetto alle alternative).

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

Restituisce un "inviluppo" che punta a un file sul disco:

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

Quel file Markdown è l'output della scrivania dello "stagista" — titoli, blocco di evidenze con ID citati, istruzioni investigative `next_checks`, banner `weak: true` se le evidenze sono scarse. È deterministico: il renderer è codice, non un prompt. Aprilo domani, confrontalo la settimana prossima, esportalo in un manuale con `ollama_artifact_export_to_path`.

Ogni concorrente in questa categoria inizia con "risparmia token". Noi iniziamo con _"ecco il file scritto dallo stagista"_.

### Secondo esempio: crea un corpus, quindi interrogalo

```jsonc
// 1. Build a persistent, searchable corpus over your project.
{ "tool": "ollama_corpus_index",
  "arguments": { "name": "sprite-foundry",
                 "paths": ["F:/AI/sprite-foundry/src"],
                 "embed_model": "nomic-embed-text" } }
// → { chunks_written: 1204, paths_indexed: 312, failed_paths: [] }

// 2. Ask an evidence-bound question against it.
{ "tool": "ollama_corpus_answer",
  "arguments": { "name": "sprite-foundry",
                 "query": "how does the worker handle OOM eviction?",
                 "top_k": 8 } }
// → { answer: "...", citations: [{chunk_id, path}...], weak: false }
```

Ogni affermazione nella risposta cita un ID di chunk, validato lato server. La guida completa è disponibile in [handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/).

---

## Cosa c'è qui: quattro livelli, 28 strumenti

**"Job-shaped"** significa che ogni strumento definisce un compito che si assegnerebbe a un tirocinante: classifica questo, estrai quello, gestisci questi log, scrivi questa nota di rilascio, impacchetta questo incidente. L'input dello strumento è la specifica del compito; l'output è il risultato. Non esiste una primitiva generica `run_model` / `chat_with_llm` di alto livello.

| Livello | Conteggio | Cosa si trova qui |
|---|---|---|
| **Atoms** | 15 | Primitivi strutturati. `classify`, `extract`, `triage_logs`, `summarize_fast` / `deep`, `draft`, `research`, `corpus_search` / `answer` / `index` / `refresh` / `list`, `embed_search`, `embed`, `chat`. Gli atomi in grado di gestire operazioni batch (`classify`, `extract`, `triage_logs`) accettano `items: [{id, text}]`. |
| **Briefs** | 3 | Report strutturati basati su evidenze. `incident_brief`, `repo_brief`, `change_brief`. Ogni affermazione cita un ID di evidenza; le informazioni sconosciute vengono eliminate lato server. Le evidenze deboli mostrano `weak: true` invece di una narrazione falsa. |
| **Packs** | 3 | Operazioni composte con pipeline fisse che scrivono file Markdown + JSON duraturi in `~/.ollama-intern/artifacts/`. `incident_pack`, `repo_pack`, `change_pack`. Renderer deterministici: nessuna chiamata al modello sulla forma dell'artefatto. |
| **Artifacts** | 7 | Interfaccia di continuità sugli output dei pacchetti. `artifact_list` / `read` / `diff` / `export_to_path`, più tre snippet deterministici: `incident_note`, `onboarding_section`, `release_note`. |

Totale: **18 primitivi + 3 pacchetti + 7 strumenti per artefatti = 28**.

Linee congelate:
- Gli atomi sono congelati a 18 (atomi + report). Nessun nuovo strumento atomico.
- I pacchetti sono congelati a 3. Nessun nuovo tipo di pacchetto.
- Il livello degli artefatti è congelato a 7.

Il riferimento completo agli strumenti si trova nel [manuale](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/).

---

## Installazione

Richiede [Ollama](https://ollama.com) installato e in esecuzione localmente, e i modelli necessari devono essere stati scaricati (vedere [Model pulls](#model-pulls) sottostante).

### Claude Code (consigliato)

La maggior parte degli utenti installa questo aggiungendolo alla configurazione del server MCP di Claude Code; non è necessaria un'installazione globale. Claude Code esegue il server su richiesta tramite `npx`:

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

Lo stesso file, scritto in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Installazione globale (avanzata)

Necessaria solo se si desidera avere il binario nel percorso di sistema per un utilizzo ad-hoc al di fuori di Claude Code:

```bash
npm install -g ollama-intern-mcp
```

### Utilizzare con Hermes

Questo MCP è stato validato end-to-end con [Hermes Agent](https://github.com/NousResearch/Hermes) contro `hermes3:8b` su Ollama (2026-04-19). Hermes è un agente esterno che *chiama* la superficie di primitivi congelata di questo MCP: si occupa della pianificazione, noi eseguiamo il lavoro.

Configurazione di riferimento ([hermes.config.example.yaml](hermes.config.example.yaml) in questo repository):

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

**La forma del prompt è importante.** I prompt di invocazione degli strumenti imperativi ("Chiama X con argomenti...") sono il test di integrazione: forniscono a un modello locale di 8B una struttura sufficiente per emettere `tool_calls` puliti. I prompt multi-task in forma di elenco ("esegui A, poi B, poi C") sono benchmark di capacità per modelli più grandi; non interpretare un fallimento in forma di elenco su un modello di 8B come "il collegamento è interrotto". Consulta [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) per la guida completa all'integrazione e le note sui trasporti noti (streaming Ollama `/v1` + shim non-streaming di openai-SDK).

### Download dei modelli

**Profilo di sviluppo predefinito (RTX 5080 16GB e simili):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Percorso alternativo Qwen 3 (stessa configurazione hardware, per gli strumenti Qwen):**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**Profilo M5 Max (128GB unificati):**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

Le variabili d'ambiente specifiche per livello (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) sovrascrivono comunque le impostazioni del profilo per utilizzi specifici.

---

## Involucro uniforme

Ogni strumento restituisce la stessa struttura:

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

La "residenza" proviene da `/api/ps` di Ollama. Quando `evicted: true` o `size_vram < size`, il modello viene spostato su disco e le prestazioni diminuiscono del 5-10 volte. Questa informazione viene mostrata all'utente, in modo che sappia di dover riavviare Ollama o ridurre il numero di modelli caricati.

Ogni chiamata viene registrata come una riga in formato NDJSON in `~/.ollama-intern/log.ndjson`. È possibile filtrare per `hardware_profile` per escludere i dati di sviluppo dai benchmark pubblicabili.

---

## Profili hardware

| Profilo | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (predefinito) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

Il profilo **"Default dev"** combina tutti e tre i livelli di elaborazione in `hermes3:8b`, che rappresenta il percorso di integrazione con Hermes Agent validato. L'utilizzo dello stesso modello in tutti i livelli semplifica la gestione, riduce i costi di "residenza" e facilita la comprensione del comportamento. Gli utenti che preferiscono Qwen 3 (con la sua architettura "THINK_BY_SHAPE") possono utilizzare il profilo `dev-rtx5080-qwen3`. Il profilo `m5-max` è ottimizzato per Qwen 3 e utilizza la memoria unificata.

---

## Leggi sulle prove

Queste regole vengono applicate sul server, non nel prompt:

- **Sono richieste le citazioni.** Ogni affermazione breve cita un identificativo di prova.
- **Le informazioni sconosciute vengono eliminate lato server.** I modelli che citano identificativi non presenti nel pacchetto di prove hanno tali identificativi rimossi, con un avviso visualizzato prima della restituzione del risultato.
- **Le informazioni deboli sono considerate tali.** Le prove deboli sono contrassegnate con `weak: true` e includono note sulla copertura. Non vengono mai modificate per creare una narrazione falsa.
- **Approccio investigativo, non prescrittivo.** Sono presenti solo `next_checks`, `read_next` e `likely_breakpoints`. I prompt non devono contenere istruzioni come "applica questa correzione".
- **Renderer deterministici.** La formattazione del markdown degli artefatti è codice, non un prompt. `draft` rimane riservato al testo in cui la formulazione del modello è importante.
- **Solo differenze all'interno dello stesso pacchetto.** Le differenze tra pacchetti (`artifact_diff`) vengono rifiutate; i payload rimangono distinti.

---

## Artefatti e continuità

I pacchetti scrivono in `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. Il livello degli artefatti offre un'interfaccia di continuità senza trasformare questo in uno strumento di gestione dei file:

- `artifact_list` — indice contenente solo metadati, filtrabile per pacchetto, data, glob del nome.
- `artifact_read` — lettura tipizzata tramite `{pacchetto, nome}` o `{percorso_json}`.
- `artifact_diff` — confronto strutturato all'interno dello stesso pacchetto; evidenziazione delle modifiche deboli.
- `artifact_export_to_path` — scrive un artefatto esistente (con intestazione di provenienza) in una posizione specificata dal chiamante (`allowed_roots`). Rifiuta i file esistenti a meno che `overwrite: true` sia impostato.
- `artifact_incident_note_snippet` — frammento di nota dell'operatore.
- `artifact_onboarding_section_snippet` — frammento della guida introduttiva.
- `artifact_release_note_snippet` — frammento di nota di rilascio (Bozza).

Nessuna chiamata a modelli in questo livello. Tutto viene generato a partire da contenuti memorizzati.

---

## Modello di minaccia e telemetria

**Dati accessibili:** percorsi di file forniti esplicitamente dal chiamante (`ollama_research`, strumenti per corpus), testo inline e artefatti richiesti dal chiamante per essere scritti in `~/.ollama-intern/artifacts/` o in una posizione specificata dal chiamante (`allowed_roots`).

**Dati non modificati:** qualsiasi elemento al di fuori dei percorsi `source_paths` / `allowed_roots`. L'uso di `..` viene bloccato prima della normalizzazione. La funzione `artifact_export_to_path` rifiuta i file esistenti a meno che `overwrite: true` sia specificato. Le versioni di prova che puntano a percorsi protetti (`memory/`, `.claude/`, `docs/canon/`, ecc.) richiedono esplicitamente `confirm_write: true`, con applicazione lato server.

**Traffico in uscita:** **disattivato per impostazione predefinita.** L'unico traffico in uscita è diretto all'endpoint HTTP locale di Ollama. Non ci sono chiamate al cloud, né richieste di aggiornamento, né segnalazioni di crash.

**Telemetria:** **assente.** Ogni chiamata viene registrata come una riga in formato NDJSON nel file `~/.ollama-intern/log.ndjson` sul vostro computer. Nessun dato viene trasmesso al di fuori del dispositivo.

**Errori:** struttura definita `{ code, message, hint, retryable }`. Le tracce dello stack non vengono mai esposte nei risultati degli strumenti.

Politica completa: [SECURITY.md](SECURITY.md).

---

## Standard

Conforme agli standard di [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). Superati i controlli A–D; consultare [SHIP_GATE.md](SHIP_GATE.md) e [SCORECARD.md](SCORECARD.md).

- **A. Sicurezza** — SECURITY.md, modello di minacce, assenza di telemetria, sicurezza dei percorsi, `confirm_write` per percorsi protetti.
- **B. Errori** — struttura definita in tutti i risultati degli strumenti; assenza di tracce dello stack grezze.
- **C. Documentazione** — README aggiornato, CHANGELOG, LICENZA; schemi degli strumenti auto-documentati.
- **D. Affidabilità** — `npm run verify` (395 test), CI con scansione delle dipendenze, Dependabot, lockfile, `engines.node`.

---

## Roadmap (miglioramenti, non ampliamenti)

- **Fase 1 – Struttura di delega** ✓ Consegnato: superficie atomica, involucro uniforme, routing a livelli, meccanismi di protezione.
- **Fase 2 – Struttura di affidabilità** ✓ Consegnato: suddivisione in blocchi della versione 2, BM25 + RRF, corpora attivi, sintesi basate su prove, pacchetto di valutazione del recupero.
- **Fase 3 – Struttura di pacchetti e artefatti** ✓ Consegnato: pacchetti con pipeline fissa e artefatti duraturi + livello di continuità.
- **Fase 4 – Struttura di adozione** ✓ Versione 2.0.1: corpus di test avanzato in tre fasi (protezione contro attacchi di tipo TOCTOU, limite di 50 MB per file, rifiuto di collegamenti simbolici, scritture atomiche, acquisizione di errori a livello di file), navigazione del percorso degli strumenti, monitoraggio (eventi di attesa del semaforo, contesto di errore di timeout, registrazione delle sovrascritture dell'ambiente, segnale di pre-riscaldamento per l'avvio a freddo), sicurezza dei test (istantanea dell'ambiente di caricamento dei moduli su 10 file, test end-to-end con `tools/call`). Aggiunto manuale di risoluzione dei problemi e requisiti minimi hardware per gli operatori.
- **Fase 5 – Benchmark M5 Max** – Numeri pubblicabili una volta disponibile l'hardware (circa 24 aprile 2026).

Fasi per livello di miglioramento. L'interfaccia atomica/pacchetto/artefatto rimane stabile.

---

## Licenza

MIT — consultare [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
