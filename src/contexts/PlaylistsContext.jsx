import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { autoSync } from '../services/dbAdapter.js';

const getApi = () => window.api || window.electronAPI;

const PlaylistsContext = createContext({
  playlists: [],
  loading: false,
  refresh: () => {},
  create: async () => ({}),
  remove: async () => {},
  addItem: async () => ({}),
  removeItem: async () => {},
});

export const PlaylistsProvider = ({ children }) => {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const api = getApi();
    if (!api || !api.getPlaylists) return;
    try {
      setLoading(true);
      const res = await api.getPlaylists();
      if (res?.success) setPlaylists(res.data || []);
    } catch (err) {
      console.error('[Playlists] refresh failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(async (name, description) => {
    const api = getApi();
    if (!api || !api.createPlaylist) return { success: false, error: 'Not available' };
    const res = await api.createPlaylist(name, description);
    if (res?.success) {
      await refresh();
      autoSync();
    }
    return res;
  }, [refresh]);

  const remove = useCallback(async (playlistId) => {
    const api = getApi();
    if (!api || !api.deletePlaylist) return;
    await api.deletePlaylist(playlistId);
    await refresh();
    autoSync();
  }, [refresh]);

  const addItem = useCallback(async (playlistId, video) => {
    const api = getApi();
    if (!api || !api.addToPlaylist) return { success: false, error: 'Not available' };
    const res = await api.addToPlaylist(playlistId, video);
    if (res?.success) {
      await refresh();
      autoSync();
    }
    return res;
  }, [refresh]);

  const removeItem = useCallback(async (itemId) => {
    const api = getApi();
    if (!api || !api.removeFromPlaylist) return;
    await api.removeFromPlaylist(itemId);
    autoSync();
  }, []);

  const value = useMemo(() => ({
    playlists,
    loading,
    refresh,
    create,
    remove,
    addItem,
    removeItem,
  }), [playlists, loading, refresh, create, remove, addItem, removeItem]);

  return (
    <PlaylistsContext.Provider value={value}>
      {children}
    </PlaylistsContext.Provider>
  );
};

export const usePlaylists = () => useContext(PlaylistsContext);

export default PlaylistsContext;