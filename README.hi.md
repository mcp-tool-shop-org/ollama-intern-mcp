<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**क्लाउड कोड के लिए स्थानीय इंटर्न।** 28 उपकरण, प्रमाण-आधारित संक्षिप्त विवरण, टिकाऊ कलाकृतियाँ।

एक एमसीपी सर्वर जो क्लाउड कोड को नियमों, स्तरों, एक डेस्क और एक फाइलिंग कैबिनेट के साथ एक **स्थानीय इंटर्न** प्रदान करता है। क्लाउड एक _उपकरण_ चुनता है; उपकरण एक _स्तर_ चुनता है (तत्काल / कार्यशील / गहन / एम्बेड); स्तर एक फ़ाइल लिखता है जिसे आप अगले सप्ताह खोल सकते हैं।

कोई क्लाउड नहीं। कोई टेलीमेट्री नहीं। "स्वायत्त" कुछ भी नहीं। प्रत्येक कॉल अपने काम को दिखाता है।

---

## मुख्य उदाहरण - एक कॉल, एक कलाकृति

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

यह एक एन्वलप लौटाता है जो डिस्क पर एक फ़ाइल की ओर इशारा करता है:

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

वह मार्कडाउन फ़ाइल इंटर्न के डेस्क का आउटपुट है - शीर्षक, उद्धृत आईडी के साथ प्रमाण ब्लॉक, जांच के लिए `next_checks`, यदि प्रमाण कमजोर है तो `weak: true` बैनर। यह नियतात्मक है: रेंडरर कोड है, कोई प्रॉम्प्ट नहीं। इसे कल खोलें, अगले सप्ताह इसका अंतर देखें, `ollama_artifact_export_to_path` के साथ इसे एक हैंडबुक में निर्यात करें।

इस श्रेणी में प्रत्येक प्रतियोगी "टोकन बचाएं" के साथ शुरुआत करता है। हम _यहां वह फ़ाइल है जिसे इंटर्न ने लिखा है_ के साथ शुरुआत करते हैं।

---

## इसमें क्या है - चार स्तर, 28 उपकरण

| स्तर | गिनती | यहां क्या है |
|---|---|---|
| **Atoms** | 15 | नौकरी-आकार के मूल तत्व। `वर्गीकृत`, `निकालें`, `लॉग का वर्गीकरण`, `सारांशित_तेजी से` / `गहन`, `मसौदा`, `अनुसंधान`, `कॉर्पस_खोज` / `उत्तर` / `इंडेक्स` / `रिफ्रेश` / `सूची`, `एम्बेड_खोज`, `एम्बेड`, `चैट`। बैच-सक्षम परमाणु (`वर्गीकृत`, `निकालें`, `लॉग का वर्गीकरण`) `items: [{id, text}]` स्वीकार करते हैं। |
| **Briefs** | 3 | प्रमाण-समर्थित संरचित ऑपरेटर संक्षिप्त विवरण। `घटना_संक्षिप्त`, `रिपो_संक्षिप्त`, `परिवर्तन_संक्षिप्त`। प्रत्येक दावे में एक प्रमाण आईडी उद्धृत किया गया है; अज्ञात जानकारी सर्वर-साइड से हटा दी जाती है। कमजोर प्रमाण `weak: true` दिखाता है, नकली कथा नहीं। |
| **Packs** | 3 | फिक्स्ड-पाइपलाइन कंपाउंड जॉब जो `~/.ollama-intern/artifacts/` में टिकाऊ मार्कडाउन + JSON लिखते हैं। `घटना_पैक`, `रिपो_पैक`, `परिवर्तन_पैक`। नियतात्मक रेंडरर - कलाकृति के आकार पर कोई मॉडल कॉल नहीं। |
| **Artifacts** | 7 | पैक आउटपुट पर निरंतर सतह। `artifact_list` / `read` / `diff` / `export_to_path`, साथ ही तीन नियतात्मक स्निपेट: `incident_note`, `onboarding_section`, `release_note`। |

कुल: **18 मूल तत्व + 3 पैक + 7 कलाकृति उपकरण = 28**।

फ्रीज लाइनें:
- 18 पर जमी हुई परमाणु (परमाणु + संक्षिप्त विवरण)। कोई नया परमाणु उपकरण नहीं।
- 3 पर जमी हुई पैक। कोई नया पैक प्रकार नहीं।
- 7 पर जमी हुई कलाकृति स्तर।

उपकरणों का पूरा संदर्भ [हैंडबुक](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/) में है।

---

## इंस्टॉल करें

```bash
npm install -g ollama-intern-mcp
```

आवश्यकता है [Ollama](https://ollama.com) स्थानीय रूप से चल रहा हो और स्तर मॉडल डाउनलोड किए गए हों।

### क्लाउड डेस्कटॉप

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

### क्लाउड डेस्कटॉप

एक ही ब्लॉक, `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) या `%APPDATA%\Claude\claude_desktop_config.json` (Windows) में लिखा गया है।

### हर्मेस के साथ उपयोग करें

इस एमसीपी (MCP) का परीक्षण 'हर्मेस एजेंट' ([https://github.com/NousResearch/Hermes](https://github.com/NousResearch/Hermes)) के साथ `hermes3:8b` पर ओलामा (Ollama) पर किया गया था (19 अप्रैल, 2026)। हर्मेस एक बाहरी एजेंट है जो इस एमसीपी की 'फ्रीज्ड प्रिमिटिव सरफेस' को *कॉल करता है* — यह योजना बनाता है, और हम काम करते हैं।

संदर्भ कॉन्फ़िगरेशन ([hermes.config.example.yaml](hermes.config.example.yaml) इस रिपॉजिटरी में):

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

**प्रॉम्प्ट का स्वरूप महत्वपूर्ण है।** अनिवार्य टूल-इनवोकेशन प्रॉम्प्ट ("X को इस तर्क के साथ कॉल करें...") एकीकरण परीक्षण हैं — वे 8B के स्थानीय मॉडल को 'टूल_कॉल' उत्पन्न करने के लिए पर्याप्त ढांचा प्रदान करते हैं। सूची-रूप में दिए गए मल्टी-टास्क प्रॉम्प्ट ("A करें, फिर B करें, फिर C करें") बड़े मॉडलों के लिए क्षमता बेंचमार्क हैं; 8B पर सूची-रूप में दिए गए प्रॉम्प्ट में विफलता को "कनेक्शन टूटा हुआ है" के रूप में न समझें। पूर्ण एकीकरण विवरण और ज्ञात परिवहन संबंधी सीमाओं के लिए [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) देखें (ओलामा `/v1` स्ट्रीमिंग + openai-SDK गैर-स्ट्रीमिंग शिम)।

### मॉडल डाउनलोड

**डिफ़ॉल्ट देव प्रोफ़ाइल (RTX 5080 16GB और इसी तरह):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**क्वेन 3 का वैकल्पिक विकल्प (समान हार्डवेयर, क्वेन टूलिंग के लिए):**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**M5 मैक्स प्रोफ़ाइल (128GB एकीकृत):**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

प्रत्येक स्तर के लिए पर्यावरण चर (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) अभी भी एक-एक के लिए प्रोफ़ाइल चयन को ओवरराइड करते हैं।

---

## समान एन्वलप

प्रत्येक उपकरण एक ही आकार लौटाता है:

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

`residency` Ollama के `/api/ps` से आता है। जब `evicted: true` या `size_vram < size` होता है, तो मॉडल को डिस्क पर पेज किया जाता है और अनुमान 5-10 गुना कम हो जाता है - इसे उपयोगकर्ता को दिखाएं ताकि वे जान सकें कि उन्हें Ollama को पुनरारंभ करना है या लोड किए गए मॉडल की संख्या को कम करना है।

प्रत्येक कॉल को `~/.ollama-intern/log.ndjson` में एक NDJSON पंक्ति के रूप में लॉग किया जाता है। प्रकाशित करने योग्य बेंचमार्क से देव नंबरों को बाहर रखने के लिए `hardware_profile` द्वारा फ़िल्टर करें।

---

## हार्डवेयर प्रोफाइल

| प्रोफ़ाइल | तत्काल | कार्यशील | गहन | एम्बेड |
|---|---|---|---|---|
| **`dev-rtx5080`** (डिफ़ॉल्ट) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**डिफ़ॉल्ट विकास (डेवलपमेंट) वातावरण** तीनों कार्य स्तरों को `hermes3:8b` पर समेटता है — यह मान्य हर्मेस एजेंट एकीकरण पथ है। समान मॉडल का उपयोग शीर्ष से नीचे तक करने का मतलब है कि केवल एक चीज डाउनलोड करनी है, एक ही निवास लागत है, और समझने के लिए केवल एक व्यवहार है। जो उपयोगकर्ता क्वेन 3 को पसंद करते हैं (इसके `THINK_BY_SHAPE` के साथ), वे `dev-rtx5080-qwen3` का उपयोग कर सकते हैं। `m5-max` क्वेन 3 का वह संस्करण है जो एकीकृत मेमोरी के लिए अनुकूलित है।

---

## सबूत कानून

ये नियम सर्वर में लागू होते हैं, प्रॉम्प्ट में नहीं:

- **उद्धरण आवश्यक हैं।** प्रत्येक संक्षिप्त दावे में एक प्रमाण आईडी का उल्लेख होता है।
- **अज्ञात जानकारी सर्वर-साइड पर हटा दी जाती है।** उन मॉडलों में जो प्रमाण बंडल में मौजूद आईडी का उल्लेख करते हैं, उन आईडी को परिणाम वापस करने से पहले एक चेतावनी के साथ हटा दिया जाता है।
- **कमजोर जानकारी कमजोर ही रहती है।** कमजोर प्रमाण में `weak: true` ध्वज होता है और इसमें कवरेज नोट्स होते हैं। इसे कभी भी नकली विवरण में नहीं बदला जाता है।
- **जांच, निर्देश नहीं।** केवल `next_checks` / `read_next` / `likely_breakpoints`। प्रॉम्प्ट में "इस सुधार को लागू करें" जैसी चीजें प्रतिबंधित हैं।
- **निर्धारित रेंडरर।** आर्टिफैक्ट मार्कडाउन का आकार कोड है, प्रॉम्प्ट नहीं। `draft` को केवल उन पाठों के लिए आरक्षित किया गया है जहां मॉडल के शब्दों का महत्व होता है।
- **केवल एक ही पैकेज के अंतर।** अलग-अलग पैकेजों के `artifact_diff` को अस्वीकार किया जाता है; पेलोड अलग-अलग रहते हैं।

---

## आर्टिफैक्ट और निरंतरता

पैकेज `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)` में लिखते हैं। आर्टिफैक्ट टियर आपको एक निरंतरता सतह प्रदान करता है, लेकिन इसे फ़ाइल प्रबंधन उपकरण में नहीं बदलता है:

- `artifact_list` — केवल मेटाडेटा वाला इंडेक्स, जिसे पैकेज, तिथि और स्लग ग्लोब द्वारा फ़िल्टर किया जा सकता है।
- `artifact_read` — `{pack, slug}` या `{json_path}` द्वारा टाइप किया गया रीड।
- `artifact_diff` — एक ही पैकेज की संरचित तुलना; कमजोर जानकारी उजागर की जाती है।
- `artifact_export_to_path` — एक मौजूदा आर्टिफैक्ट (एक उत्पत्ति हेडर के साथ) को कॉलर द्वारा घोषित `allowed_roots` में लिखता है। यदि `overwrite: true` नहीं है, तो मौजूदा फ़ाइलों को अस्वीकार कर दिया जाता है।
- `artifact_incident_note_snippet` — ऑपरेटर-नोट अंश।
- `artifact_onboarding_section_snippet` — हैंडबुक अंश।
- `artifact_release_note_snippet` — ड्राफ्ट रिलीज़-नोट अंश।

इस टियर में किसी भी मॉडल को कॉल नहीं किया जाता है। सब कुछ संग्रहीत सामग्री से उत्पन्न होता है।

---

## खतरे का मॉडल और टेलीमेट्री

**डेटा जिस पर कार्रवाई की जाती है:** फ़ाइल पथ जिन्हें कॉलर स्पष्ट रूप से प्रदान करता है (`ollama_research`, कॉर्पस टूल), इनलाइन टेक्स्ट और आर्टिफैक्ट जिन्हें कॉलर `~/.ollama-intern/artifacts/` या कॉलर द्वारा घोषित `allowed_roots` के अंतर्गत लिखने के लिए कहता है।

**डेटा जिस पर कार्रवाई नहीं की जाती है:** `source_paths` / `allowed_roots` के बाहर की कोई भी चीज़। `..` को सामान्यीकरण से पहले अस्वीकार कर दिया जाता है। यदि `overwrite: true` नहीं है, तो `artifact_export_to_path` मौजूदा फ़ाइलों को अस्वीकार कर देता है। संरक्षित पथों (`memory/`, `.claude/`, `docs/canon/`, आदि) को लक्षित करने वाले ड्राफ्ट के लिए स्पष्ट रूप से `confirm_write: true` की आवश्यकता होती है, जिसे सर्वर-साइड पर लागू किया जाता है।

**नेटवर्क आउटगोइंग:** **डिफ़ॉल्ट रूप से बंद।** एकमात्र आउटबाउंड ट्रैफ़िक स्थानीय Ollama HTTP एंडपॉइंट पर है। कोई क्लाउड कॉल नहीं, कोई अपडेट पिंग नहीं, कोई क्रैश रिपोर्टिंग नहीं।

**टेलीमेट्री:** **कोई नहीं।** प्रत्येक कॉल को आपके मशीन पर `~/.ollama-intern/log.ndjson` पर एक NDJSON पंक्ति के रूप में लॉग किया जाता है। कुछ भी सिस्टम से बाहर नहीं जाता है।

**त्रुटियां:** संरचित आकार `{ code, message, hint, retryable }`। स्टैक ट्रेस कभी भी टूल परिणामों के माध्यम से प्रदर्शित नहीं किए जाते हैं।

पूर्ण नीति: [SECURITY.md](SECURITY.md)।

---

## मानक

[Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) के मानकों के अनुसार बनाया गया। A–D गेट पास होते हैं; [SHIP_GATE.md](SHIP_GATE.md) और [SCORECARD.md](SCORECARD.md) देखें।

- **A. सुरक्षा** — SECURITY.md, खतरे का मॉडल, कोई टेलीमेट्री नहीं, पथ सुरक्षा, संरक्षित पथों पर `confirm_write`
- **B. त्रुटियां** — सभी टूल परिणामों में संरचित आकार; कोई कच्चा स्टैक नहीं
- **C. दस्तावेज़** — वर्तमान README, CHANGELOG, LICENSE; टूल स्कीमा स्वयं-दस्तावेजीकृत
- **D. स्वच्छता** — `npm run verify` (395 परीक्षण), CI जिसमें निर्भरता स्कैनिंग, Dependabot, लॉकफ़ाइल, `engines.node` शामिल हैं।

---

## सड़क मानचित्र (सुरक्षा में सुधार, दायरे में वृद्धि नहीं)

- **पहला चरण — प्रतिनिधिमंडल आधार** ✓ पूर्ण: एटम सतह, एकसमान ढांचा, स्तरीय रूटिंग, सुरक्षा उपाय।
- **दूसरा चरण — सत्य आधार** ✓ पूर्ण: स्कीमा v2, खंडन, BM25 + RRF, जीवित कॉर्पोरा, प्रमाण-आधारित सारांश, पुनर्प्राप्ति मूल्यांकन पैकेज।
- **तीसरा चरण — पैकेज और कलाकृति आधार** ✓ पूर्ण: स्थिर-पाइपलाइन पैकेज जिसमें टिकाऊ कलाकृतियां और निरंतरता स्तर शामिल हैं।
- **चौथा चरण — अपनाना आधार** — RTX 5080 पर वास्तविक उपयोग का अवलोकन, उन शुरुआती कमियों को दूर करना जो सामने आती हैं।
- **पांचवां चरण — M5 Max बेंचमार्क** — हार्डवेयर उपलब्ध होने के बाद प्रकाशित करने योग्य आंकड़े (~2026-04-24)।

प्रत्येक चरण सुरक्षा में सुधार पर केंद्रित है। एटम/पैकेज/कलाकृति सतह स्थिर रहेगी।

---

## लाइसेंस

MIT — [LICENSE](LICENSE) पर देखें।

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
