import type { DesignBrief, Provider } from '../schema';

/**
 * Which models can look at a picture (tech 3b §2.6): the second look sends the proposal as a
 * plan drawing, so it runs only for a model that can see. The curated models are listed; one
 * from a provider's own list counts as seeing when its family does.
 */
export const VISION: Record<string, boolean> = {
  'claude-opus-5-5': true,
  'claude-opus-5': true,
  'claude-sonnet-5-5': true,
  'claude-sonnet-5': true,
  'claude-haiku-5-5': true,
  'claude-fable-5-1': true,
  'claude-fable-5': true,
  'gpt-5': true,
  'gpt-5-mini': true,
  'gemini-3-pro': true,
  'gemini-2.5-pro': true,
  'gemini-2.5-flash': true,
};

const FAMILY: Record<Provider, RegExp> = {
  anthropic: /^claude-/,
  openai: /^gpt-5/,
  gemini: /^gemini-/,
};

/** Whether this model can look at the second look's picture. */
export function canSee(provider: Provider, model: string): boolean {
  const id = model.trim().toLowerCase();
  const listed = VISION[id];
  if (listed !== undefined) return listed;
  return FAMILY[provider].test(id);
}

/**
 * Tokens one picture of the second look costs, about (1568 px on its long side): Claude about
 * w·h/750 (≈ 2.1k for 1568 × 1000), OpenAI's high detail about 1.1k, Gemini 258 a 768 px tile.
 */
export const IMAGE_TOKENS: Record<Provider, number> = {
  anthropic: 2100,
  openai: 1100,
  gemini: 1032,
};

/** Whether a run has a second look: Thorough, with a model that can see (Quicker never). */
export const looksAt = (
  brief: Pick<DesignBrief, 'quality'>,
  ai: { provider: Provider; model: string },
) => brief.quality === 'thorough' && canSee(ai.provider, ai.model);

/** The card's line when the model can't see. */
export const NO_LOOK = 'This model can’t look at pictures, so there’s no second look.';
