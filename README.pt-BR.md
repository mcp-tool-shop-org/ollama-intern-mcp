<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
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

**O agente local para Claude Code.** 41 ferramentas, relatórios baseados em evidências, artefatos duráveis.

Um servidor MCP que oferece ao Claude Code um **agente local**, com regras, níveis, uma mesa e uma gaveta. O Claude escolhe a _ferramenta_; a ferramenta escolhe o _nível_ (Instantâneo / Robusto / Profundo / Incorporado); o nível gera um arquivo que você pode abrir na próxima semana.

**Também executa [Hermes Agent](https://github.com/NousResearch/hermes-agent) em `hermes3:8b`** — validado de ponta a ponta em 19 de abril de 2026. O nível padrão é `hermes3:8b`; `qwen3:*` é a alternativa. Veja [Como usar com Hermes](#use-with-hermes) abaixo.

**Requisitos de hardware:** ~6 GB de VRAM para `hermes3:8b`, ou ~16 GB de RAM para inferência na CPU. Veja [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) para detalhes.

**Não está usando o Claude?** O diretório [`examples/`](./examples/) contém um cliente MCP mínimo em Node.js e Python que você pode executar via stdio. Veja também [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/).

Sem nuvem. Sem telemetria. Sem nada "autônomo". Cada chamada mostra seu trabalho.

---

## Novo no v2.2.0

Controle individualizado de `num_ctx` (janela de contexto) para cada nível no sistema de perfis. Pequena alteração cumulativa — as chamadas não foram modificadas na versão 2.3.0. Detalhes nas seções [CHANGELOG.md](./CHANGELOG.md) e [docs/release-notes/v2.4.0.md](./docs/release-notes/v2.4.0.md).

- **Mapa `TierConfig.num_ctx` (novo)** — opcional `{ instant?, workhorse?, deep?, embed? }` no perfil. Quando definido para um nível, o servidor MCP inclui `options.num_ctx = <valor>` em cada solicitação de geração/chat do Ollama direcionada a esse nível (inicial + fallback). Quando não definido, a solicitação omite completamente o campo `num_ctx`, permitindo que o Ollama use o valor padrão carregado no modelo — o comportamento da versão 2.3.0 é preservado exatamente.
- **Novo campo do envelope `num_ctx_used?: number`** — presente apenas quando o servidor MCP realmente enviou `num_ctx`. Ausente quando a solicitação permitiu que o Ollama escolhesse. Não tente inferir um valor padrão — o servidor MCP não consulta o Ollama para obter o valor efetivo.
- **Valores padrão do perfil**: Os perfis `dev-rtx5080` / `dev-rtx5080-qwen3` são enviados com `instant: 4096`, `workhorse: 8192`, `deep`/`embed` NÃO DEFINIDOS. O tamanho foi ajustado para manter o `hermes3:8b` na memória VRAM de 16GB da RTX 5080, permitindo ferramentas rápidas. O `m5-max` deixa todos os níveis NÃO DEFINIDOS — a memória unificada de 128GB não apresenta problemas de estouro.
- **Corrige o diagnóstico da Fase 1 da versão 0.8.0** — o `hermes3:8b` com o contexto padrão de 32K na RTX 5080 estava sendo transferido para a CPU e causando timeouts nas chamadas `ollama_extract` do tipo `workhorse`. A versão 2.4.0 evita isso na camada de perfil.

### Controle individualizado de `num_ctx` (novo na versão 2.4.0)

Perfil (trecho de `src/profiles.ts`):

```ts
"dev-rtx5080": {
  tiers: {
    instant: "hermes3:8b",
    workhorse: "hermes3:8b",
    deep: "hermes3:8b",
    embed: "nomic-embed-text",
    num_ctx: {
      instant: 4096,    // fast classify/summarize
      workhorse: 8192,  // schema-bound extract / batch
      // deep: UNSET — long-context briefs keep current behavior
      // embed: UNSET — no context-window pressure on embed
    },
  },
  // ... timeouts, prewarm
}
```

Envelope em uma chamada de nível `workhorse` (por exemplo, `ollama_extract`):

```jsonc
{
  "result": { /* extracted data */ },
  "tier_used": "workhorse",
  "model": "hermes3:8b",
  "num_ctx_used": 8192,        // present because the profile set workhorse=8192
  // ... rest of envelope unchanged
}
```

Em `m5-max` (ou qualquer perfil que deixe um nível não definido), `num_ctx_used` está ausente do envelope e a solicitação enviada ao Ollama não inclui o campo `num_ctx` — o Ollama usa o valor padrão carregado no modelo.

Os operadores ajustam as configurações selecionando/editando o perfil; não há entrada de `num_ctx` por chamada nos esquemas das ferramentas. Se uma chamada futura revelar a necessidade, o padrão seguirá a sobreposição de `model` da versão 2.3.0.

### Histórico — entregas da v2.1.0

Consulte [CHANGELOG.md](./CHANGELOG.md) e [docs/release-notes/v2.3.0.md](./docs/release-notes/v2.3.0.md) para a entrada completa da versão 2.3.0 (sobreposição de modelo por chamada).

## Novo no v2.2.0

Substituição de modelo por chamada em todas as ferramentas "atom" que utilizam LLMs. Pequena alteração cumulativa — os chamadores da versão v2.2.0 permanecem inalterados. Detalhes nas seções [CHANGELOG.md](./CHANGELOG.md) e [docs/release-notes/v2.3.0.md](./docs/release-notes/v2.3.0.md).

- **Entrada opcional `model: string` em 8 ferramentas "atom"** — `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep`, `ollama_research`, `ollama_corpus_answer`, `ollama_chat`, `ollama_code_citation`. A primeira tentativa na camada da ferramenta utiliza o modelo especificado pelo chamador; em caso de timeout, a cascata existente `TIER_FALLBACK` resolve o modelo da própria camada mais econômica (e não a substituição do chamador). As ferramentas compostas/resumidas/de pacote *deliberadamente* não aceitam o parâmetro `model` — as ferramentas "atom" têm controle por chamada, enquanto as ferramentas compostas usam as configurações padrão da camada.
- **Novo campo do "envelope" `model_requested?: string`** — presente apenas quando a substituição foi fornecida. Os chamadores que consideram a calibração comparam `model_requested` com `model` para detectar a substituição: `if (env.model_requested && env.model !== env.model_requested) { /* substituição */ }`. Entradas vazias ou contendo apenas espaços em branco geram um erro `ZodError` durante a análise do esquema, e não uma falha silenciosa.
- **Correção de bug — desvio em `src/version.ts`.** A constante de tempo de execução `VERSION` agora é lida do arquivo `package.json` durante o carregamento do módulo; as versões v2.1.0 e v2.2.0 foram distribuídas com a string de identificação desatualizada `"2.0.0"`. Um novo arquivo `tests/version.test.ts` garante que `VERSION === pkg.version`.

### Substituição de modelo por chamada (nova na v2.3.0)

```jsonc
{
  "tool": "ollama_classify",
  "arguments": {
    "text": "patch null pointer in auth",
    "labels": ["feat", "fix", "chore"],
    "frame": "what is the change kind?",
    "model": "hermes3:8b"
  }
}
```

Envelope:

```jsonc
{
  "result": { "label": "fix", "confidence": 0.9, "off_topic": false, ... },
  "tier_used": "instant",
  "model": "hermes3:8b",
  "model_requested": "hermes3:8b",       // present because override was supplied
  // ... rest of envelope unchanged
}
```

Se a camada "workhorse"/profunda tivesse atingido o tempo limite e a chamada tivesse sido direcionada para a camada instantânea, `env.model` seria o modelo resolvido da camada instantânea e `env.fallback_from` seria `"workhorse"` — `env.model_requested` ainda seria `"hermes3:8b"`, e `env.model !== env.model_requested` é o sinal de substituição. A substituição *deliberadamente* não é propagada para a camada mais econômica; o modelo escolhido pode não ser adequado para o papel dessa camada.

### Histórico — entregas da v2.1.0

Consulte [CHANGELOG.md](./CHANGELOG.md) e [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md) para a entrada completa da versão v2.2.0 (relevância contextual + abstenção estruturada).

## Novo no v2.2.0

Contrato de função local de processamento de evidências: relevância temática e abstenção estruturada. Pequena adição — as chamadas na v2.1.0 permanecem inalteradas. Detalhes em [CHANGELOG.md](./CHANGELOG.md) e [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md).

- **Extração com base em contexto** em `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep` — entrada opcional `frame: string` + saídas estruturadas `frame_alignment` / `on_topic` / `frame_addressed`. Fontes irrelevantes são sinalizadas em vez de serem parafraseadas no esquema.
- **Abstenção estruturada** em `ollama_research` — campos `weak` / `abstained` / `sources_address_question`. Um `answer` preenchido sem citações vazias não é mais considerado um sucesso silencioso.
- **Limite de relevância temática** em `ollama_corpus_answer` — `min_top_score` opcional. Abaixo do limite, a ferramenta interrompe com `abstained: true` e pula a síntese. A pontuação de cada citação agora é visível.
- **Preservação da pontuação de recuperação** através de evidências concisas — `corpusHitsToEvidence` carrega a pontuação (e o parâmetro `corpus_min_evidence_score` filtra no momento da montagem em `incident_brief` / `repo_brief` / `change_brief`).
- **Limites de intervalo de citações** — `guardrails/citations.ts` rejeita intervalos inválidos em `ollama_research`, seguindo a mesma lógica de `ollama_code_citation`.
- **Documentação do contrato do operador corrigida** — correção de `chunk_id`/`chunk_index` no README, reescrita de "validado no lado do servidor", seção de Leis de Evidência qualificada, slogan de marketing anotado.

### Regressão de teste — a verificação

O contrato do módulo é verificado contra a falha literal de inicialização do research-os: arxiv 2112.10422 (Cosmological Standard Timers) na seção-01 com o título *"O que significa custódia de evidências em fluxos de pesquisa profunda com LLM local vs. na nuvem?"* — 9 testes de contrato de LLM simulados confirmam que a fonte irrelevante agora está contida (`frame_alignment.on_topic = false` na extração; `off_topic: true` na classificação; `frame_addressed: false` na sumarização profunda; `abstained: true` em `corpus_answer` com `min_top_score` definido).

### Histórico — entregas da v2.1.0

Veja [CHANGELOG.md](./CHANGELOG.md) para a entrada completa da v2.1.0 (pacote de recursos: 13 novas ferramentas + 4 melhorias + atualização).

---

## Exemplo principal — uma chamada, um artefato

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

Retorna um envelope apontando para um arquivo no disco:

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

→ `weak: false` significa que foram reunidos ≥2 itens de evidência; isso NÃO significa que as hipóteses foram validadas. Veja [Leis de evidência](#evidence-laws) abaixo.

O arquivo Markdown é o resultado do trabalho do estagiário: títulos, blocos de evidências com IDs referenciados, a indicação `next_checks` para investigações e um aviso `weak: true` se a evidência for insuficiente. É determinístico: o renderizador é código, não um prompt. (O renderizador é determinístico; o *conteúdo* das hipóteses e dos resultados é gerativo — considere-os como rascunhos, não como informações verificadas.) Abra-o amanhã, compare as versões na semana seguinte e exporte-o para um manual usando `ollama_artifact_export_to_path`.

Todos os concorrentes nesta categoria começam com "economize tokens". Nós começamos com "_aqui está o arquivo que o estagiário escreveu_".

### Segundo exemplo: construa um corpus e, em seguida, faça uma pergunta a ele

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

O servidor valida a identidade das citações e verifica se cada `chunk_index` está dentro do intervalo dos resultados recuperados. Ele NÃO prova que cada afirmação gerada é semanticamente suportada pelo conteúdo do trecho citado — essa é a responsabilidade do modelo, e uma recuperação fraca ainda pode produzir respostas que parecem citações. Veja um guia completo em [handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/).

---

## Extração com restrição de contexto (nova na v2.2.0)

`ollama_extract`, `ollama_classify`, `ollama_summarize_fast` e `ollama_summarize_deep` aceitam uma entrada opcional `frame: string`. O "frame" define a pergunta para a qual a fonte está sendo consultada; o modelo é instruído a se abster de fornecer conteúdo irrelevante, mesmo que verdadeiro, quando a fonte não aborda o tema.

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

Se o `frame` for omitido, o comportamento não será alterado em relação à v2.1.0. Quando fornecido, `frame_alignment.on_topic = false` indica que os campos extraídos podem ser verdadeiros em relação à fonte, mas não relevantes para o tema — trate isso como um resumo com `weak: true`: útil, mas verifique antes de incluir como evidência.

---

## Contrato de abstenção (novo na v2.2.0)

`ollama_research` retorna campos de abstenção estruturados: `weak: boolean`, `abstained: boolean`, `sources_address_question: boolean | null`. Uma lista de citações vazia (`citations[]`) com uma resposta não vazia não é mais silenciosa — `abstained: true` indica que o modelo se absteve de sintetizar uma resposta porque os caminhos fornecidos pelo usuário não abordavam a pergunta. Considere a abstenção como um sucesso, não como uma falha: é a ferramenta que se recusa a transformar uma recuperação fraca em um resultado confiável.

`ollama_corpus_answer` aceita um limite opcional `min_top_score: number` para a relevância (0.0–1.0). Quando a pontuação de recuperação mais alta para uma consulta fica abaixo de `min_top_score`, a ferramenta interrompe o processo com `abstained: true` e pula a síntese, evitando o cenário de "5 trechos irrelevantes com pontuação de 0.21 ainda geram uma resposta completa" que a regra `weak: true` da v2.1.0 não detectava (a regra `weak: true` só era acionada quando `hits.length < 2`). Combine isso com o campo `score` de cada citação para auditar a qualidade da recuperação diretamente do resultado.

---

## O que está aqui — quatro níveis, 41 ferramentas

**Ferramentas com foco em tarefas** significa que cada ferramenta define uma tarefa que você atribuiria a um estagiário: classifique isso, extraia aquilo, trie esses logs, crie essa nota de lançamento, prepare esse incidente. A entrada da ferramenta é a especificação da tarefa; a saída é o resultado. Não há uma função genérica `run_model` / `chat_with_llm` no topo.

| Nível | Número | O que está aqui |
|---|---|---|
| **Atoms** | 15 | Ferramentas focadas em tarefas. `classify`, `extract`, `triage_logs`, `summarize_fast` / `deep`, `draft`, `research`, `corpus_search` / `answer` / `index` / `refresh` / `list`, `embed_search`, `embed`, `chat`. Funções que podem processar em lote (`classify`, `extract`, `triage_logs`) aceitam `items: [{id, text}]`. |
| **Briefs** | 3 | Resumos estruturados com base em evidências. `incident_brief`, `repo_brief`, `change_brief`. Cada afirmação cita um ID de evidência; informações desconhecidas são removidas no servidor. Evidências insuficientes geram um aviso `weak: true` em vez de uma narrativa falsa. |
| **Packs** | 3 | Tarefas compostas com pipeline fixo que escrevem markdown e JSON duráveis em `~/.ollama-intern/artifacts/`. `incident_pack`, `repo_pack`, `change_pack`. Renderizadores determinísticos — nenhuma chamada de modelo na forma do artefato. |
| **Artifacts** | 7 | Camada de continuidade sobre as saídas dos pacotes. `artifact_list` / `read` / `diff` / `export_to_path`, mais três trechos determinísticos: `incident_note`, `onboarding_section`, `release_note`. |

Total: **18 primitivas + 3 pacotes + 7 ferramentas de artefato = 28**.

Linhas fixas:
- Primitivas fixas em 18 (primitivas + resumos). Sem novas ferramentas de primitiva.
- Pacotes fixos em 3. Sem novos tipos de pacote.
- Nível de artefato fixo em 7.

A referência completa das ferramentas está no [manual](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/).

---

## Instalação

Requer o [Ollama](https://ollama.com) instalado localmente e os modelos do nível baixados (veja as [seções de download de modelos](#model-pulls) abaixo).

### Claude Code (recomendado)

A maioria dos usuários instala isso adicionando-o à configuração do servidor MCP do Claude Code — não é necessária a instalação global. O Claude Code executa o servidor sob demanda via `npx`:

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

Mesmo bloco, escrito em `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Instalação global (avançado)

Necessário apenas se você quiser o binário no seu `PATH` para uso ad-hoc fora do Claude Code:

```bash
npm install -g ollama-intern-mcp
```

### Use com Hermes

Este MCP foi validado de ponta a ponta com o [Hermes Agent](https://github.com/NousResearch/hermes-agent) contra o `hermes3:8b` no Ollama (19 de abril de 2026). Hermes é um agente externo que *chama* a superfície de primitivas fixas deste MCP — ele faz o planejamento, nós fazemos o trabalho.

Configuração de referência ([hermes.config.example.yaml](hermes.config.example.yaml) neste repositório):

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

**A forma do prompt é importante.** Prompts de invocação de ferramentas imperativos ("Chame X com os argumentos…") são o teste de integração — eles fornecem scaffolding suficiente para que um modelo local de 8B emita `tool_calls` limpos. Prompts de lista para múltiplas tarefas ("faça A, depois B, depois C") são benchmarks de capacidade para modelos maiores; não interprete uma falha em lista em um modelo de 8B como "a conexão está quebrada". Veja [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) para o walkthrough completo de integração + avisos de transporte conhecidos (streaming Ollama `/v1` + shim não-streaming openai-SDK).

### Download de modelos

**Perfil de desenvolvimento padrão (RTX 5080 16GB e similar):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Trilha alternativa Qwen 3 (mesmo hardware, para ferramentas Qwen):**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**Perfil M5 Max (128GB unificados):**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

As variáveis de ambiente por nível (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) ainda substituem as escolhas do perfil para casos únicos.

---

## Envelope uniforme

Cada ferramenta retorna a mesma forma:

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

`residency` vem do `/api/ps` do Ollama. Quando `evicted: true` ou `size_vram < size`, o modelo é movido para o disco e a inferência diminui em 5–10 vezes — mostre isso para o usuário para que ele saiba reiniciar o Ollama ou reduzir o número de modelos carregados.

Cada chamada é registrada como uma linha NDJSON em `~/.ollama-intern/log.ndjson`. Filtre por `hardware_profile` para manter os números de desenvolvimento fora dos benchmarks publicáveis.

---

## Perfis de hardware

| Perfil | Instantâneo | Trabalhador | Profundo | Incorporação |
|---|---|---|---|---|
| **`dev-rtx5080`** (padrão) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**Configuração padrão (dev)**: Agrupa todas as três camadas de trabalho em `hermes3:8b` — o caminho de integração do agente Hermes validado. Usar o mesmo modelo do início ao fim significa que há apenas um componente para baixar, um único custo de licenciamento e um único conjunto de comportamentos para entender. Usuários que preferem o Qwen 3 (com sua funcionalidade `THINK_BY_SHAPE`) podem optar por usar `dev-rtx5080-qwen3`. O `m5-max` é a versão do Qwen 3 dimensionada para memória unificada.

---

## Leis de evidência

Estas regras são aplicadas no servidor, não no prompt:

- **Citações obrigatórias.** Cada afirmação breve cita um ID de evidência.
- **Informações desconhecidas são removidas no servidor.** Modelos que citam IDs que não estão no conjunto de evidências têm esses IDs removidos, com um aviso exibido antes que o resultado seja retornado.
- **Validação por ID, não por conteúdo.** O servidor verifica se cada `evidence_ref` citado aponta para um ID de evidência real no conjunto montado. Ele NÃO verifica se o texto da afirmação pode ser derivado da evidência citada — essa é a tarefa do modelo, e às vezes as afirmações fracas contêm alegações não suportadas com referências válidas. Use `weak: true` + notas de cobertura + o campo `excerpt` incluído para verificar.
- **"Fraco" é "fraco".** As evidências com baixa qualidade são marcadas como `weak: true` com notas de cobertura. Nunca são suavizadas para criar uma narrativa falsa.
- **Investigativo, não prescritivo.** Apenas `next_checks` / `read_next` / `likely_breakpoints`. Os prompts não permitem frases como "aplique esta correção".
- **Renderizadores determinísticos.** A formatação do markdown dos artefatos é código, não um prompt. `draft` permanece reservado para texto onde a formulação do modelo é importante.
- **Apenas diferenças dentro do mesmo pacote.** A função `artifact_diff` entre diferentes pacotes é rejeitada; os payloads permanecem distintos.

---

## Artefatos e continuidade

Os pacotes gravam dados em `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. A camada de artefatos oferece uma superfície de continuidade sem transformar isso em uma ferramenta de gerenciamento de arquivos:

- `artifact_list` — índice apenas com metadados, filtrável por pacote, data, glob de slug.
- `artifact_read` — leitura tipada por `{pacote, slug}` ou `{json_path}`.
- `artifact_diff` — comparação estruturada dentro do mesmo pacote; identificação de alterações.
- `artifact_export_to_path` — grava um artefato existente (com cabeçalho de origem) em um local declarado pelo usuário (`allowed_roots`). Rejeita arquivos existentes, a menos que `overwrite: true` seja especificado.
- `artifact_incident_note_snippet` — fragmento de nota do operador.
- `artifact_onboarding_section_snippet` — fragmento do manual.
- `artifact_release_note_snippet` — fragmento de nota de lançamento (RASCUNHO).

Nenhuma chamada de modelo nesta camada. Tudo é renderizado a partir de conteúdo armazenado.

---

## Modelo de ameaças e telemetria

**Dados acessados:** caminhos de arquivos que o usuário fornece explicitamente (`ollama_research`, ferramentas de corpus), texto inline e artefatos que o usuário solicita para serem gravados em `~/.ollama-intern/artifacts/` ou em um local declarado pelo usuário (`allowed_roots`).

**Dados NÃO acessados:** qualquer coisa fora de `source_paths` / `allowed_roots`. `..` é rejeitado antes da normalização. `artifact_export_to_path` rejeita arquivos existentes, a menos que `overwrite: true` seja especificado. Rascunhos que visam caminhos protegidos (`memory/`, `.claude/`, `docs/canon/`, etc.) exigem `confirm_write: true` explicitamente, o que é imposto no servidor.

**Tráfego de saída:** **desativado por padrão.** O único tráfego de saída é para o endpoint HTTP local do Ollama. Não há chamadas para a nuvem, nem pings de atualização, nem relatórios de falhas.

**Telemetria:** **nenhuma.** Cada chamada é registrada como uma linha NDJSON em `~/.ollama-intern/log.ndjson` em sua máquina. Nada sai do sistema.

**Erros:** formato estruturado `{ code, message, hint, retryable }`. Rastreamentos de pilha nunca são expostos nos resultados da ferramenta.

Política completa: [SECURITY.md](SECURITY.md).

---

## Padrões

Construído de acordo com o padrão [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). As verificações A–D são obrigatórias; consulte [SHIP_GATE.md](SHIP_GATE.md) e [SCORECARD.md](SCORECARD.md).

- **A. Segurança** — SECURITY.md, modelo de ameaças, sem telemetria, segurança de caminhos, `confirm_write` em caminhos protegidos.
- **B. Erros** — Estrutura consistente em todos os resultados das ferramentas; sem rastreamentos de pilha brutos.
- **C. Documentação** — README atualizado, CHANGELOG, LICENÇA; esquemas das ferramentas autoexplicativos.
- **D. Boas práticas** — `npm run verify` (conjunto completo de testes do Vitest), integração contínua com análise de dependências, Dependabot, arquivo de bloqueio, `engines.node`.

---

## Roteiro (fortalecimento, não expansão do escopo)

- **Fase 1 — Núcleo de Delegação** ✓ Implementado: interface do Atom, envelope uniforme, roteamento em camadas, mecanismos de proteção.
- **Fase 2 — Núcleo de Veracidade** ✓ Implementado: fragmentação do esquema v2, BM25 + RRF, corpora dinâmicos, resumos baseados em evidências, pacote de avaliação de recuperação.
- **Fase 3 — Núcleo de Pacotes e Artefatos** ✓ Implementado: pacotes com pipeline fixo e artefatos duráveis + nível de continuidade.
- **Fase 4 — Núcleo de Adoção** ✓ v2.0.1: corpus de saúde em três etapas, reforçado (TOCTOU, limite de arquivo de 50 MB, rejeição de links simbólicos, escritas atômicas, captura de falhas por arquivo), travessia de caminhos de ferramentas, observabilidade (eventos de espera de semáforo, contexto de erro de tempo limite, registro de substituição de ambiente, sinal de pré-aquecimento para inicialização), segurança de testes (snapshot do ambiente de carregamento de módulos em 10 arquivos, `tools/call` teste ponta a ponta). Manual de solução de problemas + requisitos mínimos de hardware adicionados para operadores.
- **Fase 5 — Benchmarks do M5 Max** — Números publicáveis assim que o hardware estiver disponível (aproximadamente 24 de abril de 2026).

Fase por camada de fortalecimento. A interface do Atom/pacote/artefato permanece fixa.

---

## Licença

MIT — veja [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
