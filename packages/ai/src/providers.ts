/**
 * The three providers the designer talks to, and a person's settings for one: their key and
 * the models it uses. Where the key is kept (this tab, this device) is the web app's business.
 */
export type Provider = 'anthropic' | 'openai' | 'gemini';

export interface AiSettings {
  provider: Provider;
  key: string;
  /** Reads plans and suggests layouts. */
  model: string;
  /** Makes pictures (OpenAI and Gemini); the provider's default when not chosen. */
  imageModel?: string;
  /** Kept on this device (localStorage); otherwise only until the tab closes. */
  remember?: boolean;
}

export const PROVIDERS: Record<
  Provider,
  {
    name: string;
    /** In sentences: "Gemini turned the request down". */
    short: string;
    model: string;
    keyHint: string;
    /** The picture model when none was chosen (a key saved before the choice existed). */
    imageModel?: string;
  }
> = {
  anthropic: {
    name: 'Claude (Anthropic)',
    short: 'Claude',
    model: 'claude-opus-5-5',
    keyHint: 'sk-ant-…',
  },
  openai: {
    name: 'OpenAI',
    short: 'OpenAI',
    model: 'gpt-5',
    keyHint: 'sk-…',
    imageModel: 'gpt-image-1',
  },
  gemini: {
    name: 'Gemini (Google)',
    short: 'Gemini',
    model: 'gemini-3-pro',
    keyHint: 'AIza…',
    imageModel: 'gemini-2.5-flash-image',
  },
};
