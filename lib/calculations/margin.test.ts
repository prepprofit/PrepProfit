import { describe, expect, it } from 'vitest';
import { marginPercent, suggestedPriceCents, trafficLight } from './margin';

describe('marginPercent', () => {
  it('computes gross margin on the price', () => {
    expect(marginPercent(117, 390)).toBe(70);
    expect(marginPercent(50, 100)).toBe(50);
    expect(marginPercent(100, 100)).toBe(0);
  });

  it('is negative when cost exceeds price', () => {
    expect(marginPercent(120, 100)).toBe(-20);
  });

  it('returns 0 when there is no price', () => {
    expect(marginPercent(50, 0)).toBe(0);
  });
});

describe('suggestedPriceCents', () => {
  it('prices to hit a target margin', () => {
    expect(suggestedPriceCents(117, 70)).toBe(390);
    expect(suggestedPriceCents(300, 50)).toBe(600);
  });

  it('returns 0 for an unreachable target', () => {
    expect(suggestedPriceCents(100, 100)).toBe(0);
    expect(suggestedPriceCents(100, 120)).toBe(0);
  });
});

describe('trafficLight', () => {
  it('greens healthy margins, reds thin ones', () => {
    expect(trafficLight(70)).toBe('green');
    expect(trafficLight(65)).toBe('green');
    expect(trafficLight(50)).toBe('yellow');
    expect(trafficLight(40)).toBe('yellow');
    expect(trafficLight(39.9)).toBe('red');
    expect(trafficLight(-20)).toBe('red');
  });
});
