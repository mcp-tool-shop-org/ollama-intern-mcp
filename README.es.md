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

Sin nube. Sin telemetría. Nada de funciones "autónomas". Cada llamada muestra su trabajo.

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

---

## ¿Qué hay aquí? Cuatro niveles, 28 herramientas

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

La referencia completa de las herramientas se encuentra en el [manual](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/).

---

## Instalación

```bash
npm install -g ollama-intern-mcp
```

Requiere [Ollama](https://ollama.com) instalado localmente y los modelos de nivel descargados.

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

El mismo archivo, escrito en `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Uso con Hermes

Este MCP fue validado de extremo a extremo con el [Agente Hermes](https://github.com/NousResearch/Hermes) contra `hermes3:8b` en Ollama (19 de abril de 2026). Hermes es un agente externo que *llama* a la superficie primitiva de este MCP; él se encarga de la planificación, nosotros realizamos el trabajo.

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

**La estructura del prompt es importante.** Los prompts de invocación de herramientas imperativos ("Llama a X con los argumentos…") son la prueba de integración; proporcionan a un modelo local de 8B suficiente estructura para generar llamadas de herramientas limpias (`tool_calls`). Los prompts de tareas múltiples en formato de lista ("haz A, luego B, luego C") son puntos de referencia de capacidad para modelos más grandes; no interpretes un fallo en formato de lista en un modelo de 8B como "el sistema está dañado". Consulta [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) para obtener una guía completa de la integración y las limitaciones de transporte conocidas (transmisión de Ollama `/v1` + shim no transmisivo de openai-SDK).

### Descarga de modelos

**Perfil de desarrollo predeterminado (RTX 5080 16GB y similar):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Ruta alternativa de Qwen 3 (mismo hardware, para herramientas de Qwen):**

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

**Configuración de desarrollo predeterminada** consolida los tres niveles de trabajo en `hermes3:8b`: la ruta de integración del Agente Hermes validada. El uso del mismo modelo de arriba a abajo significa que solo hay un componente que descargar, un costo de alojamiento y un conjunto de comportamientos que comprender. Los usuarios que prefieren Qwen 3 (con su infraestructura `THINK_BY_SHAPE`) pueden optar por `dev-rtx5080-qwen3`. `m5-max` es la versión de Qwen 3 optimizada para memoria unificada.

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

- **Fase 1: Núcleo de delegación** ✓ Implementado: interfaz de átomos, envoltorio uniforme, enrutamiento por niveles, mecanismos de seguridad.
- **Fase 2: Núcleo de veracidad** ✓ Implementado: fragmentación de esquemas v2, BM25 + RRF, corpus vivos, resúmenes con respaldo de evidencia, paquete de evaluación de recuperación.
- **Fase 3: Núcleo de empaquetado y artefactos** ✓ Implementado: paquetes con flujo de trabajo definido y artefactos duraderos + nivel de continuidad.
- **Fase 4: Núcleo de adopción** — Observación del uso real en la RTX 5080, fortalecimiento de los aspectos problemáticos que surgen.
- **Fase 5: Pruebas de rendimiento de M5 Max** — Publicación de resultados una vez que el hardware esté disponible (aproximadamente 24 de abril de 2026).

Fase por capa de fortalecimiento. La interfaz de átomos/paquetes/artefactos permanece inalterada.

---

## Licencia

MIT — ver [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
