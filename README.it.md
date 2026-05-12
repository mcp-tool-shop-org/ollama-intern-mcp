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

**Il "tirocinante" locale per Claude Code.** 41 strumenti, report basati su evidenze, artefatti duraturi.

Un server MCP che fornisce a Claude Code un **tirocinante locale**, con regole, livelli, una scrivania e un archivio. Claude sceglie lo _strumento_; lo strumento sceglie il _livello_ (Instant / Workhorse / Deep / Embed); il livello scrive un file che puoi aprire la prossima settimana.

**Funziona anche con [Hermes Agent](https://github.com/NousResearch/hermes-agent) su `hermes3:8b`** — validato end-to-end il 19 aprile 2026. Il livello predefinito è `hermes3:8b`; `qwen3:*` è l'alternativa. Consulta [Utilizzo con Hermes](#use-with-hermes) qui sotto.

**Requisiti hardware:** ~6 GB di VRAM per `hermes3:8b`, oppure ~16 GB di RAM per l'inferenza sulla CPU. Consulta [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) per i dettagli.

**Non utilizzi Claude?** La directory [`examples/`](./examples/) contiene un client MCP minimale in Node.js e Python che puoi avviare tramite stdio. Consulta anche [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/).

Nessun cloud. Nessuna telemetria. Niente di "autonomo". Ogni chiamata mostra il suo lavoro.

---

## Novità nella versione 2.2.0

Contratto del ruolo di "lavoratore" di evidenze: pertinenza contestuale e astensione strutturata. Modifiche minori additive — le chiamate nella versione 2.1.0 rimangono invariate. Dettagli nelle sezioni [CHANGELOG.md](./CHANGELOG.md) e [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md).

- **Estrazione contestuale** su `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep` — input opzionale `frame: string` e output strutturati `frame_alignment` / `on_topic` / `frame_addressed`. Le fonti non pertinenti vengono contrassegnate invece di essere riformulate nello schema.
- **Astensione strutturata** su `ollama_research` — campi `weak` / `abstained` / `sources_address_question`. Un campo `citations[]` vuoto con un campo `answer` non vuoto non indica più un successo silenzioso.
- **Soglia di pertinenza** su `ollama_corpus_answer` — `min_top_score` opzionale. Se il punteggio è inferiore alla soglia, lo strumento si interrompe con `abstained: true` e salta la sintesi. Il punteggio per ogni citazione è ora visibile.
- **Preservazione del punteggio di recupero** tramite brevi evidenze — `corpusHitsToEvidence` include il `score` (e il parametro `corpus_min_evidence_score` filtra durante l'assemblaggio su `incident_brief` / `repo_brief` / `change_brief`).
- **Limiti dell'intervallo di citazioni** — `guardrails/citations.ts` rifiuta gli intervalli non validi su `ollama_research`, in linea con il comportamento esistente su `ollama_code_citation`.
- **Documentazione del contratto dell'operatore corretta** — correzione di `chunk_id`/`chunk_index` nel file README, riscrittura di "validato lato server", qualificazione della sezione "Leggi sulle evidenze", annotazione dello slogan di marketing.

### Regressione della versione precedente — verifica

Il contratto della slice è stato verificato rispetto al fallimento letterale del pacchetto "fresh" di research-os: arxiv 2112.10422 (Cosmological Standard Timers) nella sezione-01 con il titolo *"Cosa significa la custodia delle evidenze nei workflow di ricerca avanzata locale rispetto al cloud?"* — 9 test di contratto LLM simulati confermano che la fonte non pertinente è ora contenuta (`frame_alignment.on_topic = false` nell'estrazione; `off_topic: true` nella classificazione; `frame_addressed: false` nella sintesi approfondita; `abstained: true` in `corpus_answer` con `min_top_score` impostato).

### Storico — funzionalità della versione 2.1.0

Consulta [CHANGELOG.md](./CHANGELOG.md) per l'elenco completo della versione 2.1.0 (pacchetto di nuove funzionalità: 13 nuovi strumenti + 4 miglioramenti + aggiornamento).

---

## Esempio principale — una chiamata, un artefatto

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
  "model": "hermes3:8b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

→ `weak: false` significa che sono stati assemblati ≥2 elementi di evidenza; NON significa che le ipotesi siano state verificate. Consulta [Leggi sulle evidenze](#evidence-laws) qui sotto.

Quel file Markdown è l'output generato dallo stagista: titoli, blocchi di evidenza con ID citati, banner investigativo con `weak: true` se l'evidenza è scarsa. È deterministico: il renderer è codice, non un prompt. (Il renderer è deterministico; il *contenuto* delle ipotesi e delle superfici è generativo: consideratelo come una bozza, non come qualcosa di verificato). Aprilo domani, confrontalo la settimana prossima, esportalo in un manuale utilizzando `ollama_artifact_export_to_path`.

Ogni concorrente in questa categoria inizia con "risparmia token". Noi iniziamo con "_qui c'è il file scritto dallo stagista_".

### Secondo esempio: crea un corpus, quindi ponigli una domanda

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
// → { answer: "...", citations: [{chunk_index, path}...], weak: false }
```

Il server convalida l'identità delle citazioni e verifica che ogni `chunk_index` rientri nell'intervallo dei risultati recuperati. NON dimostra che ogni affermazione generata sia semanticamente supportata dal contenuto del blocco citato; questa è la responsabilità del modello, e un recupero debole può comunque produrre risposte che sembrano citazioni. Una guida completa è disponibile in [handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/).

---

## Estrazione basata sul contesto (nuova nella versione 2.2.0)

`ollama_extract`, `ollama_classify`, `ollama_summarize_fast` e `ollama_summarize_deep` accettano un input opzionale `frame: string`. Il nome del frame indica la domanda a cui la fonte deve rispondere; il modello è istruito a astenersi piuttosto che generare contenuti pertinenti ma non pertinenti alla domanda quando la fonte non affronta il tema del frame.

```jsonc
{
  "tool": "ollama_extract",
  "arguments": {
    "text": "<long source document>",
    "schema": { /* your fields */ },
    "frame": "section purpose here — e.g. 'OOM eviction behavior in the sprite worker'"
  }
}
// → result includes frame_alignment: { on_topic: boolean, reason: string, unaddressed_aspects: string[] }
```

Se il `frame` viene omesso, il comportamento rimane invariato rispetto alla versione 2.1.0. Quando viene fornito, `frame_alignment.on_topic = false` indica che i campi estratti potrebbero essere veri per la fonte, ma non pertinenti al frame; considerate questo come un breve con `weak: true`: utile, ma verificate attentamente prima di includerlo come evidenza.

---

## Contratto di astensione (nuovo nella versione 2.2.0)

`ollama_research` restituisce campi di astensione strutturati: `weak: boolean`, `abstained: boolean`, `sources_address_question: boolean | null`. Un `citations[]` vuoto con un `answer` non vuoto non è più silenzioso; `abstained: true` indica che il modello ha rifiutato di sintetizzare perché i percorsi forniti dall'utente non affrontavano la domanda. Considerate l'astensione come un successo, non come un fallimento: è lo strumento che rifiuta di trasformare un recupero debole in un output autorevole.

`ollama_corpus_answer` accetta una soglia opzionale `min_top_score: number` (da 0.0 a 1.0) per la pertinenza. Quando il punteggio di recupero più alto per una query scende al di sotto di `min_top_score`, lo strumento si interrompe con `abstained: true` e salta la sintesi, prevenendo il "5 blocchi non pertinenti con un punteggio di 0.21 che generano comunque una risposta completa" che la regola `weak: true` della versione 2.1.0 non rilevava (`weak: true` veniva attivato solo quando `hits.length < 2`). Abbinate questo al campo `score` per ogni citazione, che ora viene visualizzato, per valutare direttamente la qualità del recupero dall'inviluppo.

---

## Cosa c'è qui: quattro livelli, 41 strumenti

**Strumenti specifici per attività** significa che ogni strumento descrive un compito che affidereste a uno stagista: classifica questo, estrai quello, gestisci questi log, scrivi questa nota di rilascio, impacchetta questo incidente. L'input dello strumento è la specifica del compito; l'output è il risultato. Non c'è un primitivo generico `run_model` / `chat_with_llm` all'inizio.

| Livello | Numero | Cosa c'è qui |
|---|---|---|
| **Atoms** | 15 | Primitivi specifici per attività. `classify`, `extract`, `triage_logs`, `summarize_fast` / `deep`, `draft`, `research`, `corpus_search` / `answer` / `index` / `refresh` / `list`, `embed_search`, `embed`, `chat`. Gli atomi in grado di gestire batch (`classify`, `extract`, `triage_logs`) accettano `items: [{id, text}]`. |
| **Briefs** | 3 | Brevi strutturati basati su evidenze. `incident_brief`, `repo_brief`, `change_brief`. Ogni affermazione cita un ID di evidenza; le informazioni sconosciute vengono eliminate lato server. Le evidenze deboli mostrano `weak: true` invece di una narrazione inventata. |
| **Packs** | 3 | Lavori composti con pipeline fissa che scrivono markdown e JSON in formato duraturo nella directory `~/.ollama-intern/artifacts/`. `incident_pack`, `repo_pack`, `change_pack`. Renderizzatori deterministici: nessuna chiamata al modello basata sulla struttura dell'artefatto. |
| **Artifacts** | 7 | Superficie di continuità basata sugli output dei pacchetti. `artifact_list` / `read` / `diff` / `export_to_path`, più tre snippet deterministici: `incident_note`, `onboarding_section`, `release_note`. |

Totale: **18 elementi primitivi + 3 pacchetti + 7 strumenti per artefatti = 28**.

Elementi fissi:
- Elementi fissati a 18 (elementi + brevi descrizioni). Nessun nuovo strumento per elementi.
- Pacchetti fissati a 3. Nessun nuovo tipo di pacchetto.
- Livello degli artefatti fissato a 7.

Il riferimento completo degli strumenti è disponibile nel [manuale](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/).

---

## Installazione

Richiede [Ollama](https://ollama.com) in esecuzione localmente e i modelli corrispondenti scaricati (vedere la sezione [Download dei modelli](#model-pulls) sottostante).

### Claude Code (consigliato)

La maggior parte degli utenti installa questo componente aggiungendolo alla configurazione del server Claude Code MCP; non è necessaria un'installazione globale. Claude Code esegue il server su richiesta tramite `npx`:

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

Necessaria solo se si desidera avere il binario nel percorso di sistema per un utilizzo ad hoc al di fuori di Claude Code:

```bash
npm install -g ollama-intern-mcp
```

### Utilizzo con Hermes

Questo MCP è stato validato end-to-end con [Hermes Agent](https://github.com/NousResearch/hermes-agent) contro `hermes3:8b` su Ollama (2026-04-19). Hermes è un agente esterno che *chiama* la superficie di elementi primitivi fissi di questo MCP; si occupa della pianificazione, noi ci occupiamo dell'esecuzione.

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

**La struttura del prompt è importante.** I prompt imperativi per l'invocazione degli strumenti ("Chiama X con gli argomenti...") sono il test di integrazione; forniscono a un modello locale da 8 miliardi di parametri una struttura sufficiente per generare `tool_calls` puliti. I prompt multi-task in forma di elenco ("esegui A, poi B, poi C") sono benchmark di capacità per modelli più grandi; non interpretare un fallimento in forma di elenco su un modello da 8 miliardi di parametri come un "problema di connessione". Consultare [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) per la guida completa all'integrazione e le note sui trasporti noti (streaming Ollama `/v1` + shim non-streaming di openai-SDK).

### Download dei modelli

**Profilo di sviluppo predefinito (RTX 5080 16GB e simili):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Percorso alternativo Qwen 3 (stessa hardware, per gli strumenti Qwen):**

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

Le variabili d'ambiente per livello (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) sovrascrivono ancora le scelte del profilo per utilizzi singoli.

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

`residency` proviene da Ollama's `/api/ps`. Quando `evicted: true` o `size_vram < size`, il modello viene spostato su disco e l'inferenza diminuisce di 5-10 volte; mostrare questa informazione all'utente in modo che possa riavviare Ollama o ridurre il numero di modelli caricati.

Ogni chiamata viene registrata come una riga in formato NDJSON in `~/.ollama-intern/log.ndjson`. Filtrare per `hardware_profile` per escludere i dati di sviluppo dai benchmark pubblicabili.

---

## Profili hardware

| Profilo | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (predefinito) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**Configurazione predefinita per lo sviluppo:** questa configurazione consolida tutti e tre i livelli di lavoro in `hermes3:8b`, che rappresenta il percorso di integrazione con l'agente Hermes validato. L'utilizzo dello stesso modello dall'inizio alla fine semplifica l'implementazione, riduce i costi di utilizzo e facilita la comprensione del comportamento. Gli utenti che preferiscono Qwen 3 (con la sua funzionalità `THINK_BY_SHAPE`) possono utilizzare la configurazione `dev-rtx5080-qwen3`. `m5-max` è una versione di Qwen 3 ottimizzata per sistemi con memoria unificata.

---

## Norme relative alle prove

Queste norme vengono applicate sul server, non nel prompt:

- **Sono richieste le citazioni.** Ogni affermazione breve fa riferimento a un identificativo di prova.
- **Le informazioni sconosciute vengono eliminate lato server.** Se un modello fa riferimento a identificativi non presenti nel pacchetto di prove, tali identificativi vengono eliminati con un avviso prima che venga restituito il risultato.
- **Viene verificata l'identità, non il contenuto.** Il server verifica che ogni riferimento a `evidence_ref` punti a un identificativo di prova valido nel set assemblato. NON verifica che il testo dell'affermazione possa essere derivato dalla prova citata; questo è compito del modello. A volte, le affermazioni deboli contengono affermazioni non supportate con riferimenti validi. Utilizzare `weak: true` insieme a `coverage_notes` e al campo `excerpt` incluso per effettuare controlli.
- **"Debole" significa "debole".** Le prove considerate deboli vengono contrassegnate con `weak: true` e includono note esplicative. Queste informazioni non vengono mai "corrette" per creare una narrazione fittizia.
- **Approccio investigativo, non prescrittivo.** Sono disponibili solo `next_checks` / `read_next` / `likely_breakpoints`. I prompt non devono contenere istruzioni come "applica questa correzione".
- **Renderer deterministici.** La formattazione del markdown degli artefatti è codice, non un prompt. La modalità `draft` è riservata al testo in cui la formulazione del modello è importante.
- **Solo differenze all'interno dello stesso pacchetto.** Le differenze tra pacchetti diversi (`artifact_diff`) vengono rifiutate; i payload rimangono distinti.

---

## Artefatti e continuità

I pacchetti scrivono i dati in `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. Questo livello di artefatti fornisce un meccanismo di continuità senza trasformare questo sistema in uno strumento di gestione dei file:

- `artifact_list` — indice contenente solo metadati, filtrabile per pacchetto, data, glob di slug.
- `artifact_read` — lettura tipizzata tramite `{pack, slug}` o `{json_path}`.
- `artifact_diff` — confronto strutturato all'interno dello stesso pacchetto; vengono evidenziate le modifiche.
- `artifact_export_to_path` — scrive un artefatto esistente (con intestazione di provenienza) in una directory specificata dal chiamante (`allowed_roots`). Rifiuta i file esistenti a meno che `overwrite: true` sia impostato.
- `artifact_incident_note_snippet` — frammento di nota per l'operatore.
- `artifact_onboarding_section_snippet` — frammento della guida introduttiva.
- `artifact_release_note_snippet` — frammento di nota di rilascio (Bozza).

In questo livello, non vengono effettuate chiamate a modelli. Tutti i dati vengono generati a partire da contenuti memorizzati.

---

## Modello di rischio e telemetria

**Dati accessibili:** percorsi di file forniti esplicitamente dal chiamante (`ollama_research`, strumenti per i corpus), testo inline e artefatti richiesti dal chiamante per essere scritti in `~/.ollama-intern/artifacts/` o in una directory specificata dal chiamante (`allowed_roots`).

**Dati NON accessibili:** qualsiasi elemento al di fuori di `source_paths` / `allowed_roots`. I percorsi relativi ("..") vengono rifiutati prima della normalizzazione. `artifact_export_to_path` rifiuta i file esistenti a meno che `overwrite: true` sia impostato. Le bozze che mirano a percorsi protetti (`memory/`, `.claude/`, `docs/canon/`, ecc.) richiedono esplicitamente `confirm_write: true`, che viene applicato lato server.

**Traffico in uscita:** **disabilitato per impostazione predefinita.** L'unico traffico in uscita è diretto all'endpoint HTTP locale di Ollama. Non vengono effettuate chiamate a servizi cloud, non vengono inviati ping di aggiornamento e non viene eseguita la segnalazione di errori.

**Telemetria:** **assente.** Ogni chiamata viene registrata come una riga in formato NDJSON in `~/.ollama-intern/log.ndjson` sulla tua macchina. Nessun dato viene trasmesso al di fuori del sistema.

**Errori:** struttura `{ code, message, hint, retryable }`. Le tracce dello stack non vengono mai esposte nei risultati degli strumenti.

Politica completa: [SECURITY.md](SECURITY.md).

---

## Standard

Conforme agli standard di [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). I test di livello A-D vengono eseguiti; consultare [SHIP_GATE.md](SHIP_GATE.md) e [SCORECARD.md](SCORECARD.md).

- **A. Sicurezza** — SECURITY.md, modello di minacce, assenza di telemetria, sicurezza dei percorsi, `confirm_write` sui percorsi protetti.
- **B. Errori** — struttura uniforme in tutti i risultati degli strumenti; assenza di stack di chiamate grezzi.
- **C. Documentazione** — README aggiornato, CHANGELOG, LICENZA; gli schemi degli strumenti sono auto-documentati.
- **D. Affidabilità** — `npm run verify` (suite completa di vitest), CI con scansione delle dipendenze, Dependabot, file di lock, `engines.node`.

---

## Roadmap (miglioramenti, non ampliamento delle funzionalità)

- **Fase 1 — Struttura di delega** ✓ completata: interfaccia atomica, involucro uniforme, routing a livelli, meccanismi di protezione.
- **Fase 2 — Struttura di affidabilità** ✓ completata: schemi v2 con suddivisione in blocchi, BM25 + RRF, corpora dinamici, sintesi basate su evidenze, pacchetto di valutazione del recupero.
- **Fase 3 — Struttura di pacchetti e artefatti** ✓ completata: pacchetti con pipeline fissa e artefatti duraturi + livello di continuità.
- **Fase 4 — Struttura di adozione** ✓ v2.0.1: corpus di test avanzato a tre livelli (protezione contro attacchi TOCTOU, limite di 50 MB per file, rifiuto di collegamenti simbolici, scritture atomiche, acquisizione di errori a livello di file), navigazione dei percorsi degli strumenti, osservabilità (registrazione degli eventi di attesa del semaforo, contesto degli errori di timeout, registrazione delle sovrascritture dell'ambiente, segnale di pre-riscaldamento per l'avvio a freddo), sicurezza dei test (istantanea dell'ambiente di caricamento dei moduli su 10 file, `tools/call` test end-to-end). Aggiunto manuale di risoluzione dei problemi e requisiti minimi hardware per gli operatori.
- **Fase 5 — Benchmark M5 Max** — dati pubblicabili una volta disponibili le specifiche hardware (circa 2026-04-24).

Fasi di miglioramento per livello. L'interfaccia atomica/pacchetto/artefatto rimane stabile.

---

## Licenza

MIT — vedere [LICENZA](LICENZA).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
