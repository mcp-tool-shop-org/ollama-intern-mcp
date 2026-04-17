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

> **O "estagiário" local para o Claude Code.** 28 ferramentas estruturadas, relatórios concisos baseados em evidências, artefatos duráveis.

Um servidor MCP que oferece ao Claude Code um **"estagiário" local**, com regras, níveis, uma mesa e uma gaveta de arquivos. O Claude escolhe a _ferramenta_; a ferramenta escolhe o _nível_ (Instantâneo / Robusto / Profundo / Incorporado); o nível escreve um arquivo que você pode abrir na próxima semana.

Sem nuvem. Sem telemetria. Nada de "autônomo". Cada chamada mostra seu trabalho.

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
  "model": "qwen2.5:14b-instruct-q4_K_M",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

Esse arquivo Markdown é a saída da "mesa" do estagiário — títulos, bloco de evidências com IDs citados, investigações com `next_checks`, e um aviso `weak: true` se a evidência for escassa. É determinístico: o renderizador é código, não um prompt. Abra-o amanhã, compare-o na semana seguinte, exporte-o para um manual usando `ollama_artifact_export_to_path`.

Todos os concorrentes nesta categoria começam com "economia de tokens". Nós começamos com _"aqui está o arquivo que o estagiário escreveu"_.

---

## O que está aqui — quatro níveis, 28 ferramentas

| Nível | Contagem | O que está aqui |
|---|---|---|
| **Atoms** | 15 | Primitivos estruturados. `classify` (classificar), `extract` (extrair), `triage_logs` (triagem de logs), `summarize_fast` / `deep` (resumir rapidamente / profundamente), `draft` (rascunho), `research` (pesquisa), `corpus_search` (busca em corpus) / `answer` (responder) / `index` (indexar) / `refresh` (atualizar) / `list` (listar), `embed_search` (busca incorporada), `embed` (incorporar), `chat` (chat). Os "átomos" que suportam processamento em lote (`classify`, `extract`, `triage_logs`) aceitam `items: [{id, text}]`. |
| **Briefs** | 3 | Relatórios estruturados baseados em evidências. `incident_brief` (resumo de incidente), `repo_brief` (resumo de repositório), `change_brief` (resumo de alteração). Cada afirmação cita um ID de evidência; informações desconhecidas são removidas no servidor. Evidências fracas exibem `weak: true` em vez de uma narrativa falsa. |
| **Packs** | 3 | Tarefas compostas com fluxo de trabalho fixo que escrevem Markdown + JSON duráveis em `~/.ollama-intern/artifacts/`. `incident_pack` (pacote de incidente), `repo_pack` (pacote de repositório), `change_pack` (pacote de alteração). Renderizadores determinísticos — nenhuma chamada de modelo na estrutura do artefato. |
| **Artifacts** | 7 | Interface unificada sobre as saídas dos pacotes. `artifact_list` (lista de artefatos) / `read` (ler) / `diff` (diferença) / `export_to_path` (exportar para o caminho), além de três trechos determinísticos: `incident_note` (nota de incidente), `onboarding_section` (seção de integração), `release_note` (nota de lançamento). |

Total: **18 primitivos + 3 pacotes + 7 ferramentas de artefato = 28**.

Linhas fixas:
- Primitivos fixos em 18 (primitivos + relatórios). Sem novas ferramentas de primitivo.
- Pacotes fixos em 3. Sem novos tipos de pacote.
- Nível de artefato fixo em 7.

A referência completa das ferramentas está no [manual](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/).

---

## Instalação

```bash
npm install -g ollama-intern-mcp
```

Requer o [Ollama](https://ollama.com) instalado localmente e os modelos de nível baixados.

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

O mesmo bloco, escrito em `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Download dos modelos

**Perfil de desenvolvimento padrão (RTX 5080 16GB e similar):**

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
```

**Perfil M5 Max (128GB unificados):**

```bash
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
ollama pull llama3.3:70b-instruct-q4_K_M
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

As variáveis de ambiente por nível (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) ainda substituem as escolhas do perfil para casos específicos.

---

## Envelope unificado

Cada ferramenta retorna a mesma estrutura:

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

O `residency` (residência) vem do `/api/ps` do Ollama. Quando `evicted: true` (removido) ou `size_vram < size` (tamanho da VRAM menor que o tamanho), o modelo é movido para o disco e a inferência diminui em 5–10 vezes — mostre isso ao usuário para que ele saiba reiniciar o Ollama ou reduzir o número de modelos carregados.

Cada chamada é registrada como uma linha em NDJSON em `~/.ollama-intern/log.ndjson`. Filtre por `hardware_profile` para manter os números de desenvolvimento fora dos benchmarks publicáveis.

---

## Perfis de hardware

| Perfil | Instantâneo | Robusto | Profundo | Incorporado |
|---|---|---|---|---|
| **`dev-rtx5080`** (padrão) | qwen2.5 7B | qwen2.5-coder 7B | qwen2.5 14B | nomic-embed-text |
| `dev-rtx5080-llama` | qwen2.5 7B | qwen2.5-coder 7B | **llama3.1 8B** | nomic-embed-text |
| `m5-max` | qwen2.5 14B | qwen2.5-coder 32B | llama3.3 70B | nomic-embed-text |

**Modelos da mesma família no ambiente de desenvolvimento padrão:** problemas de saída inadequada são problemas de ferramenta/design, e não incompatibilidades entre modelos de diferentes famílias. `dev-rtx5080-llama` é o ponto de referência: execute as mesmas avaliações de referência no Llama 8B antes de implementar o Llama no M5 Max.

---

## Regras de evidência

Estas regras são aplicadas no servidor, não no prompt:

- **Citações obrigatórias.** Cada afirmação concisa cita um ID de evidência.
- **Informações desconhecidas são removidas no servidor.** Modelos que citam IDs que não estão no pacote de evidências têm esses IDs removidos, com um aviso, antes que o resultado seja retornado.
- **"Fraco" é "fraco".** As evidências consideradas "fracas" são marcadas com `weak: true` e incluem notas sobre a cobertura. Nunca são suavizadas para criar uma narrativa falsa.
- **Investigativo, não prescritivo.** Apenas `next_checks` / `read_next` / `likely_breakpoints`. Os prompts não permitem frases como "aplique esta correção".
- **Renderizadores determinísticos.** A formatação em Markdown dos artefatos é código, não um prompt. `draft` permanece reservado para texto, onde a formulação do modelo é importante.
- **Apenas diferenças dentro do mesmo pacote.** A função `artifact_diff` entre pacotes diferentes é rejeitada; os pacotes permanecem distintos.

---

## Artefatos e continuidade

Os pacotes gravam dados em `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. A camada de artefatos oferece uma superfície de continuidade sem transformar isso em uma ferramenta de gerenciamento de arquivos:

- `artifact_list` — índice apenas com metadados, filtrável por pacote, data, glob de slug.
- `artifact_read` — leitura tipada por `{pacote, slug}` ou `{json_path}`.
- `artifact_diff` — comparação estruturada dentro do mesmo pacote; identificação de casos de "fraco" para "forte".
- `artifact_export_to_path` — grava um artefato existente (com cabeçalho de origem) em um local declarado pelo usuário (`allowed_roots`). Rejeita arquivos existentes, a menos que `overwrite: true` seja especificado.
- `artifact_incident_note_snippet` — fragmento de nota do operador.
- `artifact_onboarding_section_snippet` — fragmento do manual.
- `artifact_release_note_snippet` — fragmento de nota de lançamento (RASCUNHO).

Nenhuma chamada de modelo nesta camada. Tudo é renderizado a partir de conteúdo armazenado.

---

## Modelo de ameaças e telemetria

**Dados acessados:** caminhos de arquivos que o usuário fornece explicitamente (`ollama_research`, ferramentas de corpus), texto inline e artefatos que o usuário solicita para serem gravados em `~/.ollama-intern/artifacts/` ou em um local declarado pelo usuário (`allowed_roots`).

**Dados NÃO acessados:** qualquer coisa fora de `source_paths` / `allowed_roots`. `..` é rejeitado antes da normalização. `artifact_export_to_path` rejeita arquivos existentes, a menos que `overwrite: true` seja especificado. Rascunhos que visam caminhos protegidos (`memory/`, `.claude/`, `docs/canon/`, etc.) exigem explicitamente `confirm_write: true`, o que é imposto no servidor.

**Tráfego de saída:** **desativado por padrão.** O único tráfego de saída é para o endpoint HTTP local do Ollama. Não há chamadas para a nuvem, nem pings de atualização, nem relatórios de falhas.

**Telemetria:** **nenhuma.** Cada chamada é registrada como uma linha NDJSON em `~/.ollama-intern/log.ndjson` em sua máquina. Nada sai do sistema.

**Erros:** formato estruturado `{ code, message, hint, retryable }`. Rastreamentos de pilha nunca são expostos nos resultados da ferramenta.

Política completa: [SECURITY.md](SECURITY.md).

---

## Padrões

Construído de acordo com o padrão [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). As verificações A–D são obrigatórias; veja [SHIP_GATE.md](SHIP_GATE.md) e [SCORECARD.md](SCORECARD.md).

- **A. Segurança** — SECURITY.md, modelo de ameaças, sem telemetria, segurança de caminhos, `confirm_write` em caminhos protegidos.
- **B. Erros** — formato estruturado em todos os resultados da ferramenta; sem rastreamentos de pilha brutos.
- **C. Documentação** — README atualizado, CHANGELOG, LICENSE; esquemas de ferramentas autoexplicativos.
- **D. Higiene** — `npm run verify` (395 testes), CI com verificação de dependências, Dependabot, lockfile, `engines.node`.

---

## Roteiro (foco em segurança, não em expansão de escopo)

- **Fase 1 — Núcleo de Delegação** ✓ Implementado: interface atom, estrutura uniforme, roteamento em camadas, mecanismos de proteção.
- **Fase 2 — Núcleo de Veracidade** ✓ Implementado: fragmentação de esquema v2, BM25 + RRF, corpora dinâmicos, resumos baseados em evidências, pacote de avaliação de recuperação.
- **Fase 3 — Núcleo de Pacotes e Artefatos** ✓ Implementado: pacotes com pipeline fixo e artefatos duráveis + camada de continuidade.
- **Fase 4 — Núcleo de Adoção** — Observação do uso real no RTX 5080, refinando os aspectos problemáticos que surgem.
- **Fase 5 — Testes de desempenho do M5 Max** — Números publicáveis assim que o hardware estiver disponível (aproximadamente 24 de abril de 2026).

Fase por camada de segurança. A interface de átomos/pacotes/artefatos permanece fixa.

---

## Licença

MIT — veja [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
