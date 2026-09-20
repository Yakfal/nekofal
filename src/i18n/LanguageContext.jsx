import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './locales/en.js';
import es from './locales/es.js';
import fr from './locales/fr.js';
import de from './locales/de.js';
import pt from './locales/pt.js';
import it from './locales/it.js';
import ja from './locales/ja.js';
import zh from './locales/zh.js';
import ru from './locales/ru.js';
import ko from './locales/ko.js';

export const STORAGE_KEY = 'nekofal-language';

// All supported languages, listed in native script for the Settings selector.
export const SUPPORTED_LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'es', nativeName: 'Español' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'pt', nativeName: 'Português' },
  { code: 'it', nativeName: 'Italiano' },
  { code: 'ja', nativeName: '日本語' },
  { code: 'zh', nativeName: '简体中文' },
  { code: 'ru', nativeName: 'Русский' },
  { code: 'ko', nativeName: '한국어' },
];

export const TRANSLATIONS = { en, es, fr, de, pt, it, ja, zh, ru, ko };

export const isSupportedLanguage = (code) => Boolean(code && TRANSLATIONS[code]);

// Default to the browser's UI language when no explicit choice is saved.
const detectBrowserLanguage = () => {
  try {
    const lang = String(navigator.language || (navigator.languages && navigator.languages[0]) || 'en').toLowerCase();
    if (isSupportedLanguage(lang)) return lang;
    const base = lang.split('-')[0];
    if (isSupportedLanguage(base)) return base;
  } catch { /* keep default */ }
  return 'en';
};

const loadLanguage = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isSupportedLanguage(saved)) return saved;
  } catch { /* keep default */ }
  return detectBrowserLanguage();
};

const LanguageContext = createContext({
  language: 'en',
  setLanguage: () => {},
  t: (key) => key,
});

export const LanguageProvider = ({ children }) => {
  const [language, setLang] = useState(loadLanguage);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch { /* storage unavailable — session-only */}
    document.documentElement.setAttribute('lang', language);
  }, [language]);

  const setLanguage = useCallback((code) => {
    if (isSupportedLanguage(code)) setLang(code);
  }, []);

  // Simple dot-key lookup with graceful fallback to English, then to the key.
  const t = useCallback((key) => {
    const dict = TRANSLATIONS[language] || en;
    if (key in dict) return dict[key];
    if (key in en) return en[key];
    return key;
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);

export default LanguageContext;