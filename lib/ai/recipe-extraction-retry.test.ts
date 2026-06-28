import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '@google/genai';

/**
 * Retry-on-transient-overload tests (the Sentry "503 high demand" fix). The Gemini
 * 3.5 Flash model is routinely overloaded under launch demand and returns a 503 (or
 * 429); without retries a single spike makes photo import look broken. These mock the
 * SDK (CLAUDE.md: the provider is always mocked, never hit for real) and assert that
 * `getRecipeExtractor().extract()` retries transient failures but fails fast on a
 * non-transient one. `Math.random` is pinned to 0 so the jittered backoff sleeps 0ms.
 */

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));

vi.mock('@/lib/env', () => ({ aiEnv: () => ({ apiKey: 'test-key' }) }));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    // A regular function (not an arrow) so it is newable as a constructor.
    GoogleGenAI: vi.fn(function () {
      return { models: { generateContent: mockGenerate } };
    }),
  };
});

// Imported AFTER the mocks so the module under test picks up the mocked SDK.
const { getRecipeExtractor, RecipeExtractionError } = await import('./recipe-extraction');

const goodRecipe = {
  name: 'Pão de Ló',
  yieldPortions: 8,
  ingredients: [{ name: 'Farinha', quantity: 250, unit: 'g', confidence: 0.98 }],
  preparationNotes: null,
  overallConfidence: 0.94,
  imageQuality: 'good',
};

const okResponse = {
  text: JSON.stringify(goodRecipe),
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
};

const input = { imageBytes: Buffer.from('fake-image'), mimeType: 'image/jpeg' };

const overloaded = () =>
  new ApiError({ message: 'This model is currently experiencing high demand.', status: 503 });

beforeEach(() => {
  mockGenerate.mockReset();
  vi.spyOn(Math, 'random').mockReturnValue(0); // backoff window * 0 ⇒ sleep(0)
});

afterEach(() => vi.restoreAllMocks());

describe('getRecipeExtractor — transient overload retry', () => {
  it('retries a 503 and succeeds on a later attempt', async () => {
    mockGenerate
      .mockRejectedValueOnce(overloaded())
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValueOnce(okResponse);

    const result = await getRecipeExtractor().extract(input);

    expect(result.recipe.name).toBe('Pão de Ló');
    expect(mockGenerate).toHaveBeenCalledTimes(3);
    // The provider-call count is surfaced for the eval harness's retry-rate metric.
    expect(result.attempts).toBe(3);
  });

  it('reports a single attempt on a first-try success', async () => {
    mockGenerate.mockResolvedValueOnce(okResponse);
    const result = await getRecipeExtractor().extract(input);
    expect(result.attempts).toBe(1);
  });

  it('also retries a 429 (rate limited)', async () => {
    mockGenerate
      .mockRejectedValueOnce(new ApiError({ message: 'rate limited', status: 429 }))
      .mockResolvedValueOnce(okResponse);

    await expect(getRecipeExtractor().extract(input)).resolves.toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('gives up after the max attempts and flags the failure as retryable (busy)', async () => {
    mockGenerate.mockRejectedValue(overloaded());

    const err = await getRecipeExtractor()
      .extract(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeExtractionError);
    expect((err as InstanceType<typeof RecipeExtractionError>).retryable).toBe(true);
    expect(mockGenerate).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-transient error (400) — fails fast and is not retryable', async () => {
    mockGenerate.mockRejectedValue(new ApiError({ message: 'bad request', status: 400 }));

    const err = await getRecipeExtractor()
      .extract(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeExtractionError);
    expect((err as InstanceType<typeof RecipeExtractionError>).retryable).toBe(false);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});
