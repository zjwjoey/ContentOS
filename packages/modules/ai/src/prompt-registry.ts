import { validatePromptVersion, type PromptVersion } from '../../../contracts/src/index.js';

export interface RenderedPrompt {
  promptVersion: PromptVersion;
  input: string;
  template: string;
}

interface RegisteredPrompt {
  promptVersion: PromptVersion;
  template: string;
}

const defaultPrompts: RegisteredPrompt[] = [
  {
    promptVersion: { id: 'prompt-director-script-v2', key: 'director.script.v2', version: 2, templateHash: 'sha256:director-script-v2', requiredVariables: ['brief'] },
    template: '你是短视频 Director。以下是不可篡改的 ContentBrief JSON：{{brief}}\n请只输出 JSON，字段必须包含 title、titleCandidates、coverText、topicKeywords、hook、body、cta。',
  },
  {
    promptVersion: { id: 'prompt-director-storyboard-v2', key: 'director.storyboard.v2', version: 2, templateHash: 'sha256:director-storyboard-v2', requiredVariables: ['brief', 'script'] },
    template: '你是短视频分镜 Director。Brief JSON：{{brief}}\n选定 Script Revision 全文 JSON：{{script}}\n请只输出 JSON，字段必须包含 scenes；每个 scene 必须包含 sceneIndex、voiceoverText、durationHintSeconds、visualInstruction、assetKeywords。',
  },
  {
    promptVersion: { id: 'prompt-director-script-v1', key: 'director.script.v1', version: 1, templateHash: 'sha256:director-script-v1', requiredVariables: ['topic', 'coreThesis'] },
    template: '你是短视频 Director。选题：{{topic}}\n核心观点：{{coreThesis}}\n请输出专业、克制、可执行的中文脚本。',
  },
  {
    promptVersion: { id: 'prompt-director-storyboard-v1', key: 'director.storyboard.v1', version: 1, templateHash: 'sha256:director-storyboard-v1', requiredVariables: ['topic', 'coreThesis'] },
    template: '你是短视频 Director。选题：{{topic}}\n核心观点：{{coreThesis}}\n请输出绑定脚本的中文分镜结构。',
  },
  {
    promptVersion: { id: 'prompt-review-analysis-v1', key: 'review.analysis.v1', version: 1, templateHash: 'sha256:review-analysis-v1', requiredVariables: ['platformId', 'publishedAt', 'metrics', 'history'] },
    template: '你是内容运营分析师。平台：{{platformId}}\n发布时间：{{publishedAt}}\n当前指标：{{metrics}}\n历史指标：{{history}}\n请输出克制、可执行的复盘建议。',
  },
  {
    promptVersion: { id: 'prompt-benchmark-analysis-v1', key: 'benchmark.analysis.v1', version: 1, templateHash: 'sha256:benchmark-analysis-v1', requiredVariables: ['platform', 'title', 'copy'] },
    template: '你是短视频对标分析师。平台：{{platform}}\n标题：{{title}}\n文案：{{copy}}\n请输出结构化分析，并明确可借鉴与不可复制的部分。',
  },
];

export class PromptRegistry {
  private readonly prompts = new Map<string, RegisteredPrompt>();

  constructor(entries: RegisteredPrompt[] = defaultPrompts) {
    for (const entry of entries) this.register(entry.promptVersion, entry.template);
  }

  register(promptVersion: PromptVersion, template: string): void {
    validatePromptVersion(promptVersion);
    if (!template.trim() || template.length > 20_000) throw new Error('prompt template must be bounded and non-empty');
    if (this.prompts.has(promptVersion.key)) throw new Error(`Prompt version already registered: ${promptVersion.key}`);
    this.prompts.set(promptVersion.key, { promptVersion: Object.freeze({ ...promptVersion, requiredVariables: [...promptVersion.requiredVariables] }), template });
  }

  get(key: string): PromptVersion {
    const entry = this.prompts.get(key);
    if (!entry) throw new Error(`Prompt version not found: ${key}`);
    return { ...entry.promptVersion, requiredVariables: [...entry.promptVersion.requiredVariables] };
  }

  render(key: string, variables: Record<string, string>): RenderedPrompt {
    const entry = this.prompts.get(key);
    if (!entry) throw new Error(`Prompt version not found: ${key}`);
    for (const variable of entry.promptVersion.requiredVariables) {
      const value = variables[variable];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing prompt variable: ${variable}`);
      if (value.length > 20_000) throw new Error(`Prompt variable exceeds maximum length: ${variable}`);
    }
    const input = entry.template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => variables[name] ?? '');
    if (input.length > 20_000) throw new Error('Rendered prompt exceeds maximum length');
    return { promptVersion: this.get(key), input, template: entry.template };
  }
}
