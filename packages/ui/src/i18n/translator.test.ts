import { describe, expect, it } from 'vitest';
import { EN } from './en.js';
import { IT } from './it.js';
import { Translator } from './translator.js';

describe('translations (F431, F432)', () => {
  it('defines every key in English and Italian', () => {
    expect(Object.keys(IT).sort()).toEqual(Object.keys(EN).sort());
    for (const text of Object.values(IT)) expect(text.trim()).not.toBe('');
  });

  it('keeps the same placeholders in every language', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{\w+\}/g)].map(String).sort();
    for (const key of Object.keys(EN) as (keyof typeof EN)[])
      expect(placeholders(IT[key])).toEqual(placeholders(EN[key]));
  });

  it('switches language at runtime and formats numbers by locale', () => {
    const i18n = new Translator();
    const changes: string[] = [];
    i18n.onChange(() => changes.push(i18n.language));
    expect(i18n.t('zoom.in')).toBe('Zoom in');
    expect(i18n.formatNumber(1234.5)).toBe('1,234.5');
    i18n.setLanguage('it');
    expect(i18n.t('zoom.in')).toBe('Ingrandisci');
    expect(i18n.formatNumber(1234.5)).toBe('1234,5');
    expect(changes).toEqual(['it']);
    expect(() => i18n.setLanguage('xx')).toThrow(RangeError);
  });

  it('registers a new language with English fallback and overrides single strings', () => {
    const i18n = new Translator();
    i18n.registerLanguage('de', { 'zoom.in': 'Vergrößern' });
    i18n.setLanguage('de');
    expect(i18n.t('zoom.in')).toBe('Vergrößern');
    expect(i18n.t('zoom.out')).toBe('Zoom out');
    i18n.setLanguage('en');
    i18n.overrideStrings('en', { 'zoom.out': 'Smaller' });
    expect(i18n.t('zoom.out')).toBe('Smaller');
    expect(i18n.t('zoom.in')).toBe('Zoom in');
    expect(i18n.t('compass.label', { heading: '90°' })).toContain('heading 90°');
  });
});
