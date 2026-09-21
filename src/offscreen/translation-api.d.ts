// Minimal ambient types for the Chrome on-device Translation API (Chrome 138+),
// which is not yet in @types or the DOM lib. Feature-detected at runtime.

type TranslationAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface SRTranslator {
  translate(input: string): Promise<string>;
  destroy(): void;
}
interface SRTranslatorStatic {
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<SRTranslator>;
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<TranslationAvailability>;
}

interface SRLanguageDetectorResult {
  detectedLanguage: string;
  confidence: number;
}
interface SRLanguageDetector {
  detect(input: string): Promise<SRLanguageDetectorResult[]>;
  destroy(): void;
}
interface SRLanguageDetectorStatic {
  create(opts?: unknown): Promise<SRLanguageDetector>;
  availability(opts?: unknown): Promise<TranslationAvailability>;
}

declare const Translator: SRTranslatorStatic | undefined;
declare const LanguageDetector: SRLanguageDetectorStatic | undefined;
