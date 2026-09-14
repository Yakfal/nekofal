import React, { useState } from 'react';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import Adult from '../pages/Adult.jsx';
import './AdultGate.css';

const AdultGate = () => {
  const { settings, unlocked, unlock, hasFamilyPasscode } = useAppSettings();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  if (!settings.familyMode || unlocked) {
    return <Adult />;
  }

  const handleUnlock = async (e) => {
    e.preventDefault();
    const ok = await unlock(code);
    if (ok) {
      setCode('');
      setError('');
    } else {
      setError('Incorrect passcode');
    }
  };

  return (
    <div className="adult-gate">
      <div className="adult-gate-card">
        <div className="adult-gate-lock">🔒</div>
        <h2>Family Mode is on</h2>
        {hasFamilyPasscode() ? (
          <>
            <p>Adult content is hidden in Family Mode. Enter the family passcode to unlock this section for this session.</p>
            <form className="adult-gate-form" onSubmit={handleUnlock}>
              <input
                type="password"
                className="adult-gate-input"
                placeholder="Family passcode"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
              <button type="submit" className="adult-gate-btn">Unlock</button>
            </form>
            {error && <div className="adult-gate-error">{error}</div>}
            <p className="adult-gate-hint">The session unlocks until you switch pages or Family Mode is toggled off.</p>
          </>
        ) : (
          <p>Adult content is hidden in Family Mode and this section is blocked. Set a family passcode in Settings to allow temporary unlocks.</p>
        )}
      </div>
    </div>
  );
};

export default AdultGate;