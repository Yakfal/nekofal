// Single global media-key registry so only the active player handles hardware
// play/pause/stop/next/prev keys. Players bind on mount and unbind on unmount;
// the browser window that holds the registry forwards main-process key events.
let handlers = {
  playpause: null,
  stop: null,
  next: null,
  previous: null
};

export const bindMediaKey = (key, fn) => {
  if (Object.prototype.hasOwnProperty.call(handlers, key)) handlers[key] = fn;
};

export const unbindMediaKey = (key) => {
  if (Object.prototype.hasOwnProperty.call(handlers, key)) handlers[key] = null;
};

const triggerMediaKey = (key) => {
  const fn = handlers[key];
  if (typeof fn === 'function') {
    try { fn(); } catch (err) { console.warn('[MediaKey] handler error:', err.message); }
  }
};

// Install once at app startup: forwards 'global-media-key' IPC to the registry.
export const installMediaKeyBridge = () => {
  const api = window.api || window.electronAPI;
  return api?.onGlobalMediaKey?.((key) => triggerMediaKey(key));
};