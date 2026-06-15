import { describe, expect, it } from 'vitest';
import {
  dimensionOf,
  displayUnitsFor,
  formatInUnit,
  formatQuantity,
  fromCanonical,
  pickDisplayUnit,
  toCanonical,
  type Unit,
} from './index';

describe('toCanonical / fromCanonical', () => {
  it('converts metric weight', () => {
    expect(toCanonical(1, 'kg')).toBe(1000);
    expect(toCanonical(250, 'g')).toBe(250);
    expect(fromCanonical(1500, 'kg')).toBe(1.5);
  });

  it('converts imperial weight against known constants', () => {
    expect(toCanonical(1, 'lb')).toBeCloseTo(453.59237, 5);
    expect(toCanonical(1, 'oz')).toBeCloseTo(28.349523125, 6);
    expect(fromCanonical(1000, 'lb')).toBeCloseTo(2.2046226, 6);
  });

  it('converts metric volume', () => {
    expect(toCanonical(1, 'l')).toBe(1000);
    expect(fromCanonical(2500, 'l')).toBe(2.5);
  });

  it('converts imperial volume (US customary)', () => {
    expect(toCanonical(1, 'cup')).toBeCloseTo(236.5882365, 6);
    expect(fromCanonical(1000, 'floz')).toBeCloseTo(33.8140227, 6);
  });

  it('treats count as a passthrough', () => {
    expect(toCanonical(12, 'count')).toBe(12);
    expect(fromCanonical(12, 'count')).toBe(12);
  });

  it('round-trips through canonical for every unit', () => {
    const units: Unit[] = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'floz', 'cup', 'count'];
    for (const unit of units) {
      expect(fromCanonical(toCanonical(3.7, unit), unit)).toBeCloseTo(3.7, 9);
    }
  });
});

describe('dimensionOf', () => {
  it('maps each unit to its dimension', () => {
    expect(dimensionOf('kg')).toBe('weight');
    expect(dimensionOf('floz')).toBe('volume');
    expect(dimensionOf('count')).toBe('count');
  });
});

describe('pickDisplayUnit', () => {
  it('picks g vs kg by magnitude (metric weight)', () => {
    expect(pickDisplayUnit(500, 'weight', 'metric')).toBe('g');
    expect(pickDisplayUnit(1000, 'weight', 'metric')).toBe('kg');
  });

  it('picks oz vs lb by magnitude (imperial weight)', () => {
    expect(pickDisplayUnit(400, 'weight', 'imperial')).toBe('oz');
    expect(pickDisplayUnit(500, 'weight', 'imperial')).toBe('lb');
  });

  it('picks ml vs l and floz vs cup for volume', () => {
    expect(pickDisplayUnit(250, 'volume', 'metric')).toBe('ml');
    expect(pickDisplayUnit(1000, 'volume', 'metric')).toBe('l');
    expect(pickDisplayUnit(100, 'volume', 'imperial')).toBe('floz');
    expect(pickDisplayUnit(300, 'volume', 'imperial')).toBe('cup');
  });

  it('always uses count for the count dimension', () => {
    expect(pickDisplayUnit(3, 'count', 'imperial')).toBe('count');
  });
});

describe('displayUnitsFor', () => {
  it('returns the unit choices per dimension and system', () => {
    expect(displayUnitsFor('weight', 'metric')).toEqual(['g', 'kg']);
    expect(displayUnitsFor('weight', 'imperial')).toEqual(['oz', 'lb']);
    expect(displayUnitsFor('volume', 'metric')).toEqual(['ml', 'l']);
    expect(displayUnitsFor('volume', 'imperial')).toEqual(['floz', 'cup']);
    expect(displayUnitsFor('count', 'metric')).toEqual(['count']);
  });
});

describe('formatQuantity / formatInUnit', () => {
  it('formats canonical amounts with the picked unit', () => {
    expect(formatQuantity(1500, 'weight', 'metric')).toBe('1.5 kg');
    expect(formatQuantity(250, 'weight', 'metric')).toBe('250 g');
    expect(formatQuantity(2500, 'volume', 'metric')).toBe('2.5 l');
  });

  it('renders count as a bare number', () => {
    expect(formatQuantity(12, 'count', 'metric')).toBe('12');
  });

  it('formats a value already in a unit', () => {
    expect(formatInUnit(2.5, 'kg')).toBe('2.5 kg');
    expect(formatInUnit(8, 'floz')).toBe('8 fl oz');
  });
});
