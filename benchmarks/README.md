# Script Editing V3 AI Gold Set

`scripts/script-editing-v3-ai-benchmark.ts` evaluates the retrieval layer against a human-labelled set. It deliberately refuses to score incomplete or synthetic data as a production result.

Create a JSON file with this shape:

```json
{
  "schemaVersion": "SCRIPT_EDITING_V3_GOLD_SET_V1",
  "items": [
    {
      "assetId": "asset-001",
      "fileName": "真实文件名.mp4",
      "summary": "可选：用于 keyword baseline 的人工摘要",
      "tags": ["货架", "商品特写"],
      "visualProfile": {
        "assetId": "asset-001",
        "summary": "Qwen-VL 缓存的视觉摘要",
        "tags": [{ "tag": "货架", "confidence": 0.94, "timestampsMs": [1200] }],
        "recommendedTimestampsMs": [1200],
        "modelProvider": "QWEN_VL",
        "modelName": "实际使用的 VL model",
        "modelVersion": "实际版本",
        "promptVersion": "实际 prompt 版本",
        "analysisVersion": "实际分析版本",
        "createdAt": "2026-01-01T00:00:00.000Z"
      }
    }
  ],
  "queries": [
    {
      "id": "need-001",
      "text": "消费者在货架挑选商品",
      "usableAssetIds": ["asset-001"],
      "forbiddenAssetIds": []
    }
  ]
}
```

The acceptance set must contain 100–300 real local materials and 10–20 manually reviewed visual needs. Every item must also include the actual cached `visualProfile` produced by Qwen-VL with `modelProvider: "QWEN_VL"`; the script refuses to turn human summaries or tags into fake AI profiles. `usableAssetIds` and `forbiddenAssetIds` are the human labels; they are not generated from filenames. Run it with:

```powershell
$env:CONTENTOS_V3_GOLD_SET_PATH = 'F:\path\to\gold-set.json'
node node_modules/tsx/dist/cli.mjs scripts/script-editing-v3-ai-benchmark.ts
```

The AI comparison also requires a real Qwen endpoint and API key. Without them the command returns `BLOCKED_BY_DATA`; it does not report the profile-only lexical fallback as Qwen semantic retrieval.

UI candidate loading is measured by the real browser acceptance flow, from opening
`Candidate Browser` until the first candidate action is visible. The test emits a
structured line such as:

```json
{"benchmark":"SCRIPT_EDITING_V3_UI","metric":"candidateLoadingMs","value":36.42}
```
