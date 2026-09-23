// Renderer-facing wrapper around the shared CJS content-safety module so the
// main process and the renderer stay in sync on one keyword list.
import contentSafety from '../../electron/contentSafety.cjs';

export default contentSafety.isAdultMedia;