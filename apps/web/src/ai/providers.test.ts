import { describe, expect, it } from 'vitest';
import { failure, inSettings, providerMessage, redact } from './providers';

describe('provider error messages', () => {
  it('reads error.message from each provider’s error body', () => {
    // Gemini
    expect(
      providerMessage({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    ).toBe('Request contains an invalid argument.');
    // Gemini, as a list of one
    expect(providerMessage([{ error: { message: 'Model not found' } }])).toBe('Model not found');
    // OpenAI
    expect(
      providerMessage({
        error: { message: 'Invalid size', type: 'invalid_request_error', code: null },
      }),
    ).toBe('Invalid size');
    // Anthropic
    expect(
      providerMessage({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens too big' },
      }),
    ).toBe('max_tokens too big');
    expect(providerMessage('Service Unavailable')).toBe('Service Unavailable');
    expect(providerMessage('<html><body>502</body></html>')).toBeNull();
    expect(providerMessage({})).toBeNull();
    expect(providerMessage(null)).toBeNull();
  });

  it('cuts a long message to about 200 characters, on one line', () => {
    const said = providerMessage({ error: { message: `${'word '.repeat(100)}\n\tend` } });
    expect(said?.length).toBeLessThanOrEqual(200);
    expect(said?.endsWith('…')).toBe(true);
    expect(said).not.toMatch(/[\n\t]/);
  });

  it('never repeats the key', () => {
    const key = 'AIzaSyD-abcdefghijklmnopqrstuvwxyz012345';
    expect(redact(`The key ${key} is not valid`, key)).toBe('The key [key] is not valid');
    // Shapes of keys, even without knowing the key
    expect(redact('Incorrect API key provided: sk-proj-abc123****wxyz.')).toBe(
      'Incorrect API key provided: [key].',
    );
    expect(redact('bad sk-ant-api03-AbCdEf_123456 here')).toBe('bad [key] here');
    expect(redact('see AIzaSyAAAAAAAAAAAAAAAAAAAAA')).toBe('see [key]');
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).toBe(
      'Authorization: Bearer [key]',
    );
    expect(
      providerMessage({ error: { message: 'Key my-own-secret-key failed' } }, 'my-own-secret-key'),
    ).toBe('Key [key] failed');
  });

  it('redacts Google’s newer keys and tokens, others’ keys and long random runs', () => {
    // Gemini keys of the newer shape (the owner's), and Google OAuth tokens
    expect(redact('key AQ.Ab8RN6Kx_q-0123456789abcdefgh was refused')).toBe(
      'key [key] was refused',
    );
    expect(redact('token ya29.a0AfH6SMBx-12345abcdef.more here')).toBe('token [key] here');
    // Stripe-style secret keys
    expect(redact('got sk_live_51HabcDEF123456 instead')).toBe('got [key] instead');
    // The dotted tail of an OpenAI key goes too
    expect(redact('Incorrect API key provided: sk-proj-abc.def123.')).toBe(
      'Incorrect API key provided: [key].',
    );
    // Long base64 and hex runs
    expect(redact('sig dGhpcyBpcyBhIHNlY3JldCB0b2tlbiBvZiBzb21lIGtpbmQ9PQ== end')).toBe(
      'sig [key] end',
    );
    expect(redact(`id ${'0123456789abcdef'.repeat(3)} end`)).toBe('id [key] end');
    // Names and addresses in a message stay readable.
    const plain =
      'models/gemini-2.5-flash-image-preview-09-2025 is not found for API version v1beta';
    expect(redact(plain)).toBe(plain);
  });

  it('says which provider turned a request down, and what it said', () => {
    const e = failure('gemini', 400, {
      error: {
        message: 'Image input modality is not enabled for models/x',
        status: 'INVALID_ARGUMENT',
      },
    });
    expect(e.kind).toBe('unreadable');
    expect(e.message).toBe(
      'Gemini turned the request down (400): Image input modality is not enabled for models/x.',
    );
    expect(failure('openai', 404, {}).message).toBe('OpenAI turned the request down (404).');
    expect(failure('anthropic', 529, { error: { message: 'Overloaded' } }).message).toBe(
      'Claude couldn’t answer just now (529): Overloaded. Try again in a moment.',
    );
    expect(failure('openai', 429, { error: { message: 'Rate limit reached' } }).kind).toBe('quota');
  });

  it('takes a 403 for a refused request, not a bad key, unless the provider says so', () => {
    const verify = failure('openai', 403, {
      error: {
        message:
          'Your organization must be verified to use the model `gpt-image-1`. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization',
      },
    });
    expect(verify.kind).toBe('refused');
    expect(verify.message).toMatch(/^OpenAI refused the request \(403\): Your organization must/);
    // Our words follow theirs as a sentence of its own.
    expect(verify.message).toMatch(/Verify Organization\.$/);
    expect(verify.message).not.toContain('AI settings');
    expect(failure('gemini', 403, { error: { message: 'API key not valid.' } }).kind).toBe('key');
    expect(failure('openai', 403, { error: { message: 'x', code: 'invalid_api_key' } }).kind).toBe(
      'key',
    );
  });

  it('leaves out the pointer to AI settings inside AI settings', () => {
    const e = failure('openai', 401, {});
    expect(e.message).toBe('The key was refused. Check it in AI settings.');
    expect(inSettings(e)).toBe('The key was refused.');
    const other = failure('gemini', 404, { error: { message: 'Not found' } });
    expect(inSettings(other)).toBe(other.message);
  });

  it('takes Gemini’s 400 for a bad key as a key error', () => {
    const body = {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ],
      },
    };
    const e = failure('gemini', 400, body);
    expect(e.kind).toBe('key');
    expect(e.message).toBe('The key was refused. Check it in AI settings.');
    expect(
      failure('gemini', 400, { error: { details: [{ reason: 'API_KEY_INVALID' }] } }).kind,
    ).toBe('key');
    expect(
      failure('openai', 401, { error: { message: 'Incorrect API key provided: sk-x' } }).kind,
    ).toBe('key');
  });
});
