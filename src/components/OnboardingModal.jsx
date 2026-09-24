import React, { useMemo, useState } from 'react';
import { useLanguage, SUPPORTED_LANGUAGES, isSupportedLanguage, ONBOARDED_KEY, APP_LANG_KEY } from '../i18n/LanguageContext.jsx';
import './OnboardingModal.css';

const isOnboarded = () => {
  try { return localStorage.getItem(ONBOARDED_KEY) === 'true'; } catch { return false; }
};

const OnboardingModal = () => {
  const { language, setLanguage, t } = useLanguage();
  const [onboarded, setOnboarded] = useState(isOnboarded);
  const [selected, setSelected] = useState(language);

  const languages = useMemo(() => SUPPORTED_LANGUAGES, []);

  if (onboarded) return null;

  const choose = (code) => {
    if (!isSupportedLanguage(code)) return;
    setLanguage(code);
    try {
      localStorage.setItem(APP_LANG_KEY, code);
      localStorage.setItem(ONBOARDED_KEY, 'true');
    } catch { /* storage unavailable */ }
    setSelected(code);
    setOnboarded(true);
  };

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label={t('onboarding.title')}>
      <div className="onboarding-card">
        <div className="onboarding-mark" aria-hidden="true">▶</div>
        <h2 className="onboarding-title">{t('onboarding.title')}</h2>
        <p className="onboarding-sub">{t('onboarding.subtitle')}</p>

        <div className="onboarding-langs">
          {languages.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`onboarding-lang ${selected === l.code ? 'selected' : ''}`}
              onClick={() => choose(l.code)}
            >
              {l.nativeName}
            </button>
          ))}
        </div>

        <p className="onboarding-hint">{t('onboarding.hint')}</p>
      </div>
    </div>
  );
};

export default OnboardingModal;
