<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

> **El "becario" local para Claude Code.** 28 herramientas estructuradas, informes basados en evidencia, artefactos duraderos.

Un servidor MCP que proporciona a Claude Code un **"becario" local** con reglas, niveles, un escritorio y un archivador. Claude elige la _herramienta_; la herramienta elige el _nivel_ (Instantáneo / Potente / Profundo / Incorporado); el nivel escribe un archivo que puedes abrir la semana que viene.

**También ejecuta [Hermes Agent](https://github.com/NousResearch/hermes-agent) en `hermes3:8b`** — validado de extremo a extremo el 19 de abril de 2026. La configuración predeterminada es `hermes3:8b`; `qwen3:*` es la opción alternativa. Consulte [Uso con Hermes](#use-with-hermes) a continuación.

**Requisitos de hardware:** ~6 GB de VRAM para `hermes3:8b`, o ~16 GB de RAM para inferencia en CPU. Consulte [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) para obtener más detalles.

**¿No está utilizando Claude?** El directorio [`examples/`](./examples/) contiene un cliente mínimo de Node.js y Python para MCP que se puede ejecutar a través de stdio. Consulte también [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/).

Sin nube. Sin telemetría. Nada de funciones "autónomas". Cada llamada muestra su trabajo.

---

## Novedades en v2.1.0

La extensión de funciones mantiene los niveles existentes; no se crea una nueva clase de nivel, y "atoms+briefs" permanece en 18.

- **`ollama_log_tail`** — lee el registro de llamadas NDJSON dentro de una sesión de MCP. [handbook/observability](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/observability/#the-ollama_log_tail-tool).
- **`ollama_batch_proof_check`** — ejecuta `tsc` / `eslint` / `pytest` en un conjunto de rutas; un único paquete con resultados de aprobación/fallo por verificación. Nueva superficie de ejecución; consulte [SECURITY.md](./SECURITY.md).
- **`ollama_code_map`** — mapa estructural de un árbol de código (exportaciones, esquemas de grafo de llamadas, TODOs).
- **`ollama_code_citation`** — dado un símbolo, devuelve el archivo de definición + línea + contexto circundante.
- **`ollama_corpus_amend`** — modificaciones en línea y aditivas a un corpus existente; las respuestas posteriores muestran `has_amended_content: true`.
- **`ollama_artifact_prune`** — eliminación basada en la edad, con ejecución de prueba predeterminada. [handbook/artifacts](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/artifacts/#artifact_prune).
- **Mejoras** — `summarize_deep` ahora acepta `source_path`; `corpus_answer` muestra el estado de contenido modificado; se documentan nuevos eventos de observabilidad de extremo a extremo.
- **Nuevas páginas del manual** — [Observability](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/observability/) (registro NDJSON + recetas jq) y [Comparison](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/comparison/) (matriz honesta frente a alternativas).

---

## Ejemplo principal: una llamada, un artefacto

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

Devuelve un "sobre" que apunta a un archivo en el disco:

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

Ese archivo Markdown es el resultado del "becario" en su escritorio: encabezados, bloque de evidencia con identificadores citados, comandos de investigación `next_checks`, y un indicador `weak: true` si la evidencia es limitada. Es determinista: el renderizador es código, no una instrucción. Ábrelo mañana, compáralo la semana que viene y expórtalo a un manual con `ollama_artifact_export_to_path`.

Todos los competidores en esta categoría destacan la función de "ahorro de tokens". Nosotros destacamos el hecho de que _aquí está el archivo que el becario escribió_.

### Segundo ejemplo: crea un corpus y luego hazle una pregunta

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

Cada afirmación en `answer` cita un ID de fragmento validado en el servidor. Consulte el tutorial completo en [handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/).

---

## ¿Qué hay aquí? Cuatro niveles, 28 herramientas

**Diseñado para tareas específicas** significa que cada herramienta nombra una tarea que le asignarías a un becario: clasifica esto, extrae eso, prioriza estos registros, redacta esta nota de lanzamiento, empaqueta este incidente. La entrada de la herramienta es la especificación de la tarea; la salida es el resultado. No hay una función primitiva genérica `run_model` / `chat_with_llm` en la parte superior.

| Nivel | Cantidad | Qué hay aquí |
|---|---|---|
| **Atoms** | 15 | Elementos básicos estructurados para tareas específicas. `classify` (clasificar), `extract` (extraer), `triage_logs` (triaje de registros), `summarize_fast` / `deep` (resumir rápido / profundo), `draft` (borrador), `research` (investigación), `corpus_search` (búsqueda en corpus), `answer` (responder), `index` (indexar), `refresh` (actualizar), `list` (listar), `embed_search` (búsqueda de incrustaciones), `embed` (incrustar), `chat` (chat). Los elementos básicos que admiten procesamiento por lotes (`classify`, `extract`, `triage_logs`) aceptan `items: [{id, text}]`. |
| **Briefs** | 3 | Informes estructurados basados en evidencia. `incident_brief` (informe de incidente), `repo_brief` (informe de repositorio), `change_brief` (informe de cambio). Cada afirmación cita un identificador de evidencia; la información desconocida se elimina en el servidor. La evidencia débil muestra `weak: true` en lugar de una narrativa falsa. |
| **Packs** | 3 | Tareas compuestas con un flujo de trabajo fijo que escriben archivos Markdown + JSON duraderos en `~/.ollama-intern/artifacts/`. `incident_pack` (paquete de incidente), `repo_pack` (paquete de repositorio), `change_pack` (paquete de cambio). Renderizadores deterministas: no hay llamadas a modelos en la forma del artefacto. |
| **Artifacts** | 7 | Interfaz de consistencia sobre los resultados de los paquetes. `artifact_list` (lista de artefactos), `read` (leer), `diff` (comparar), `export_to_path` (exportar a ruta), más tres fragmentos deterministas: `incident_note` (nota de incidente), `onboarding_section` (sección de incorporación), `release_note` (nota de lanzamiento). |

Total: **18 elementos básicos + 3 paquetes + 7 herramientas de artefacto = 28**.

Líneas congeladas:
- Los elementos básicos están congelados en 18 (elementos básicos + informes). No hay nuevas herramientas de elemento básico.
- Los paquetes están congelados en 3. No hay nuevos tipos de paquete.
- El nivel de artefacto está congelado en 7.

La referencia completa de las herramientas se encuentra en el [manual](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/).

---

## Instalación

Requiere [Ollama](https://ollama.com) instalado localmente y los modelos de nivel descargados (consulte [Model pulls](#model-pulls) a continuación).

### Claude Code (recomendado)

La mayoría de los usuarios instalan esto agregándolo a la configuración del servidor MCP de Claude Code; no se requiere una instalación global. Claude Code ejecuta el servidor bajo demanda mediante `npx`:

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

El mismo archivo, escrito en `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Instalación global (avanzado)

Solo es necesario si desea tener el binario en su `PATH` para uso ad-hoc fuera de Claude Code:

```bash
npm install -g ollama-intern-mcp
```

### Uso con Hermes

Este MCP se validó de extremo a extremo con [Hermes Agent](https://github.com/NousResearch/hermes-agent) contra `hermes3:8b` en Ollama (19 de abril de 2026). Hermes es un agente externo que *llama* a la superficie primitiva congelada de este MCP; se encarga de la planificación, y nosotros nos encargamos del trabajo.

Configuración de referencia ([hermes.config.example.yaml](hermes.config.example.yaml) en este repositorio):

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

**La estructura de las instrucciones es importante.** Las instrucciones imperativas para invocar herramientas ("Llama a X con los argumentos…") son la prueba de integración; proporcionan a un modelo local de 8B la estructura necesaria para generar llamadas a herramientas (`tool_calls`) limpias. Las instrucciones en forma de lista para múltiples tareas ("haz A, luego B, luego C") son puntos de referencia de capacidad para modelos más grandes; no interpretes un fallo en una instrucción en forma de lista en un modelo de 8B como un "problema de conexión". Consulta [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) para obtener la guía completa de integración y las advertencias conocidas sobre la transmisión (Ollama `/v1` + una capa de compatibilidad no de transmisión para el SDK de OpenAI).

### Descarga de modelos

**Perfil de desarrollo predeterminado (RTX 5080 16GB y similar):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Ruta alternativa de Qwen 3 (mismo hardware, para las herramientas de Qwen):**

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

Las variables de entorno por nivel (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) aún anulan las selecciones del perfil para casos individuales.

---

## "Sobre" uniforme

Cada herramienta devuelve la misma estructura:

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

La información de `residency` (residencia) proviene de `/api/ps` de Ollama. Cuando `evicted: true` (desalojado) o `size_vram < size` (tamaño de la VRAM menor que el tamaño), el modelo se carga en el disco y la inferencia se reduce entre 5 y 10 veces. Muestra esta información al usuario para que sepa que debe reiniciar Ollama o reducir el número de modelos cargados.

Cada llamada se registra como una línea en formato NDJSON en `~/.ollama-intern/log.ndjson`. Filtra por `hardware_profile` para mantener los datos de desarrollo fuera de los puntos de referencia publicados.

---

## Perfiles de hardware

| Perfil | Instantáneo | Potente | Profundo | Incorporado |
|---|---|---|---|---|
| **`dev-rtx5080`** (predeterminado) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**Configuración predeterminada para desarrollo:** La configuración predeterminada para desarrollo consolida los tres niveles de trabajo en `hermes3:8b`, que es la ruta de integración validada de Hermes Agent. Utilizar el mismo modelo de principio a fin significa que solo hay un componente que mantener, un costo de alojamiento, y un conjunto de comportamientos que comprender. Los usuarios que prefieren Qwen 3 (con su infraestructura `THINK_BY_SHAPE`) pueden optar por `dev-rtx5080-qwen3`. `m5-max` es la versión de Qwen 3 optimizada para memoria unificada.

---

## Normas de evidencia

Estas normas se aplican en el servidor, no en la solicitud:

- **Se requieren citas.** Cada afirmación breve cita un identificador de evidencia.
- **Información desconocida se elimina en el servidor.** Los modelos que citan identificadores que no están en el paquete de evidencia tienen esos identificadores eliminados, con una advertencia, antes de que se devuelva el resultado.
- **Lo débil es lo débil.** La evidencia débil se marca como `weak: true` con notas de cobertura. Nunca se suaviza para crear una narrativa falsa.
- **Investigación, no prescripción.** Solo `next_checks` / `read_next` / `likely_breakpoints`. Las solicitudes prohíben "aplicar esta corrección".
- **Renderizadores deterministas.** La forma del marcador de texto de los artefactos es código, no una solicitud. `draft` se reserva para el texto donde la redacción del modelo es importante.
- **Solo diferencias dentro del mismo paquete.** Se rechaza explícitamente la función `artifact_diff` entre diferentes paquetes; los paquetes permanecen distintos.

---

## Artefactos y continuidad

Los paquetes escriben en `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. La capa de artefactos proporciona una superficie de continuidad sin convertir esto en una herramienta de gestión de archivos:

- `artifact_list` — índice de metadatos, filtrable por paquete, fecha, patrón de slug
- `artifact_read` — lectura tipada por `{pack, slug}` o `{json_path}`
- `artifact_diff` — comparación estructurada dentro del mismo paquete; se muestra la inversión de la debilidad
- `artifact_export_to_path` — escribe un artefacto existente (con un encabezado de procedencia) en una ubicación declarada por el usuario (`allowed_roots`). Rechaza archivos existentes a menos que `overwrite: true`.
- `artifact_incident_note_snippet` — fragmento de nota del operador
- `artifact_onboarding_section_snippet` — fragmento del manual
- `artifact_release_note_snippet` — fragmento de nota de la versión (BORRADOR)

No hay llamadas a modelos en esta capa. Todo se renderiza a partir de contenido almacenado.

---

## Modelo de amenazas y telemetría

**Datos accedidos:** rutas de archivos que el usuario proporciona explícitamente (`ollama_research`, herramientas de corpus), texto incrustado y artefactos que el usuario solicita que se escriban en `~/.ollama-intern/artifacts/` o en una ubicación declarada por el usuario (`allowed_roots`).

**Datos NO accedidos:** cualquier cosa fuera de `source_paths` / `allowed_roots`. Se rechaza `..` antes de la normalización. `artifact_export_to_path` rechaza archivos existentes a menos que `overwrite: true`. Los borradores dirigidos a rutas protegidas (`memory/`, `.claude/`, `docs/canon/`, etc.) requieren explícitamente `confirm_write: true`, lo que se aplica en el servidor.

**Tráfico de salida de la red:** **desactivado de forma predeterminada.** El único tráfico de salida es al punto final HTTP local de Ollama. No hay llamadas a la nube, ni notificaciones de actualización, ni informes de fallos.

**Telemetría:** **ninguna.** Cada llamada se registra como una línea en formato NDJSON en `~/.ollama-intern/log.ndjson` en su máquina. Nada sale del sistema.

**Errores:** formato estructurado `{ code, message, hint, retryable }`. Los rastros de pila nunca se muestran en los resultados de la herramienta.

Política completa: [SECURITY.md](SECURITY.md).

---

## Estándares

Construido según los estándares de [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck). Se superan las pruebas A–D; consulte [SHIP_GATE.md](SHIP_GATE.md) y [SCORECARD.md](SCORECARD.md).

- **A. Seguridad** — SECURITY.md, modelo de amenazas, sin telemetría, seguridad de rutas, `confirm_write` en rutas protegidas
- **B. Errores** — formato estructurado en todos los resultados de la herramienta; sin trazas de pila sin formato
- **C. Documentación** — README actualizado, CHANGELOG, LICENSE; esquemas de herramientas con autocomentarios
- **D. Higiene** — `npm run verify` (395 pruebas), CI con análisis de dependencias, Dependabot, archivo de bloqueo, `engines.node`

---

## Hoja de ruta (fortalecimiento, no ampliación del alcance)

- **Fase 1: Espina dorsal de delegación** ✓ Implementada: interfaz atómica, envoltorio uniforme, enrutamiento por niveles, mecanismos de seguridad.
- **Fase 2: Espina dorsal de la verdad** ✓ Implementada: fragmentación de esquema v2, BM25 + RRF, corpus dinámicos, resúmenes con respaldo de evidencia, paquete de evaluación de recuperación.
- **Fase 3: Espina dorsal de empaquetado y artefactos** ✓ Implementada: paquetes de flujo de trabajo predefinidos con artefactos duraderos + nivel de continuidad.
- **Fase 4: Espina dorsal de adopción** ✓ v2.0.1: corpus de salud de tres etapas endurecido (protección contra ataques TOCTOU, límite de tamaño de archivo de 50 MB, rechazo de enlaces simbólicos, escrituras atómicas, captura de fallos por archivo), recorrido de la ruta de las herramientas, observabilidad (eventos de espera de semáforos, contexto de error de tiempo de espera, registro de anulación de entorno, señal de precalentamiento para inicio en frío), pruebas de seguridad (instantánea del entorno de carga de módulos en 10 archivos, prueba E2E de `tools/call`). Se ha añadido un manual de solución de problemas y los requisitos mínimos de hardware para los operadores.
- **Fase 5: Pruebas de rendimiento de M5 Max** — Se publicarán los resultados una vez que se disponga del hardware (aproximadamente el 24 de abril de 2026).

Fase por capa de fortalecimiento. La interfaz de átomos/paquetes/artefactos permanece inalterada.

---

## Licencia

MIT — ver [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
