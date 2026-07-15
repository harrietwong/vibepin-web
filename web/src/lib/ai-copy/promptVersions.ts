/**
 * promptVersions.ts — pure version constants, safe to import from BOTH client and
 * server code (no env reads, no server-only imports, no side effects).
 *
 * The AI-Copy prompts themselves are defined server-side in visionServer.ts
 * (buildFastPathPrompt / buildVisionPrompt); the constant lives here so client code
 * (generatePinCopy.ts analytics events) can stamp `versions.promptVersion` without
 * importing the server module.
 *
 * Bump ("cp_v2", …) whenever those copy prompts or their quality/language guardrails
 * change materially, so events carrying `versions.promptVersion` (ai_copy_success /
 * ai_copy_quality_failed) stay comparable across copy-prompt iterations. This is the
 * copy-side counterpart to the generation prompt's HIDDEN_PROMPT_VERSION
 * (studio/hiddenPromptBuilder.ts) and the judge's JUDGE_VERSION (judgeVerdict.ts).
 */
export const COPY_PROMPT_VERSION = "cp_v1";
