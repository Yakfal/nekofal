import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlaylists } from '../contexts/PlaylistsContext.jsx';
import './PlaylistMenu.css';

const MENU_WIDTH = 224;

const toPayload = (video) => ({
  id: video?.id ?? '',
  title: String(video?.videoTitle || video?.title || 'Untitled Video').trim(),
  videoUrl: video?.videoUrl || video?.url || '',
  thumbnailUrl: video?.thumbnailUrl || video?.thumbnail || '',
  duration: Number(video?.duration) || 0,
  sourceSite: video?.sourceSite || video?.type || video?.category || '',
  category: video?.category || video?.sourceSite || ''
});

/**
 * Portal-rendered "Add to playlist" dropdown.
 *
 * The old inline menu was clipped by .media-card (overflow: hidden), so the
 * dropdown is rendered into document.body with fixed positioning anchored to
 * the trigger button, opened directly below it and clamped to the viewport.
 */
const PlaylistMenu = ({
  video,
  buttonClassName = 'favorite-btn playlist-btn',
  buttonContent = '⊕',
  buttonTitle = 'Add to playlist',
  onOpenChange
}) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [newName, setNewName] = useState('');
  const triggerRef = useRef(null);
  const { playlists, addItem, create } = usePlaylists();

  const close = useCallback(() => {
    setOpen(false);
    setAnchor(null);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const openMenu = useCallback((e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const rows = Math.min(playlists.length, 6);
    const estHeight = rows * 34 + 112 + (playlists.length > 6 ? 10 : 0);
    let top = r.bottom + 6;
    if (top + estHeight > window.innerHeight - 12) {
      top = Math.max(8, r.top - estHeight - 6);
    }
    setAnchor({
      top,
      left: Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
    });
    setOpen(true);
    onOpenChange?.(true);
  }, [playlists.length, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (triggerRef.current && triggerRef.current.contains(e.target)) return;
      if (e.target && e.target.closest && e.target.closest('.pm-menu')) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  const handlePick = async (playlistId) => {
    await addItem(playlistId, toPayload(video));
    close();
  };

  const handleCreateAndAdd = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const res = await create(name, '');
    if (res?.success && res.playlist?.id) {
      await handlePick(res.playlist.id);
    }
    setNewName('');
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClassName + (open ? ' active' : '')}
        onClick={openMenu}
        aria-label={buttonTitle}
        aria-haspopup="true"
        aria-expanded={open}
        title={buttonTitle}
      >
        {buttonContent}
      </button>

      {open && anchor && createPortal(
        <div className="pm-backdrop">
          <div className="pm-menu" style={{ top: anchor.top, left: anchor.left, minWidth: MENU_WIDTH, zIndex: 9999 }}>
            <div className="pm-menu-title">Add to playlist</div>
            <div className="pm-menu-scroll">
              {playlists.length === 0 && (
                <div className="pm-menu-empty">No playlists yet.</div>
              )}
              {playlists.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="pm-menu-item"
                  onClick={() => handlePick(p.id)}
                >
                  {p.name}
                  <span className="pm-menu-count">{p.itemCount}</span>
                </button>
              ))}
            </div>
            <div className="pm-menu-new">
              <input
                className="pm-menu-input"
                placeholder="New playlist…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateAndAdd(e); }}
              />
              <button className="pm-menu-create" onClick={handleCreateAndAdd}>+</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default PlaylistMenu;