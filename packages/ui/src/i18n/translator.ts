/**
 * Translations of the UI strings: English and Italian built in, more languages and single-string overrides registered
 * by the application at runtime. A key missing from a language falls back to English.
 */
import { EN, type TranslationKey } from './en.js';
import { IT } from './it.js';

/** Strings of one language; keys left out fall back to English. */
export type Translations = Partial<Record<TranslationKey, string>>;

/** Looks up UI strings in the current language. */
export class Translator {
  readonly #languages = new Map<string, Translations>([
    ['en', EN],
    ['it', IT],
  ]);
  readonly #overrides = new Map<string, Translations>();
  readonly #listeners = new Set<() => void>();
  #language = 'en';

  /** The current language code (BCP 47), which also selects the number format. */
  get language(): string {
    return this.#language;
  }

  /** Codes of the registered languages. */
  languages(): string[] {
    return [...this.#languages.keys()];
  }

  /** Switches the language; throws a RangeError for one not registered. Controls update at once. */
  setLanguage(code: string): void {
    if (!this.#languages.has(code)) throw new RangeError(`Language "${code}" is not registered`);
    if (code === this.#language) return;
    this.#language = code;
    this.#changed();
  }

  /** Registers or replaces a language; its missing keys fall back to English. */
  registerLanguage(code: string, strings: Translations): void {
    this.#languages.set(code, { ...strings });
    if (code === this.#language) this.#changed();
  }

  /** Replaces single strings of a language, leaving the others as they are. */
  overrideStrings(code: string, strings: Translations): void {
    this.#overrides.set(code, { ...this.#overrides.get(code), ...strings });
    if (code === this.#language) this.#changed();
  }

  /** The string for `key` in the current language, with `{name}` placeholders replaced from `params`. */
  t(key: TranslationKey, params: Readonly<Record<string, string>> = {}): string {
    const language = this.#language;
    const text =
      this.#overrides.get(language)?.[key] ??
      this.#languages.get(language)?.[key] ??
      this.#overrides.get('en')?.[key] ??
      EN[key];
    return text.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
  }

  /** Formats a number in the current language's format. */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.#language, options).format(value);
  }

  /** Calls `listener` after every change of language or strings; returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
