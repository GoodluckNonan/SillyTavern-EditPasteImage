/**
 * PCD Extension — Paster / Compresser / Downloader
 * ------------------------------------------------------------------
 * Three things a chat image needs, in one frontend extension:
 *
 * 1. **Paster** — paste or drop an image straight into the *message edit* box
 *    (the pencil / `.mes_edit` button), exactly like pasting into the
 *    unsent-message box (`#send_textarea`) already works.
 * 2. **Compresser** — optional: re-encode oversized images before upload so they
 *    fit a size budget, without touching images that already fit.
 * 3. **Downloader** — save an image (or a generated video) back out of the app:
 *    a corner control inside the chat lightbox and the gallery window, plus
 *    hold-to-save on touch screens.
 *
 * Upstream background:
 *  - Unsent box: `public/scripts/chats.js` binds a `paste` listener on
 *    `#send_textarea` and feeds `event.clipboardData.files` into the
 *    `#file_form_input` attachment flow.
 *  - Edit box: `messageEdit()` in `public/script.js` renders
 *    `<textarea id="curEditTextarea" class="edit_textarea">` and there is
 *    **no** paste listener at all.
 *
 * A pasted image is uploaded through the standard `/api/images/upload` endpoint
 * (the same one `saveBase64AsFile()` uses for the built-in attachment button) and
 * attached to the message being edited as `message.extra.media[]` with
 * `source: 'upload'` + `inline_image: true` — the exact same data shape the
 * built-in "embed file into message" (`.mes_embed`) button produces, so the
 * chat file stays compatible with desktop SillyTavern.
 *
 * Compatibility target: SillyTavern 1.18.x frontend (TauriTavern is synced
 * to 1.18.0). Deliberately avoids `??` / `?.` in *call* position and uses
 * `document.activeElement` + `element.closest()` instead of newer DOM helpers,
 * because Android System WebView on older phones lags behind. No bundler, no
 * dependency beyond the host app itself.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { translate as translateString } from '../../../i18n.js';

/** Key this extension stores its settings under. */
export const MODULE_NAME = 'pcd-extension';

/**
 * Key the extension used before the 1.5.0 rename. Settings are moved over on
 * first run so nobody loses their compression preferences.
 */
export const LEGACY_MODULE_NAME = 'edit-paste-image';

export const DEBUG_PREFIX = '[PCD] ';

/** Reported in the console and the settings drawer; kept in step with manifest.json. */
export const EXTENSION_VERSION = '1.6.0';

/** Hard cap for a single pasted image (25 MB). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Only these mime types are treated as "image" when nothing else matches. */
const IMAGE_MIME_FALLBACK_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/i;

/** Extension part of a mime type, used to name the uploaded file. */
const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
};

/** Reverse of the map above, for naming the output of a re-encode. */
const EXT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
};

/**
 * Formats accepted by `POST /api/images/upload` (upstream `MEDIA_EXTENSIONS`
 * in `src/constants.js`). Anything else — notably `svg` and `avif` — is
 * rejected by the endpoint with `400 Invalid image format`, so we re-encode
 * those to PNG when the browser can, and only then upload.
 * @type {string[]}
 */
const IMAGE_UPLOAD_FORMATS = ['bmp', 'png', 'jpg', 'webp', 'jpeg', 'jfif', 'gif'];

/** Preferred output formats for automatic compression, best first. */
const COMPRESSION_FORMATS = [
    { mime: 'image/webp', extension: 'webp' },
    { mime: 'image/jpeg', extension: 'jpg' },
];

/** Never shrink below this, however large the source is. */
const COMPRESSION_MIN_EDGE = 320;

/** Candidate sizes tried when quality alone cannot reach the size target. */
const COMPRESSION_SCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.25];

/** Rough quality search steps; the loop stops early as soon as it fits. */
const COMPRESSION_QUALITY_STEPS = 10;

/** Poll interval (ms) for reconciling the edit box UI with the DOM. */
const SYNC_INTERVAL_MS = 500;

/** Injected download control. */
const DOWNLOAD_DONE_ATTR = 'data-tt-editpaste-download';
const DOWNLOAD_ICON_IDLE = 'fa-download';
const DOWNLOAD_ICON_BUSY = ['fa-spinner', 'fa-spin'];
const DOWNLOAD_ICON_DONE = 'fa-check';

/** How long a temporary download URL stays alive so the host can pick it up. */
const DOWNLOAD_BLOB_TTL_MS = 30000;

/** Paths that always belong to the local SillyTavern server. */
const LOCAL_MEDIA_PATH_PREFIXES = ['/user/', '/thumbnails/', '/characters/', '/backgrounds/', '/api/'];

/** Attributes that hold the full size original, ahead of `src`. */
const MEDIA_SOURCE_ATTRS = ['data-ngsrc', 'data-src'];

/** Extensions a link must end in before we treat it as the media itself. */
const MEDIA_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|mp4|webm|mov|m4v|mkv)(?:[?#]|$)/i;

/**
 * Viewer surfaces and the corner controls each one gets.
 *
 * `right` is the downloader. `left` is the gallery-only "jump to the message
 * this image came from" control: a chat lightbox is already *on* its message,
 * so the jump only makes sense for the gallery's floating window.
 */
const VIEWER_SURFACES = [
    { selector: '.img_enlarged_container', download: true, jump: false },
    { selector: '.galleryImageDraggable', download: true, jump: true },
];

const VIEWER_CONTAINER_SELECTORS = VIEWER_SURFACES.map((surface) => surface.selector);

const VIEWER_HOST_CLASS = 'tt-editpaste-viewer';
const VIEWER_DOWNLOAD_CLASS = 'tt-editpaste-viewer-download';
const VIEWER_JUMP_CLASS = 'tt-editpaste-viewer-jump';

/** Which side each corner control is pinned to, for repositioning. */
const VIEWER_CONTROLS = [
    { className: VIEWER_DOWNLOAD_CLASS, side: 'right' },
    { className: VIEWER_JUMP_CLASS, side: 'left' },
];

/** Briefly rings the message a gallery jump landed on. */
const FLASH_CLASS = 'tt-editpaste-flash';

/** How long that ring stays visible (ms), matching the CSS duration. */
const FLASH_HOLD_MS = 1800;

/** The media kinds a viewer can hold: images, plus generated video. */
const MEDIA_ELEMENT_SELECTOR = 'img, video';

/** Gap (px) between a viewer control and the media's own corner. */
const VIEWER_INSET_PX = 12;

/** Selectors whose click opens the chat image lightbox, so we can react to it. */
const LIGHTBOX_OPENER_SELECTOR = '.mes_img, .mes_media_enlarge';

/** Hold this long (ms) on an image to start a download. */
const LONG_PRESS_MS = 600;

/** A finger may drift this far (px) before the long press is cancelled. */
const LONG_PRESS_SLOP_PX = 12;

/** Images smaller than this are chrome (icons), not something worth saving. */
const LONG_PRESS_MIN_EDGE = 64;
/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
    enabled: true,
    max_image_bytes: MAX_IMAGE_BYTES,
    compress_enabled: false,
    compress_target_kb: 500,
    compress_limit_dimension: false,
    compress_max_edge: 2000,
    compress_min_quality: 0.5,
    long_press_download: true,
};

/**
 * Reads this extension's settings block, creating defaults on first run.
 * @returns {any}
 */
export function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        // Carry settings over from the pre-rename key so the compression
        // preferences of existing installs survive the 1.5.0 rename.
        const legacy = extension_settings[LEGACY_MODULE_NAME];
        const carried = legacy && typeof legacy === 'object' ? Object.assign({}, legacy) : null;
        extension_settings[MODULE_NAME] = carried || Object.assign({}, DEFAULT_SETTINGS);
        if (carried) {
            delete extension_settings[LEGACY_MODULE_NAME];
            log('migrated settings from the old "' + LEGACY_MODULE_NAME + '" key');
        }
    }

    const settings = extension_settings[MODULE_NAME];

    // `show_toolbar_button` was dropped in 1.1.0 (the extension no longer
    // injects any UI); clean up the stale key from older installs.
    if ('show_toolbar_button' in settings) {
        delete settings.show_toolbar_button;
    }

    if (typeof settings.enabled !== 'boolean') {
        settings.enabled = DEFAULT_SETTINGS.enabled;
    }
    if (!Number.isFinite(Number(settings.max_image_bytes)) || Number(settings.max_image_bytes) <= 0) {
        settings.max_image_bytes = DEFAULT_SETTINGS.max_image_bytes;
    }

    if (typeof settings.compress_enabled !== 'boolean') {
        settings.compress_enabled = DEFAULT_SETTINGS.compress_enabled;
    }
    if (!Number.isFinite(Number(settings.compress_target_kb)) || Number(settings.compress_target_kb) < 10) {
        settings.compress_target_kb = DEFAULT_SETTINGS.compress_target_kb;
    }
    if (typeof settings.compress_limit_dimension !== 'boolean') {
        settings.compress_limit_dimension = DEFAULT_SETTINGS.compress_limit_dimension;
    }
    if (!Number.isFinite(Number(settings.compress_max_edge)) || Number(settings.compress_max_edge) < 100) {
        settings.compress_max_edge = DEFAULT_SETTINGS.compress_max_edge;
    }
    if (!Number.isFinite(Number(settings.compress_min_quality))
        || Number(settings.compress_min_quality) < 0.1
        || Number(settings.compress_min_quality) > 1) {
        settings.compress_min_quality = DEFAULT_SETTINGS.compress_min_quality;
    }
    if (typeof settings.long_press_download !== 'boolean') {
        settings.long_press_download = DEFAULT_SETTINGS.long_press_download;
    }

    return settings;
}

/**
 * Reads a numeric input and clamps it into range.
 * @param {any} input
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function readClampedNumber(input, min, max, fallback) {
    const value = Number(input && input.value);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

/**
 * Translates a source string through the host locale data when available.
 *
 * The string itself is the translation key, matching how SillyTavern's own
 * translation works: if no entry exists in the locale file the source text is
 * returned unchanged. Two sources are tried because not every host exposes the
 * helper on the extension context (TauriTavern included), so the module export
 * comes first and the context is the fallback. Hosts older than the i18n module
 * simply get the source text.
 *
 * @param {string} text
 * @returns {string}
 */
function translateText(text) {
    try {
        if (typeof translateString === 'function') {
            const result = translateString(text);
            if (typeof result === 'string' && result) {
                return result;
            }
        }
    } catch (error) {
        log('translation lookup failed', error);
    }

    const ctx = safeContext();
    if (ctx && typeof ctx.translate === 'function') {
        try {
            const result = ctx.translate(text);
            if (typeof result === 'string' && result) {
                return result;
            }
        } catch (error) {
            log('context translation lookup failed', error);
        }
    }

    return text;
}

/**
 * Shows a time limited toast through the host, translating the text first.
 *
 * Translation happens *before* the placeholders are filled, otherwise the filled
 * string no longer matches the locale key and the toast stays English.
 *
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {string} message
 * @param {...any} values values for `${0}`, `${1}`, …
 */
function notify(level, message, ...values) {
    const text = fillPlaceholders(translateText(message), ...values);
    const ctx = safeContext();
    const hosts = [typeof toastr !== 'undefined' ? toastr : null, ctx ? ctx.toastr : null];

    for (const host of hosts) {
        if (host && typeof host[level] === 'function') {
            host[level](text);
            return;
        }
    }

    if (level === 'error' || level === 'warning') {
        console.warn(DEBUG_PREFIX, text);
    } else {
        log(text);
    }
}

/**
 * Fills `${0}`, `${1}`, … placeholders the same way SillyTavern's `t` does, so
 * translated and untranslated strings report identical numbers.
 * @param {string} template
 * @param {...any} values
 * @returns {string}
 */
function fillPlaceholders(template, ...values) {
    return String(template).replace(/\$\{(\d+)\}/g, (match, index) => {
        const value = values[Number(index)];
        return value === undefined ? match : String(value);
    });
}

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Logs through the host logger when available.
 * @param {...any} args
 */
function log(...args) {
    const ctx = safeContext();
    if (ctx && ctx.console && typeof ctx.console.log === 'function') {
        ctx.console.log(DEBUG_PREFIX, ...args);
        return;
    }
    console.log(DEBUG_PREFIX, ...args);
}

/**
 * Returns the ST context, or `null` when the host is not ready yet.
 * @returns {any|null}
 */
function safeContext() {
    try {
        const ctx = getContext();
        return ctx && typeof ctx === 'object' ? ctx : null;
    } catch (error) {
        return null;
    }
}

/**
 * Reads a Blob as a data URL (`data:image/png;base64,...`).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('Failed to read the pasted image'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Picks a file extension for a mime type.
 * @param {string} mime
 * @returns {string}
 */
function extensionForMime(mime) {
    const normalized = String(mime || '').toLowerCase();
    if (MIME_TO_EXT[normalized]) {
        return MIME_TO_EXT[normalized];
    }
    const slash = normalized.indexOf('/');
    const guess = slash >= 0 ? normalized.slice(slash + 1) : '';
    return guess && /^[a-z0-9]+$/.test(guess) ? guess : 'png';
}

/** Shared decode helper: loads a blob into an HTMLImageElement. */
const decodeToImage = (blob) => new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
    };
    image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('decode failed'));
    };
    image.src = objectUrl;
});

/** Shared encode helper: draws a source into a canvas of the given size. */
const encodeToBlob = (source, width, height, mime, quality) => new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext('2d');
    if (context) {
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    if (typeof canvas.toBlob !== 'function') {
        resolve(null);
        return;
    }
    if (quality === undefined) {
        canvas.toBlob((blob) => resolve(blob), mime);
    } else {
        canvas.toBlob((blob) => resolve(blob), mime, quality);
    }
});

/** Human readable size, for user facing messages. */
function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) {
        return value + ' B';
    }
    if (value < 1024 * 1024) {
        return Math.max(1, Math.round(value / 1024)) + ' KB';
    }
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Re-encodes an image so that it fits the configured size target.
 *
 * Priority: the file size limit comes first. The long edge limit is only
 * applied when it is turned on, and it stops shrinking as soon as the size
 * target is already met.
 *
 * @param {File|Blob} file
 * @param {any} settings
 * @returns {Promise<{blob: Blob, extension: string, compressed: boolean, bytes: number, width: number, height: number, targetKb: number, format: string}|null>}
 *          `null` when there is nothing to do (feature off, already small
 *          enough, or the browser cannot re-encode).
 */
export async function compressImageIfNeeded(file, settings) {
    if (!settings || !settings.compress_enabled) {
        return null;
    }

    const targetBytes = Math.max(10, Number(settings.compress_target_kb) || 0) * 1024;
    if (!targetBytes) {
        return null;
    }

    if (Number(file.size) <= targetBytes) {
        // Already within the size limit: leave it completely alone.
        return null;
    }

    let source;
    try {
        source = await decodeToImage(file);
    } catch (error) {
        log('Cannot decode image for compression', error);
        return null;
    }

    const naturalWidth = source.naturalWidth || source.width || 0;
    const naturalHeight = source.naturalHeight || source.height || 0;
    if (!naturalWidth || !naturalHeight) {
        return null;
    }

    const baseWidth = Math.min(naturalWidth, Number(settings.compress_max_edge) || naturalWidth);
    const scale = baseWidth / naturalWidth;
    const baseHeight = naturalHeight * scale;
    const minQuality = Math.min(1, Math.max(0.1, Number(settings.compress_min_quality) || 0.5));
    let fallbackResult = null;

    for (const candidate of COMPRESSION_FORMATS) {
        for (const step of COMPRESSION_SCALE_STEPS) {
            let width = Math.round(baseWidth * step);
            let height = Math.round(baseHeight * step);
            const longestEdge = Math.max(width, height);
            if (longestEdge < COMPRESSION_MIN_EDGE) {
                break;
            }

            let low = minQuality;
            let high = 1;
            let best = null;
            let bestAnyQuality = null;

            for (let i = 0; i < COMPRESSION_QUALITY_STEPS; i++) {
                const quality = (low + high) / 2;
                const blob = await encodeToBlob(source, width, height, candidate.mime, quality);
                if (!blob || blob.size === 0) {
                    break;
                }

                // Some engines silently fall back to PNG: that is not a
                // compression, so move on to the next candidate format.
                if (blob.type && blob.type !== candidate.mime) {
                    best = null;
                    break;
                }

                if (!bestAnyQuality || blob.size < bestAnyQuality.blob.size) {
                    bestAnyQuality = { blob, quality };
                }

                if (blob.size <= targetBytes) {
                    best = { blob, quality };
                    low = quality;
                } else {
                    high = quality;
                }
            }

            if (best) {
                log('Compressed image to', formatBytes(best.blob.size), 'in', candidate.extension);
                return {
                    blob: best.blob,
                    extension: candidate.extension,
                    compressed: true,
                    bytes: best.blob.size,
                    width,
                    height,
                    targetKb: Math.round(targetBytes / 1024),
                    format: candidate.extension,
                };
            }

            // Nothing reached the target. Remember the smallest result anyway:
            // an unsupported source format still becomes a format the server
            // accepts, which is better than failing the upload.
            if (bestAnyQuality && (!fallbackResult || bestAnyQuality.blob.size < fallbackResult.bytes)) {
                fallbackResult = {
                    blob: bestAnyQuality.blob,
                    extension: candidate.extension,
                    compressed: false,
                    bytes: bestAnyQuality.blob.size,
                    width,
                    height,
                    targetKb: Math.round(targetBytes / 1024),
                    format: candidate.extension,
                };
            }

            // Reachable only when the long edge limit is switched on.
            if (!settings.compress_limit_dimension) {
                break;
            }
        }
    }

    if (fallbackResult) {
        log('Could not reach the requested size; using the smallest result', formatBytes(fallbackResult.bytes));
        return fallbackResult;
    }

    log('Could not re-encode the image, uploading the original');
    return null;
}

/**
 * `POST /api/images/upload` only accepts the upstream `MEDIA_EXTENSIONS`
 * image formats. AVIF / SVG (and anything unusual a clipboard may hand us)
 * are re-encoded to PNG through a canvas so the upload still succeeds and the
 * stored file stays a plain raster image.
 *
 * When automatic compression is enabled and the source is larger than the
 * configured target, a smaller WebP (or JPEG) is produced instead.
 *
 * @param {File|Blob} file
 * @returns {Promise<{blob: Blob, extension: string, compression: any}>}
 */
async function prepareImageForUpload(file) {
    const mime = String(file.type || 'image/png');
    const extension = extensionForMime(mime);

    const compressed = await compressImageIfNeeded(file, getSettings());
    if (compressed) {
        return { blob: compressed.blob, extension: compressed.extension, compression: compressed };
    }

    if (IMAGE_UPLOAD_FORMATS.indexOf(extension) !== -1) {
        return { blob: file, extension: extension, compression: null };
    }

    try {
        const image = await decodeToImage(file);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const pngBlob = await encodeToBlob(image, width, height, 'image/png');

        if (pngBlob && pngBlob.size > 0) {
            log('Re-encoded', mime, 'to PNG for upload');
            return { blob: pngBlob, extension: 'png', compression: null };
        }
    } catch (error) {
        log('Could not re-encode image, uploading the original bytes instead', error);
    }

    // Unsupported format that cannot be re-encoded: the caller falls back to
    // the generic file endpoint, which stores the raw bytes under user/files.
    return { blob: file, extension: extension, compression: null };
}

/**
 * Returns the character name used to namespace the uploaded file, mirroring
 * how upstream `populateFileAttachment` scopes uploads per entity.
 * @param {any} ctx
 * @param {any} message
 * @returns {string}
 */
function resolveUploadName(ctx, message) {
    if (message && message.is_user && ctx && ctx.name1) {
        return String(ctx.name1);
    }
    if (message && message.force_avatar && message.name) {
        return String(message.name);
    }
    if (ctx && ctx.name2) {
        return String(ctx.name2);
    }
    return 'unknown';
}

/**
 * Collects image files out of a clipboard payload.
 * Android WebView puts pasted images in `files`, but some platforms only
 * expose them through `items`, so both are checked.
 * @param {ClipboardEvent} event
 * @returns {File[]}
 */
export function extractImageFiles(event) {
    return collectClipboardFiles(event, { imagesOnly: true });
}

/**
 * Collects every file out of a clipboard payload, images included. The unsent
 * input box path needs this to keep non-image pastes untouched.
 * @param {ClipboardEvent} event
 * @returns {File[]}
 */
export function extractClipboardFiles(event) {
    return collectClipboardFiles(event, { imagesOnly: false });
}

/**
 * Shared clipboard reader for paste based extraction.
 * @param {ClipboardEvent} event
 * @param {{imagesOnly: boolean}} options
 * @returns {File[]}
 */
function collectClipboardFiles(event, options) {
    const clipboard = event ? event.clipboardData : null;
    if (!clipboard) {
        return [];
    }

    const files = [];
    const seen = new Set();

    const push = (file) => {
        if (!file || seen.has(file)) {
            return;
        }
        const mime = String(file.type || '');
        const isImage = mime.startsWith('image/') || IMAGE_MIME_FALLBACK_RE.test(mime);
        if (options.imagesOnly && !isImage) {
            return;
        }
        seen.add(file);
        files.push(file);
    };

    // Engines that expose a pasted image only as an inline data URL inside the
    // text/html flavour. Only self-contained `data:` URLs are accepted, never
    // remote ones, so a paste can never trigger an unexpected network request.
    const pushDataUrls = (html) => {
        const matches = String(html || '').match(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi);
        if (!matches) {
            return;
        }
        for (const dataUrl of matches) {
            const mimeMatch = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,/i.exec(dataUrl);
            const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/png';
            const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s/g, ''));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            push(new File([bytes], 'pasted.' + extensionForMime(mime), { type: mime }));
        }
    };

    if (clipboard.files && clipboard.files.length > 0) {
        for (let i = 0; i < clipboard.files.length; i++) {
            push(clipboard.files[i]);
        }
    }

    if (clipboard.items && clipboard.items.length > 0) {
        for (let i = 0; i < clipboard.items.length; i++) {
            const item = clipboard.items[i];
            if (!item || item.kind !== 'file') {
                continue;
            }
            if (options.imagesOnly && item.type && !String(item.type).startsWith('image/')) {
                continue;
            }
            const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
            push(file);
        }
    }

    if (files.length === 0 && typeof clipboard.getData === 'function') {
        try {
            pushDataUrls(clipboard.getData('text/html'));
        } catch (error) {
            log('Could not read text/html clipboard flavour', error);
        }
    }

    return files;
}

/* ------------------------------------------------------------------ */
/* upload + message mutation                                           */
/* ------------------------------------------------------------------ */

/**
 * Uploads an image bytes payload.
 *
 * Primary path is the endpoint the built-in attachment flow uses
 * (`saveBase64AsFile` -> `POST /api/images/upload`), which stores the file
 * under `user/images/<ch_name>/`. `POST /api/files/upload` is only used when
 * the image endpoint cannot take the payload — either because the server does
 * not implement it, or because the format is outside `MEDIA_EXTENSIONS`
 * (`svg`, `avif`) and could not be re-encoded. The two endpoints delete
 * through *different* routes, so the returned path tells the caller which
 * delete endpoint to use.
 *
 * @param {{image: string, format: string, ch_name: string, filename: string, name: string, data: string}} payload
 * @returns {Promise<string>} served path of the stored file
 */
export async function uploadImage(payload) {
    const ctx = safeContext();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
        throw new Error('SillyTavern context is not ready');
    }

    const imageFormatSupported = IMAGE_UPLOAD_FORMATS.indexOf(String(payload.format)) !== -1;

    const attempts = [];

    if (imageFormatSupported) {
        attempts.push({
            url: '/api/images/upload',
            body: {
                image: payload.image,
                format: payload.format,
                ch_name: payload.ch_name,
                // Upstream strips dots from the requested name on purpose.
                filename: String(payload.filename).replace(/\./g, '_'),
            },
        });
    }

    attempts.push({
        url: '/api/files/upload',
        body: {
            name: payload.name,
            data: payload.data,
        },
    });

    let lastError = null;

    for (const attempt of attempts) {
        try {
            const response = await fetch(attempt.url, {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify(attempt.body),
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                lastError = new Error(
                    attempt.url + ' -> ' + response.status + (text ? ': ' + text : ''),
                );
                log('Upload attempt failed', lastError.message);
                continue;
            }

            const result = await response.json();
            const path = result && result.path ? String(result.path) : '';
            if (!path) {
                lastError = new Error(attempt.url + ' did not return a path');
                continue;
            }

            return path;
        } catch (error) {
            lastError = error;
            log('Upload attempt threw', attempt.url, error);
        }
    }

    throw lastError || new Error('Upload failed');
}

/**
 * Makes sure `message.extra.media` exists, preferring the host helper.
 * @param {any} ctx
 * @param {any} message
 * @returns {any[]} the media array
 */
export function ensureMediaArray(ctx, message) {
    if (ctx && typeof ctx.ensureMessageMediaIsArray === 'function') {
        try {
            ctx.ensureMessageMediaIsArray(message);
        } catch (error) {
            log('ensureMessageMediaIsArray failed, falling back', error);
        }
    }

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    if (!Array.isArray(message.extra.media)) {
        message.extra.media = [];
    }

    return message.extra.media;
}

/**
 * Appends an already uploaded image to the message as inline media.
 * The shape matches upstream `populateFileAttachment`, so the chat file
 * stays readable by desktop SillyTavern.
 * @param {any} ctx
 * @param {number} messageId
 * @param {{url: string, title: string}} uploaded
 * @returns {{index: number, media: any}}
 */
export function attachMediaToMessage(ctx, messageId, uploaded) {
    if (!ctx || !Array.isArray(ctx.chat)) {
        throw new Error('Chat is not available');
    }

    const message = ctx.chat[messageId];
    if (!message) {
        throw new Error('Message ' + messageId + ' not found');
    }

    const media = ensureMediaArray(ctx, message);
    const entry = {
        url: uploaded.url,
        type: 'image',
        title: uploaded.title || 'pasted image',
        source: 'upload',
    };

    media.push(entry);
    message.extra.media_index = media.length - 1;
    message.extra.inline_image = true;

    return { index: media.length - 1, media: entry };
}

/**
 * Re-renders the media of a message through the host renderer.
 * @param {any} ctx
 * @param {number} messageId
 * @returns {boolean} whether the host renderer ran
 */
export function renderMessageMedia(ctx, messageId) {
    if (!ctx || typeof ctx.appendMediaToMessage !== 'function' || typeof $ === 'undefined') {
        return false;
    }

    try {
        const message = ctx.chat ? ctx.chat[messageId] : null;
        const host = document.querySelector('.mes[mesid="' + messageId + '"]');
        if (!message || !host) {
            return false;
        }
        ctx.appendMediaToMessage(message, $(host), 'keep');
        return true;
    } catch (error) {
        log('appendMediaToMessage failed', error);
        return false;
    }
}

/**
 * Deletes an uploaded file from the server, picking the endpoint that matches
 * where the file actually lives. Upstream rejects cross-directory deletes
 * (`/api/images/delete` only accepts `user/images/*`, `/api/files/delete` only
 * `user/files/*`), so the path decides the route. Best effort: a failure only
 * means a stale file is left behind, never a broken message.
 * @param {string} url served path of the file
 * @returns {Promise<boolean>}
 */
export async function deleteUploadedFile(url) {
    const ctx = safeContext();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
        return false;
    }

    const isImage = String(url || '').indexOf('/user/images/') === 0;
    const endpoint = isImage ? '/api/images/delete' : '/api/files/delete';

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ path: url }),
        });
        return response.ok;
    } catch (error) {
        log('Failed to delete uploaded file', error);
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* editor UI                                                           */
/* ------------------------------------------------------------------ */

/** messageId -> .mes element for the currently open editor. */
const OPEN_EDITOR_MESSAGE_ID = new Map();
/** .mes element -> messageId. */
const MESSAGE_IDS = new WeakMap();
/** messageId -> busy flag, so double pastes do not upload twice over. */
const BUSY_MESSAGES = new Set();
/** Elements already wired for unsent box compression (bound once each). */
const hookedInputs = new WeakSet();
const hookedTextareas = new WeakSet();
const hookedForms = new WeakSet();
/** Guards the unsent box hook against its own `change` event. */
let sendBoxCompressionRunning = false;

/**
 * Resolves the message id that owns a given `.mes` element.
 * @param {Element} mesElement
 * @returns {number|null}
 */
function resolveMessageId(mesElement) {
    if (!mesElement) {
        return null;
    }
    if (MESSAGE_IDS.has(mesElement)) {
        return MESSAGE_IDS.get(mesElement);
    }

    // Newer ST builds put mesid on `.mes`, older ones on `.mes_block`.
    const candidates = [mesElement, mesElement.querySelector('.mes_block')];
    for (const candidate of candidates) {
        if (!candidate || !candidate.getAttribute) {
            continue;
        }
        const raw = candidate.getAttribute('mesid');
        const parsed = Number(raw);
        if (raw !== null && Number.isInteger(parsed) && parsed >= 0) {
            MESSAGE_IDS.set(mesElement, parsed);
            return parsed;
        }
    }

    return null;
}

/**
 * Returns the `.mes` element that currently hosts an open edit textarea.
 * @returns {{mes: HTMLElement, textarea: HTMLTextAreaElement, messageId: number}|null}
 */
export function getOpenEditor() {
    const active = document.activeElement;
    const fromFocus = active && active.classList && active.classList.contains('edit_textarea')
        ? active
        : null;
    const textarea = /** @type {HTMLTextAreaElement} */ (
        fromFocus || document.querySelector('.mes .edit_textarea')
    );

    if (!textarea) {
        return null;
    }

    const mes = textarea.closest('.mes');
    if (!mes) {
        return null;
    }

    const messageId = resolveMessageId(mes);
    if (messageId === null) {
        return null;
    }

    return { mes, textarea, messageId };
}

/**
 * Shared entry point for paste and drop: uploads the given files into the
 * message that currently has an editor open.
 * @param {File[]} files
 * @returns {Promise<number>} number of successfully attached images
 */
async function attachFilesToOpenEditor(files) {
    const editor = getOpenEditor();
    if (!editor) {
        return 0;
    }

    log('Attaching', files.length, 'image(s) to message', editor.messageId);
    return handleFiles(editor.messageId, files);
}

/* ------------------------------------------------------------------ */
/* the actual feature                                                  */
/* ------------------------------------------------------------------ */

/**
 * Uploads one image and attaches it to the message being edited.
 * @param {number} messageId
 * @param {File|Blob} file
 * @returns {Promise<boolean>}
 */
export async function attachImageToMessage(messageId, file) {
    const settings = getSettings();
    if (!settings.enabled) {
        return false;
    }

    if (!file || typeof file.size !== 'number') {
        return false;
    }

    if (file.size > settings.max_image_bytes) {
        const limitMb = Math.round(settings.max_image_bytes / (1024 * 1024));
        notify('warning', 'Image is larger than ${0} MB and was not attached.', limitMb);
        return false;
    }

    const ctx = safeContext();
    if (!ctx || !Array.isArray(ctx.chat)) {
        notify('error', 'SillyTavern is not ready yet, please try again in a moment.');
        return false;
    }

    const message = ctx.chat[messageId];
    if (!message) {
        notify('error', 'The message to edit was not found.');
        return false;
    }

    const unique = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const chName = resolveUploadName(ctx, message);

    try {
        const prepared = await prepareImageForUpload(file);
        const dataUrl = await blobToDataUrl(prepared.blob);
        const comma = dataUrl.indexOf(',');
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

        const uploadedUrl = await uploadImage({
            image: base64,
            format: prepared.extension,
            ch_name: chName,
            filename: unique,
            name: unique + '.' + prepared.extension,
            data: base64,
        });

        attachMediaToMessage(ctx, messageId, {
            url: uploadedUrl,
            title: chName + ' pasted image',
        });

        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        }

        renderMessageMedia(ctx, messageId);

        if (prepared.compression) {
            notify('success', 'Image compressed to ${0}.', formatBytes(prepared.compression.bytes));
        }

        log('Attached image to message', messageId, uploadedUrl);
        return true;
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Upload failed', error);
        notify('error', 'Image upload failed: ${0}', error && error.message ? error.message : error);
        return false;
    }
}

/**
 * Handles a batch of files pasted or dropped into the editor.
 * @param {number} messageId
 * @param {File[]} files
 * @returns {Promise<number>} number of successfully attached images
 */
async function handleFiles(messageId, files) {
    if (BUSY_MESSAGES.has(messageId)) {
        notify('info', 'The previous image is still uploading…');
        return 0;
    }

    const images = files.filter((file) => file && String(file.type || '').startsWith('image/'));
    if (images.length === 0) {
        return 0;
    }

    BUSY_MESSAGES.add(messageId);
    let attached = 0;

    try {
        for (const image of images) {
            // eslint-disable-next-line no-await-in-loop -- uploads are sequential on purpose
            const ok = await attachImageToMessage(messageId, image);
            if (ok) {
                attached++;
            }
        }
    } finally {
        BUSY_MESSAGES.delete(messageId);
    }

    return attached;
}

/* ------------------------------------------------------------------ */
/* event wiring                                                        */
/* ------------------------------------------------------------------ */

let syncTimer = null;

/**
 * Removes the drag highlight from every textarea that may still carry it.
 */
function clearDragHighlights() {
    document.querySelectorAll('.edit_textarea.tt-editpaste-drag').forEach((node) => {
        node.classList.remove('tt-editpaste-drag');
    });
}

/**
 * Keeps track of which message currently has an editor open.
 *
 * The extension no longer injects any UI into the editor: pasted and dropped
 * images are attached directly, with no toolbar, picker button or thumbnail
 * preview (the message itself shows the image).
 */
function syncEditors() {
    const editor = getOpenEditor();

    if (!editor) {
        OPEN_EDITOR_MESSAGE_ID.clear();
        clearDragHighlights();
    } else {
        OPEN_EDITOR_MESSAGE_ID.clear();
        OPEN_EDITOR_MESSAGE_ID.set(editor.messageId, editor.mes);
    }

    // Runs whether or not an editor is open: images appear in finished messages,
    // and the lightbox can be open over any of them.
    enhanceImageViewers();
}

/**
 * Paste listener for the message edit textarea. Registered once, on
 * `document` in the capture phase (see `startSync`).
 * @param {ClipboardEvent} event
 * @returns {Promise<void>}
 */
async function onPaste(event) {
    const files = extractImageFiles(event);
    if (files.length === 0) {
        // Plain text paste: let the host handle it untouched.
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const editor = getOpenEditor();
    if (!editor) {
        return;
    }

    log('Paste detected in message editor', editor.messageId, files.length, 'image(s)');
    await attachFilesToOpenEditor(files);
}

/**
 * Collects every file out of a drag-and-drop payload, images included.
 * @param {DragEvent} event
 * @returns {File[]}
 */
function extractAllDroppedFiles(event) {
    const transfer = event ? event.dataTransfer : null;
    if (!transfer) {
        return [];
    }

    const files = [];
    if (transfer.files && transfer.files.length > 0) {
        for (let i = 0; i < transfer.files.length; i++) {
            files.push(transfer.files[i]);
        }
    }

    if (files.length === 0 && transfer.items && transfer.items.length > 0) {
        for (let i = 0; i < transfer.items.length; i++) {
            const item = transfer.items[i];
            if (!item || item.kind !== 'file') {
                continue;
            }
            const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
            if (file) {
                files.push(file);
            }
        }
    }

    return files;
}

/**
 * Compresses every oversized image in a file list.
 * @param {File[]} files
 * @param {any} settings
 * @returns {Promise<{files: File[], compressedCount: number, lastBytes: number}>}
 */
async function compressFiles(files, settings) {
    const targetBytes = Math.max(10, Number(settings.compress_target_kb) || 0) * 1024;
    const result = [];
    let compressedCount = 0;
    let lastBytes = 0;

    for (const file of files) {
        if (!file || !String(file.type || '').startsWith('image/') || Number(file.size) <= targetBytes) {
            result.push(file);
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential on purpose
        const compressed = await compressImageIfNeeded(file, settings);
        if (!compressed || !compressed.compressed) {
            // Nothing gained (or nothing reachable): keep the original bytes.
            result.push(file);
            continue;
        }

        compressedCount++;
        lastBytes = compressed.bytes;

        const baseName = String(file.name || 'image').replace(/\.[^.]+$/, '');
        const mime = EXT_TO_MIME[compressed.extension] || 'image/webp';
        result.push(new File(
            [compressed.blob],
            baseName + '.' + compressed.extension,
            { type: mime, lastModified: Date.now() },
        ));
    }

    return { files: result, compressedCount, lastBytes };
}

/**
 * Reports a finished compression through the host toast.
 * @param {number} compressedCount
 * @param {number} lastBytes
 */
function reportCompression(compressedCount, lastBytes) {
    if (compressedCount === 1) {
        notify('success', 'Image compressed to ${0}.', formatBytes(lastBytes));
    } else if (compressedCount > 1) {
        notify(
            'success',
            'Compressed ${0} images; the last one is ${1}.',
            compressedCount,
            formatBytes(lastBytes),
        );
    }
}

/**
 * Files that the unsent input box is currently holding, if they can be read.
 * @returns {File[]|null}
 */
function readSendBoxFiles() {
    const input = document.getElementById('file_form_input');
    if (!input || !input.files || typeof input.files.length !== 'number') {
        return null;
    }
    return Array.from(input.files);
}

/**
 * Cached promise for the host's helper module (`null` when unavailable).
 * @type {Promise<any|null>|null}
 */
let hostUtilsPromise = null;

/**
 * Loads SillyTavern's `/scripts/utils.js` for `humanFileSize`, so the label we
 * redraw matches the host's own formatting byte for byte.
 * @returns {Promise<any|null>}
 */
function loadHostUtilsModule() {
    if (!hostUtilsPromise) {
        hostUtilsPromise = import('../../../utils.js')
            .then((module) => (module && typeof module.humanFileSize === 'function' ? module : null))
            .catch((error) => {
                log('host utils module unavailable, using the built-in size format', error);
                return null;
            });
    }

    return hostUtilsPromise;
}

/**
 * Stand-in for `humanFileSize(bytes, si = false, dp = 1)`, mirroring the host's
 * binary units so a host without the module still renders the same text.
 * @param {number} bytes
 * @returns {string}
 */
function fallbackFileSize(bytes) {
    const value = Number(bytes) || 0;
    const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    if (Math.abs(value) < 1024) {
        return value + ' B';
    }

    let size = value;
    let unit = -1;
    do {
        size /= 1024;
        unit++;
    } while (Math.round(Math.abs(size) * 10) / 10 >= 1024 && unit < units.length - 1);

    return size.toFixed(1) + ' ' + units[unit];
}

/**
 * Formats a byte count the way the host's attachment label does.
 * @param {number} bytes
 * @returns {Promise<string>}
 */
async function formatFileSize(bytes) {
    const module = await loadHostUtilsModule();
    if (module && typeof module.humanFileSize === 'function') {
        try {
            return String(module.humanFileSize(bytes));
        } catch (error) {
            log('humanFileSize failed, using the built-in format', error);
        }
    }

    return fallbackFileSize(bytes);
}

/**
 * Redraws the host's pending-attachment label after the bytes were swapped.
 *
 * Upstream renders `#file_form .file_name` / `.file_size` only from
 * `onFileAttach()` (`public/scripts/chats.js`), which is module-local and is
 * reached two different ways: the paste and drag-drop paths call it directly,
 * while the paperclip button relies on a `change` listener that only exists after
 * that button was clicked. So there is no event we can fire that reliably
 * redraws the label — and firing `change` is actively harmful: the button's
 * listener merges whatever is in `#file_form_input` into a `DataTransfer` it
 * snapshotted on click, and `isSameFile()` compares name/size/type/lastModified,
 * so a re-encoded file counts as *new* and the original would be re-added
 * alongside it. The label is therefore written here, in the host's own format.
 *
 * @param {File[]|FileList} files
 * @returns {Promise<void>}
 */
async function refreshAttachmentLabel(files) {
    const form = document.getElementById('file_form');
    if (!form) {
        return;
    }

    const nameNode = form.querySelector('.file_name');
    const sizeNode = form.querySelector('.file_size');
    if (!nameNode || !sizeNode) {
        return;
    }

    const list = Array.from(files || []);
    if (list.length === 0) {
        form.classList.add('displayNone');
        return;
    }

    const name = list.length === 1
        ? String(list[0].name || '')
        : fillPlaceholders(translateText('${0} files selected'), list.length);
    const totalBytes = list.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const title = list.map((file) => String(file.name || '')).join('\n');

    nameNode.textContent = name;
    nameNode.setAttribute('title', title);
    sizeNode.textContent = await formatFileSize(totalBytes);
    sizeNode.setAttribute('title', String(totalBytes));
    form.classList.remove('displayNone');
}

/**
 * Optional hook for the unsent input box (`#send_textarea`).
 *
 * The host owns that path: it attaches pasted or dropped files to
 * `#file_form_input` and only turns them into base64 when the message is sent.
 * A paste payload cannot be rewritten in flight, so the compression happens
 * right after the host attached the files, and the result is written straight
 * back into the same input. The host's own multi-file merging stays in charge;
 * only the bytes change, plus the label that would otherwise keep describing the
 * pre-compression file.
 *
 * @returns {Promise<void>}
 */
async function compressSendBoxAttachments() {
    const settings = getSettings();
    if (!settings.compress_enabled) {
        return;
    }

    if (sendBoxCompressionRunning) {
        return;
    }

    const files = readSendBoxFiles();
    if (!files || files.length === 0) {
        return;
    }

    const targetBytes = Math.max(10, Number(settings.compress_target_kb) || 0) * 1024;
    const oversized = files.some((file) => file
        && String(file.type || '').startsWith('image/')
        && Number(file.size) > targetBytes);

    if (!oversized) {
        return;
    }

    sendBoxCompressionRunning = true;

    try {
        const { files: nextFiles, compressedCount, lastBytes } = await compressFiles(files, settings);
        if (compressedCount > 0 && typeof DataTransfer === 'function') {
            const transfer = new DataTransfer();
            for (const file of nextFiles) {
                transfer.items.add(file);
            }
            const input = document.getElementById('file_form_input');
            if (input) {
                // Deliberately no `change` event: see `refreshAttachmentLabel`.
                input.files = transfer.files;
                await refreshAttachmentLabel(transfer.files);
            }
            reportCompression(compressedCount, lastBytes);
            log('Compressed', compressedCount, 'image(s) for the unsent input box');
        }
    } catch (error) {
        log('Unsent box compression failed', error);
    } finally {
        sendBoxCompressionRunning = false;
    }
}

/**
 * Hooks the unsent box on the way in, so the added files can be compressed
 * before the host shows or uploads them. Bound once per element.
 * @param {HTMLInputElement} input the host's hidden file input
 * @param {HTMLElement} textarea `#send_textarea`
 */
function installSendBoxHooks(input, textarea) {
    if (!hookedInputs.has(input)) {
        hookedInputs.add(input);
        input.addEventListener('change', () => {
            window.setTimeout(() => {
                compressSendBoxAttachments().catch((error) => log('send box hook failed', error));
            }, 0);
        });
    }

    if (textarea && !hookedTextareas.has(textarea)) {
        hookedTextareas.add(textarea);
        textarea.addEventListener('paste', () => {
            window.setTimeout(() => {
                compressSendBoxAttachments().catch((error) => log('send box paste hook failed', error));
            }, 0);
        });

        const form = textarea.closest('#form_sheld') || document.getElementById('form_sheld');
        if (form && !hookedForms.has(form)) {
            hookedForms.add(form);
            form.addEventListener('drop', () => {
                window.setTimeout(() => {
                    compressSendBoxAttachments().catch((error) => log('send box drop hook failed', error));
                }, 0);
            });
        }
    }
}

/**
 * Look up and hook the unsent box elements when they exist.
 */
function syncSendBoxHooks() {
    const input = document.getElementById('file_form_input');
    if (!input) {
        return;
    }

    const textarea = document.getElementById('send_textarea');
    installSendBoxHooks(input, textarea);
}

/**
 * Extracts image files out of a drag-and-drop payload.
 * @param {DragEvent} event
 * @returns {File[]}
 */
export function extractDroppedImages(event) {
    return extractAllDroppedFiles(event)
        .filter((file) => file && String(file.type || '').startsWith('image/'));
}

/**
 * Marks the hovered edit textarea while an image is dragged over it.
 * @param {DragEvent} event
 */
function onDragOver(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('edit_textarea')) {
        return;
    }

    // Required for the browser to fire `drop` at all.
    event.preventDefault();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
    }
    target.classList.add('tt-editpaste-drag');
}

/**
 * Clears the hover highlight when the drag leaves the textarea.
 * @param {DragEvent} event
 */
function onDragLeave(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('edit_textarea')) {
        return;
    }
    target.classList.remove('tt-editpaste-drag');
}

/**
 * Handles an image dropped onto the edit textarea.
 *
 * `preventDefault()` on `dragover` (see `onDragOver`) is what makes the drop
 * possible at all. `stopPropagation()` here keeps the host from treating the
 * same drop as a file to attach to the *next* message, which would attach the
 * image twice in two different places.
 *
 * @param {DragEvent} event
 * @returns {Promise<void>}
 */
async function onDrop(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('edit_textarea')) {
        return;
    }

    const images = extractDroppedImages(event);
    if (images.length === 0) {
        // Not an image (or a text/plain drag): let the host deal with it.
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearDragHighlights();

    log('Drop detected on message editor', images.length, 'image(s)');
    await attachFilesToOpenEditor(images);
}

/**
 * Registers the paste / drag-and-drop listeners and the editor reconciler.
 *
 * The listeners live on `document` in the **capture** phase, which is the
 * single entry point for every gesture: capture runs before anything bound on
 * a textarea itself, so the edit box path can reliably suppress the host
 * default. The unsent input box is handled by the host, and this extension
 * hooks it separately (see `installSendBoxHooks`).
 */
function startSync() {
    if (syncTimer === null) {
        syncTimer = window.setInterval(() => {
            try {
                syncEditors();
                syncSendBoxHooks();
            } catch (error) {
                console.error(DEBUG_PREFIX, 'syncEditors failed', error);
            }
        }, SYNC_INTERVAL_MS);
    }

    const isTarget = (event, className) => Boolean(event && event.target
        && event.target.classList && event.target.classList.contains(className));

    const guard = (handler) => (event) => {
        try {
            handler(event);
        } catch (error) {
            console.error(DEBUG_PREFIX, 'gesture handler failed', error);
        }
    };

    document.addEventListener('paste', guard((event) => {
        if (!isTarget(event, 'edit_textarea')) {
            return;
        }
        onPaste(event).catch((error) => console.error(DEBUG_PREFIX, 'paste handler failed', error));
    }), true);

    document.addEventListener('dragover', guard((event) => {
        if (isTarget(event, 'edit_textarea')) {
            onDragOver(event);
        }
    }), true);

    document.addEventListener('dragleave', guard((event) => {
        if (isTarget(event, 'edit_textarea')) {
            onDragLeave(event);
        }
    }), true);

    document.addEventListener('drop', guard((event) => {
        if (!isTarget(event, 'edit_textarea')) {
            return;
        }
        onDrop(event).catch((error) => console.error(DEBUG_PREFIX, 'drop handler failed', error));
    }), true);
}

/* ------------------------------------------------------------------ */
/* image download (host download bridge)                               */
/* ------------------------------------------------------------------ */

/**
 * Turns an image URL into a safe file name.
 * @param {string} url
 * @returns {string}
 */
export function fileNameFromImageUrl(url) {
    let candidate = '';
    try {
        const parsed = new URL(String(url), 'https://localhost/');
        candidate = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    } catch (error) {
        candidate = String(url || '').split('/').pop() || '';
    }

    const cleaned = candidate
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/[.\s]+$/g, '')
        .trim();

    if (!cleaned) {
        return 'image.png';
    }
    if (!/\.[a-z0-9]{2,5}$/i.test(cleaned)) {
        return cleaned + '.png';
    }
    return cleaned;
}

/**
 * Reads `window.location.href`, tolerating a host without one.
 * @returns {string}
 */
function currentLocationHref() {
    try {
        return String((window.location && window.location.href) || '');
    } catch (error) {
        return '';
    }
}

/**
 * Reads `window.location.origin`, tolerating a host without one.
 * @returns {string}
 */
function currentLocationOrigin() {
    try {
        return String((window.location && window.location.origin) || '');
    } catch (error) {
        return '';
    }
}

/**
 * Keeps the download href on the host's own origin.
 *
 * The host's download bridge refuses anchors that point anywhere else and then
 * does nothing at all, so a URL that only differs by host alias (localhost vs
 * 127.0.0.1) is rewritten to its path. Genuinely remote URLs are handed over
 * untouched, because for those the browser is the only thing that can help.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeDownloadHref(url) {
    const raw = String(url || '').trim();
    if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) {
        return raw;
    }

    const base = currentLocationHref();
    if (!base) {
        return raw;
    }

    let parsed = null;
    try {
        parsed = new URL(raw, base);
    } catch (error) {
        return raw;
    }

    if (parsed.origin === currentLocationOrigin()) {
        return raw;
    }

    for (const prefix of LOCAL_MEDIA_PATH_PREFIXES) {
        if (parsed.pathname.startsWith(prefix)) {
            return parsed.pathname + parsed.search;
        }
    }

    return parsed.href;
}

/**
 * Fetches the image bytes so the host can save them straight from memory.
 *
 * On TauriTavern mobile the host keeps a map of every `URL.createObjectURL`
 * result, and a `blob:` anchor skips both its own second fetch and its same
 * origin check. When the bytes cannot be read the caller falls back to the URL.
 *
 * @param {string} href
 * @returns {Promise<Blob|null>}
 */
async function readImageBlob(href) {
    if (typeof fetch !== 'function') {
        return null;
    }

    try {
        const response = await fetch(href);
        if (response && response.ok && typeof response.blob === 'function') {
            return await response.blob();
        }
        log('Image payload request was refused', response ? response.status : 'no response');
    } catch (error) {
        log('Image payload request failed', error);
    }

    return null;
}

/**
 * Frees a temporary download URL once the host has had time to pick it up.
 * @param {string} objectUrl
 */
function releaseObjectUrl(objectUrl) {    if (!objectUrl) {
        return;
    }

    window.setTimeout(() => {
        try {
            URL.revokeObjectURL(objectUrl);
        } catch (error) {
            log('Failed to release the download URL', error);
        }
    }, DOWNLOAD_BLOB_TTL_MS);
}

/**
 * Reports whether an href already points at the host itself.
 *
 * Relative hrefs count, because the browser resolves them against the page.
 * @param {string} href
 * @returns {boolean}
 */
function isSameOriginHref(href) {
    const origin = currentLocationOrigin();
    if (!origin) {
        return true;
    }

    try {
        return new URL(href, currentLocationHref() || origin).origin === origin;
    } catch (error) {
        return true;
    }
}

/**
 * Creates the download anchor, clicks it and reports what happened.
 *
 * The host bridges downloads from a capture phase listener on `document`, which
 * calls `preventDefault()`. Reading that flag from our own listener is the only
 * way to tell "the host is saving this" apart from "nothing will happen".
 *
 * @param {string} href the image URL, for reporting
 * @param {string} anchorHref where the anchor should point
 * @param {string} fileName
 * @param {'direct'|'blob'} mode
 * @param {string} [objectUrl] temporary URL to release once the host looked at it
 * @returns {{ok: boolean, bridged: boolean, url: string, name: string, mode: string}}
 */
function clickDownloadAnchor(href, anchorHref, fileName, mode, objectUrl) {
    const anchor = document.createElement('a');
    anchor.href = anchorHref;
    anchor.setAttribute('download', fileName);
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    // Must be connected so the host's document level listener sees the click.
    document.body.appendChild(anchor);

    let dispatched = false;
    let prevented = false;
    const onAnchorClick = (event) => {
        dispatched = true;
        prevented = Boolean(event.defaultPrevented);
    };

    anchor.addEventListener('click', onAnchorClick);
    let bridged = false;
    try {
        anchor.click();
        // A host that swallows the click inside its own `click` patch never dispatches.
        bridged = dispatched ? prevented : true;
    } finally {
        anchor.removeEventListener('click', onAnchorClick);
        anchor.remove();
    }

    releaseObjectUrl(objectUrl);
    return { ok: true, bridged, url: href, name: fileName, mode };
}

/**
 * Cached promise for TauriTavern's export module (`null` when this host has none).
 *
 * The promise itself is cached, not a "already tried" flag: two downloads started
 * in the same tick must not race, with the loser silently dropping to the anchor
 * route.
 *
 * @type {Promise<any|null>|null}
 */
let hostExportPromise = null;

/**
 * Loads TauriTavern's own export pipeline on demand.
 *
 * A plain SillyTavern has no `/scripts/file-export.js`, and a static import
 * would take the whole extension down with it, so this stays a guarded dynamic
 * import. It is the very module the host's built-in Exports use, which is what
 * makes the native Android (MediaStore) and iOS (share sheet) paths work without
 * depending on the anchor bridge.
 *
 * @returns {Promise<any|null>}
 */
function loadHostExportModule() {
    if (!hostExportPromise) {
        hostExportPromise = import('../../../file-export.js')
            .then((module) => {
                if (module && typeof module.downloadBlobWithRuntime === 'function') {
                    log('using the host export pipeline for downloads');
                    return module;
                }
                log('host file-export module exposes no downloadBlobWithRuntime');
                return null;
            })
            .catch((error) => {
                log('host file-export module unavailable, downloads fall back to an anchor', error);
                return null;
            });
    }

    return hostExportPromise;
}

/**
 * Downloads an image through the host's download bridge.
 *
 * Two routes, tried in this order:
 *
 * 1. TauriTavern's own export module (`/scripts/file-export.js`), the exact code
 *    its built-in "Export" buttons use. It stages the bytes and calls the native
 *    Android (MediaStore) / iOS (share sheet) bridge, so there is no anchor to be
 *    intercepted and no origin rule to satisfy. Plain SillyTavern has no such
 *    file, hence the guarded dynamic import.
 * 2. Everywhere else: a synthetic `<a download>` click, which the browser saves
 *    and which TauriTavern's `download-bridge.js` also intercepts on mobile.
 *
 * @param {string} url image URL (already served by the host)
 * @param {string} [name] optional file name
 * @returns {Promise<{ok: boolean, bridged: boolean, url: string, name: string, mode: string}>}
 */
export async function downloadImageUrl(url, name) {
    const source = String(url || '').trim();
    const href = normalizeDownloadHref(source);
    if (!href) {
        return { ok: false, bridged: false, url: href, name: '', mode: 'none' };
    }

    const fileName = fileNameFromImageUrl(name || source || href);
    const host = await loadHostExportModule();
    if (host) {
        return downloadImageViaHost(host, href, fileName);
    }

    return downloadImageViaAnchor(href, fileName);
}

/**
 * Fallback route: click a synthetic anchor and let the browser — or the host's
 * anchor bridge — save it.
 *
 * Exported so it stays directly testable: on a TauriTavern host the route above
 * always wins, and this one only runs on hosts without the export module.
 *
 * @param {string} url image URL
 * @param {string} [name] optional file name
 * @returns {Promise<{ok: boolean, bridged: boolean, url: string, name: string, mode: string}>}
 */
export async function downloadImageViaAnchor(url, name) {
    const source = String(url || '').trim();
    const href = normalizeDownloadHref(source);
    if (!href) {
        return { ok: false, bridged: false, url: href, name: '', mode: 'none' };
    }

    const fileName = fileNameFromImageUrl(name || source || href);

    // A local URL is what the host bridge expects, and the click has to stay
    // inside the user gesture, so this path never waits for anything.
    if (isSameOriginHref(href)) {
        log('Downloading image', fileName, 'from', href, '(direct)');
        return clickDownloadAnchor(href, href, fileName, 'direct');
    }

    // Foreign URLs are refused by the host bridge, so fetch the bytes here and
    // hand it a blob it can read straight out of memory.
    let objectUrl = '';
    const blob = await readImageBlob(href);
    if (blob) {
        try {
            objectUrl = URL.createObjectURL(blob);
        } catch (error) {
            log('Failed to create a download URL', error);
            objectUrl = '';
        }
    }

    const mode = objectUrl ? 'blob' : 'direct';
    log('Downloading image', fileName, 'from', href, '(' + mode + ')');
    return clickDownloadAnchor(href, objectUrl || href, fileName, mode, objectUrl);
}

/**
 * Hands the image to TauriTavern's own export pipeline.
 * @param {any} host the `/scripts/file-export.js` module
 * @param {string} href
 * @param {string} fileName
 * @returns {Promise<{ok: boolean, bridged: boolean, url: string, name: string, mode: string}>}
 */
async function downloadImageViaHost(host, href, fileName) {
    const blob = await readImageBlob(href);
    if (!blob) {
        throw new Error('the image payload could not be read');
    }

    const result = await host.downloadBlobWithRuntime(blob, fileName, { fallbackName: fileName });
    log('Host export finished', describeExportResult(result, fileName));
    notify('success', 'Image saved: ${0}', describeExportResult(result, fileName));
    return { ok: true, bridged: true, url: href, name: fileName, mode: 'host' };
}

/**
 * Describes where the host put the file, for the confirmation toast.
 * @param {any} result
 * @param {string} fileName
 * @returns {string}
 */
function describeExportResult(result, fileName) {
    if (!result || typeof result !== 'object') {
        return fileName;
    }

    const savedPath = typeof result.savedPath === 'string' ? result.savedPath.trim() : '';
    if (savedPath) {
        return savedPath;
    }

    const displayName = typeof result.displayName === 'string' ? result.displayName.trim() : '';
    return displayName || fileName;
}

/**
 * Reports whether the app is a mobile Tauri shell, where a download that no host
 * bridge picked up would otherwise fail without any feedback at all.
 * @returns {boolean}
 */
function isNativeMobileShell() {
    try {
        if (!window.__TAURI_INTERNALS__ && !window.__TAURI__ && !window.__TAURI_RUNNING__) {
            return false;
        }
        const userAgent = String((window.navigator && window.navigator.userAgent) || '');
        return /android|iphone|ipad|ipod/i.test(userAgent);
    } catch (error) {
        return false;
    }
}

/**
 * Opens the image itself, as a last resort when no download route worked.
 *
 * On TauriTavern this hands the URL to the system browser, where the image can
 * be saved with the platform's own long press.
 *
 * @param {string} src
 * @returns {boolean} true when something was opened
 */
function openImageLocation(src) {
    const target = String(src || '').trim();
    if (!target) {
        return false;
    }

    let absolute = target;
    try {
        absolute = new URL(target, currentLocationHref() || undefined).href;
    } catch (error) {
        absolute = target;
    }

    try {
        const tauri = window.__TAURI__;
        if (tauri && tauri.opener && typeof tauri.opener.openUrl === 'function') {
            tauri.opener.openUrl(absolute).catch((error) => {
                console.error(DEBUG_PREFIX, 'opener failed', error);
            });
            return true;
        }
    } catch (error) {
        console.error(DEBUG_PREFIX, 'opener unavailable', error);
    }

    try {
        window.open(absolute, '_blank', 'noopener');
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Picks the best URL to save for a media element.
 *
 * Three sources, best first: a gallery's `data-ngsrc` (the original, when `src`
 * holds a thumbnail), a wrapping link that points at a media file, and finally
 * the element's own `src`.
 *
 * Text-to-image results do not need any special handling here: they are ordinary
 * `message.extra.media` entries with `source: 'generated'` and are rendered by
 * the very same `#message_image_template` clone, so the same markup applies.
 * Video results use `<video class="mes_video">` instead, which is why the
 * selector below is not `img`-only.
 *
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {string}
 */
function mediaSourceForDownload(media) {
    for (const attribute of MEDIA_SOURCE_ATTRS) {
        const value = String(media.getAttribute(attribute) || '').trim();
        if (value) {
            return value;
        }
    }

    const link = typeof media.closest === 'function' ? media.closest('a[href]') : null;
    const href = link ? String(link.getAttribute('href') || '').trim() : '';
    if (href && MEDIA_FILE_RE.test(href)) {
        return href;
    }

    return String(
        media.getAttribute('src') || media.currentSrc || media.src || '',
    ).trim();
}

/**
 * Runs a download and reports the outcome, whichever surface started it.
 * @param {Element|null} feedback control to animate, when there is one
 * @param {string} src
 * @returns {Promise<void>}
 */
async function runDownloadAction(feedback, src) {
    const source = String(src || '').trim();
    if (!source) {
        return;
    }
    if (feedback && feedback.getAttribute(DOWNLOAD_DONE_ATTR) === 'busy') {
        return;
    }

    if (feedback) {
        feedback.setAttribute(DOWNLOAD_DONE_ATTR, 'busy');
        markDownloadControl(feedback, 'busy');
    }

    try {
        const result = await downloadImageUrl(source);
        if (feedback) {
            markDownloadControl(feedback, 'done');
        }
        if (!result.ok) {
            notify('error', 'Failed to download the image.');
        } else if (!result.bridged && isNativeMobileShell()) {
            console.error(DEBUG_PREFIX, 'the app did not take over the download', result);
            notify('warning', 'The app did not take over the download. Update TauriTavern and try again.');
        }
    } catch (error) {
        console.error(DEBUG_PREFIX, 'download failed', error);
        const reason = error && error.message ? error.message : String(error);
        if (openImageLocation(source)) {
            notify('warning', 'Download failed: ${0} The image was opened instead.', reason);
        } else {
            notify('error', 'Failed to download the image: ${0}', reason);
        }
    } finally {
        if (feedback) {
            window.setTimeout(() => {
                feedback.removeAttribute(DOWNLOAD_DONE_ATTR);
            }, 1500);
        }
    }
}

/**
 * Pins a viewer control to the media's own corner.
 *
 * The viewer box is usually larger than the picture (letterboxing, `object-fit:
 * contain`), so anchoring to the box would leave the control floating away from
 * the media. Offsets are measured against the media instead, and clamped to the
 * viewer so that a zoomed-in picture never pushes the control out of sight.
 *
 * @param {Element} container
 * @param {Element} control
 * @param {'left'|'right'} side
 */
function positionViewerControl(container, control, side) {
    const media = container.querySelector(MEDIA_ELEMENT_SELECTOR);
    if (!media
        || typeof media.getBoundingClientRect !== 'function'
        || typeof container.getBoundingClientRect !== 'function') {
        return;
    }

    const mediaRect = media.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!mediaRect.width || !mediaRect.height || !containerRect.width || !containerRect.height) {
        return;
    }

    const gapBottom = Math.round(containerRect.bottom - mediaRect.bottom);
    control.style.bottom = Math.max(VIEWER_INSET_PX, gapBottom + VIEWER_INSET_PX) + 'px';

    if (side === 'left') {
        const gapLeft = Math.round(mediaRect.left - containerRect.left);
        control.style.left = Math.max(VIEWER_INSET_PX, gapLeft + VIEWER_INSET_PX) + 'px';
        return;
    }

    const gapRight = Math.round(containerRect.right - mediaRect.right);
    control.style.right = Math.max(VIEWER_INSET_PX, gapRight + VIEWER_INSET_PX) + 'px';
}

/**
 * Repositions every control that is actually in this viewer.
 * @param {Element} container
 */
function repositionViewer(container) {
    for (const entry of VIEWER_CONTROLS) {
        const control = container.querySelector('.' + entry.className);
        if (control) {
            positionViewerControl(container, control, entry.side);
        }
    }
}

/**
 * Builds the corner control that sits inside a viewer.
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {Element}
 */
function makeViewerDownloadButton(media) {
    const button = document.createElement('div');
    button.className = 'fa-solid fa-download ' + VIEWER_DOWNLOAD_CLASS;
    button.setAttribute('title', translateText('Download image'));
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.addEventListener('click', (event) => {
        // The lightbox closes on any click inside it, so this must not bubble.
        event.preventDefault();
        event.stopPropagation();
        runDownloadAction(button, mediaSourceForDownload(media)).catch((error) => {
            console.error(DEBUG_PREFIX, 'viewer download failed', error);
        });
    });

    return button;
}

/**
 * Builds the gallery-only "go to the message this came from" control.
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {Element}
 */
function makeViewerJumpButton(media) {
    const button = document.createElement('div');
    button.className = 'fa-solid fa-location-arrow ' + VIEWER_JUMP_CLASS;
    button.setAttribute('title', translateText('Jump to the message with this image'));
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        runJumpToMessage(mediaSourceForDownload(media)).catch((error) => {
            console.error(DEBUG_PREFIX, 'jump to message failed', error);
        });
    });

    return button;
}

/**
 * Adds one corner control to a viewer, or just repositions it when it is there.
 * @param {Element} container
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @param {string} className
 * @param {'left'|'right'} side
 * @param {(media: any) => Element} build
 */
function ensureViewerControl(container, media, className, side, build) {
    const existing = container.querySelector('.' + className);
    if (existing) {
        positionViewerControl(container, existing, side);
        return;
    }

    const control = build(media);
    container.appendChild(control);
    positionViewerControl(container, control, side);
    media.addEventListener('load', () => positionViewerControl(container, control, side));
}

/**
 * Adds (and keeps positioned) the corner controls in every media viewer.
 *
 * Neither SillyTavern's chat lightbox (`expandMessageMedia`) nor the gallery's
 * floating window ships any, and both are ordinary nodes in this document, so a
 * corner control is all it takes. Running on every reconciler tick doubles as the
 * repositioning pass: it catches late media layout, the click that toggles zoom,
 * and window resizes without needing a ResizeObserver.
 */
function enhanceImageViewers() {
    for (const surface of VIEWER_SURFACES) {
        for (const container of document.querySelectorAll(surface.selector)) {
            const media = container.querySelector(MEDIA_ELEMENT_SELECTOR);
            if (!media || !mediaSourceForDownload(media)) {
                continue;
            }

            container.classList.add(VIEWER_HOST_CLASS);

            if (surface.download) {
                ensureViewerControl(container, media, VIEWER_DOWNLOAD_CLASS, 'right', makeViewerDownloadButton);
            }
            if (surface.jump) {
                ensureViewerControl(container, media, VIEWER_JUMP_CLASS, 'left', makeViewerJumpButton);
            }
        }
    }
}

/**
 * Repositions every viewer control after something a tick might miss.
 * @param {Element} container
 */
function repositionViewerSoon(container) {
    window.setTimeout(() => repositionViewer(container), 0);
}

/**
 * Keeps the corner control in step with a lightbox that is opening right now.
 *
 * The lightbox is created by a click we cannot hook into directly, so this runs
 * a few short retries on top of the regular reconciler tick.
 * @param {number} [attempt]
 */
function refreshViewersSoon(attempt = 0) {
    enhanceImageViewers();
    if (attempt >= 4) {
        return;
    }
    window.setTimeout(() => refreshViewersSoon(attempt + 1), 120);
}

/**
 * Normalises a media URL so a gallery path and a message URL compare equal.
 *
 * The gallery serves `user/images/<folder>/<file>` while the message stores
 * `/user/images/<name>/<file>`, and either may carry a query or percent escapes.
 *
 * @param {string} url
 * @returns {string}
 */
function mediaPathKey(url) {
    let value = String(url || '').trim();
    if (!value) {
        return '';
    }

    try {
        value = new URL(value, currentLocationHref() || 'https://localhost/').pathname;
    } catch (error) {
        value = value.split('?')[0].split('#')[0];
    }

    try {
        value = decodeURIComponent(value);
    } catch (error) {
        // Leave malformed percent escapes alone rather than dropping the value.
    }

    return value.replace(/^\/+/, '');
}

/**
 * Finds the message that shows this media, so the chat can jump to it.
 *
 * An exact path match wins. When nothing matches, the bare file name is accepted
 * if it is unique across the chat, so a gallery that serves the same file under a
 * slightly different path still lands somewhere sensible.
 *
 * @param {string} url
 * @returns {number|null} message id, or null when the chat does not show it
 */
function findMessageIdForMedia(url) {
    const key = mediaPathKey(url);
    if (!key) {
        return null;
    }

    const ctx = safeContext();
    const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
    if (!chat) {
        return null;
    }

    const base = key.split('/').pop();
    let byBaseName = null;
    let byBaseNameCount = 0;

    for (let id = 0; id < chat.length; id++) {
        const message = chat[id];
        const media = message && message.extra && Array.isArray(message.extra.media)
            ? message.extra.media
            : [];

        for (const entry of media) {
            const entryKey = mediaPathKey(entry && entry.url);
            if (!entryKey) {
                continue;
            }
            if (entryKey === key) {
                return id;
            }
            if (entryKey.split('/').pop() === base) {
                byBaseName = id;
                byBaseNameCount++;
            }
        }
    }

    return byBaseNameCount === 1 ? byBaseName : null;
}

/**
 * Scrolls the chat to a message and rings it for a moment.
 * @param {number} messageId
 * @returns {boolean} true when the message was found in the DOM
 */
function revealMessage(messageId) {
    const selector = '.mes[mesid="' + messageId + '"]';
    const node = document.querySelector('#chat ' + selector) || document.querySelector(selector);
    if (!node) {
        return false;
    }

    if (typeof node.scrollIntoView === 'function') {
        try {
            node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (error) {
            log('smooth scroll refused, jumping directly', error);
            node.scrollIntoView();
        }
    }

    node.classList.add(FLASH_CLASS);
    window.setTimeout(() => node.classList.remove(FLASH_CLASS), FLASH_HOLD_MS);
    return true;
}

/**
 * Asks before leaving the gallery for the chat.
 *
 * The jump throws away whatever the reader was scrolled to, so it is worth one
 * confirmation. When the host has no dialog module the jump goes ahead: the tap
 * was deliberate.
 *
 * @returns {Promise<boolean>}
 */
async function confirmJumpToMessage() {
    const module = await loadHostPopupModule();
    const confirm = module && module.Popup && module.Popup.show
        ? module.Popup.show.confirm
        : null;
    if (typeof confirm !== 'function') {
        log('no confirmation dialog available, jumping right away');
        return true;
    }

    try {
        const answer = await confirm(
            translateText('Jump to the image'),
            translateText('About to jump to the message this image came from.'),
            {
                okButton: translateText('Jump'),
                cancelButton: translateText('Cancel'),
            },
        );
        return Boolean(answer);
    } catch (error) {
        log('jump confirmation failed, jumping right away', error);
        return true;
    }
}

/**
 * Gallery-only: leaves the viewer for the chat message the image came from.
 *
 * @param {string} src the media URL shown in the gallery viewer
 * @returns {Promise<void>}
 */
async function runJumpToMessage(src) {
    const messageId = findMessageIdForMedia(src);
    if (messageId === null) {
        notify('warning', 'This image is not attached to any message in the current chat.');
        return;
    }

    const confirmed = await confirmJumpToMessage();
    if (!confirmed) {
        log('jump to message declined');
        return;
    }

    if (!revealMessage(messageId)) {
        notify('warning', 'This image is not attached to any message in the current chat.');
        return;
    }

    log('Jumped to message', messageId, 'for', src);
}

/**
 * Reacts to the two clicks that open the chat image lightbox, and to the click
 * that toggles zoom inside it (which resizes the image under our control).
 */
function installViewerHooks() {
    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') {
            return;
        }

        const opener = target.closest(LIGHTBOX_OPENER_SELECTOR);
        if (opener) {
            refreshViewersSoon();
            return;
        }

        for (const selector of VIEWER_CONTAINER_SELECTORS) {
            const viewer = target.closest(selector);
            if (viewer) {
                repositionViewerSoon(viewer);
                return;
            }
        }
    }, true);

    window.addEventListener('resize', () => {
        for (const selector of VIEWER_CONTAINER_SELECTORS) {
            for (const container of document.querySelectorAll(selector)) {
                repositionViewer(container);
            }
        }
    }, { passive: true });
}

/**
 * Reports whether this device has a touch pointer, so the long press is only
 * armed where it makes sense (a mouse long press would fight text selection).
 * @returns {boolean}
 */
function hasCoarsePointer() {
    try {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(pointer: coarse)').matches;
    } catch (error) {
        return false;
    }
}

/**
 * Swallows the click that follows a long press, so the lightbox does not open
 * on top of the confirmation dialog.
 */
function swallowNextClick() {
    const blocker = (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.removeEventListener('click', blocker, true);
    };

    document.addEventListener('click', blocker, true);
    window.setTimeout(() => {
        document.removeEventListener('click', blocker, true);
    }, 800);
}

/**
 * Cached promise for SillyTavern's popup module (`null` when unavailable).
 * @type {Promise<any|null>|null}
 */
let hostPopupPromise = null;

/**
 * Loads the host's dialog module on demand, for the same reason the export
 * module is loaded that way: a plain or older host may not have it, and a static
 * import would take the whole extension down.
 * @returns {Promise<any|null>}
 */
function loadHostPopupModule() {
    if (!hostPopupPromise) {
        hostPopupPromise = import('../../../popup.js')
            .then((module) => (module && module.Popup ? module : null))
            .catch((error) => {
                log('host popup module unavailable', error);
                return null;
            });
    }

    return hostPopupPromise;
}

/**
 * Gives a short buzz so the hold is acknowledged before the dialog appears.
 */
function pulseFeedback() {
    if (typeof navigator.vibrate !== 'function') {
        return;
    }

    try {
        navigator.vibrate(30);
    } catch (error) {
        // Vibration is a nicety; ignore refusals.
    }
}

/**
 * Asks before saving, so a long press cannot fire by accident.
 *
 * When the host has no dialog module the download goes ahead anyway: the hold
 * was deliberate, and silently doing nothing is the worse outcome.
 *
 * @returns {Promise<boolean>}
 */
async function confirmDownload() {
    const module = await loadHostPopupModule();
    const confirm = module && module.Popup && module.Popup.show
        ? module.Popup.show.confirm
        : null;
    if (typeof confirm !== 'function') {
        log('no confirmation dialog available, downloading right away');
        return true;
    }

    try {
        const answer = await confirm(
            translateText('Download image'),
            translateText('Save this image to your device?'),
            {
                okButton: translateText('Download'),
                cancelButton: translateText('Cancel'),
            },
        );
        return Boolean(answer);
    } catch (error) {
        log('confirmation dialog failed, downloading right away', error);
        return true;
    }
}

/**
 * Reports the pixel size of a media element, for the "too small to be content"
 * check. Images and videos expose it under different names.
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {{width: number, height: number}}
 */
function mediaPixelSize(media) {
    const width = Number(media.naturalWidth) || Number(media.videoWidth) || 0;
    const height = Number(media.naturalHeight) || Number(media.videoHeight) || 0;
    return { width, height };
}

/**
 * Arms "hold an image to download it" for the whole document.
 *
 * Delegated from `document` because media comes and goes with every re-render,
 * including inside the lightbox and the gallery. The listeners are always
 * installed; the touch-device check and the setting are evaluated per gesture so
 * both stay effective without re-registering anything.
 */
function installLongPressDownload() {
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let candidate = null;

    const cancel = () => {
        if (timer) {
            window.clearTimeout(timer);
            timer = 0;
        }
        candidate = null;
    };

    const mediaFromTarget = (target) => {
        if (!target || typeof target.closest !== 'function') {
            return null;
        }
        if (target.closest('.mes_img_controls, .mes_img_swipes, .tt-editpaste-viewer-download')) {
            return null;
        }

        const tag = String(target.tagName || '').toUpperCase();
        const media = tag === 'IMG' || tag === 'VIDEO' ? target : target.closest(MEDIA_ELEMENT_SELECTOR);
        if (!media) {
            return null;
        }

        const size = mediaPixelSize(media);
        if (size.width && size.width < LONG_PRESS_MIN_EDGE) {
            return null;
        }
        if (size.height && size.height < LONG_PRESS_MIN_EDGE) {
            return null;
        }

        return media;
    };

    document.addEventListener('touchstart', (event) => {
        cancel();
        if (!getSettings().long_press_download || !hasCoarsePointer()) {
            return;
        }

        const touch = event.touches && event.touches[0];
        if (!touch) {
            return;
        }

        candidate = mediaFromTarget(event.target);
        if (!candidate) {
            return;
        }

        startX = touch.clientX;
        startY = touch.clientY;
        const media = candidate;
        timer = window.setTimeout(() => {
            timer = 0;
            pulseFeedback();
            swallowNextClick();
            confirmDownload().then((confirmed) => {
                if (!confirmed) {
                    log('long press download declined');
                    return null;
                }
                return runDownloadAction(null, mediaSourceForDownload(media));
            }).catch((error) => {
                console.error(DEBUG_PREFIX, 'long press download failed', error);
            });
        }, LONG_PRESS_MS);
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
        const touch = event.touches && event.touches[0];
        if (!touch) {
            cancel();
            return;
        }
        if (Math.abs(touch.clientX - startX) > LONG_PRESS_SLOP_PX
            || Math.abs(touch.clientY - startY) > LONG_PRESS_SLOP_PX) {
            cancel();
        }
    }, { passive: true });

    document.addEventListener('touchend', () => {
        cancel();
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
        cancel();
    }, { passive: true });
}

/**
 * Swaps the control icon: busy while the hand off runs, a short tick on success,
 * and the idle download arrow the rest of the time.
 * @param {Element} control
 * @param {'busy'|'done'|'idle'} state
 */
function markDownloadControl(control, state) {
    const icon = control.querySelector('i') || control;
    icon.classList.remove(DOWNLOAD_ICON_IDLE, DOWNLOAD_ICON_DONE, ...DOWNLOAD_ICON_BUSY);

    if (state === 'busy') {
        icon.classList.add(...DOWNLOAD_ICON_BUSY);
        return;
    }

    if (state === 'done') {
        icon.classList.add(DOWNLOAD_ICON_DONE);
        window.setTimeout(() => {
            icon.classList.remove(DOWNLOAD_ICON_DONE);
            icon.classList.add(DOWNLOAD_ICON_IDLE);
        }, 1200);
        return;
    }

    icon.classList.add(DOWNLOAD_ICON_IDLE);
}

/* ------------------------------------------------------------------ */
/* extension entry point                                              */
/* ------------------------------------------------------------------ */

let initialized = false;

/**
 * Renders this extension's block in the host's Extensions settings drawer.
 * Optional: silently skipped when the container is missing.
 */
function renderSettingsPanel() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('tt_editpaste_settings')) {
        return;
    }

    const settings = getSettings();
    const block = document.createElement('div');
    block.id = 'tt_editpaste_settings';
    block.className = 'tt-editpaste-settings';
    block.innerHTML =
        '<div class="inline-drawer">' +
        '  <div class="inline-drawer-toggle inline-drawer-header">' +
        '    <b>PCD Extension</b>' +
        '    <small class="tt-editpaste-version">v' + EXTENSION_VERSION + '</small>' +
        '    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
        '  </div>' +
        '  <div class="inline-drawer-content">' +
        '    <small data-i18n="Paster: paste or drop an image into the message editor. Compresser: automatically shrink oversized images before upload. Downloader: save an image from the image viewer or with a long press.">' +
        '    贴图（Paster）：在编辑框粘贴／拖入图片。压缩（Compresser）：上传前自动缩小超标的图片。' +
        '    下载（Downloader）：在图片检视器里存档，或长按图片下载。</small>' +
        '    <label class="checkbox_label" for="tt_editpaste_enabled">' +
        '      <input id="tt_editpaste_enabled" type="checkbox">' +
        '      <span data-i18n="Enable paste and drop in the message editor">启用编辑框粘贴／拖放</span>' +
        '    </label>' +
        '    <label for="tt_editpaste_maxsize" data-i18n="Maximum size per image (MB)">单张图片大小上限（MB）</label>' +
        '    <input id="tt_editpaste_maxsize" class="text_pole" type="number" min="1" max="100" step="1">' +
        '    <hr>' +
        '    <label class="checkbox_label" for="tt_editpaste_compress">' +
        '      <input id="tt_editpaste_compress" type="checkbox">' +
        '      <span data-i18n="Compress images automatically">自动压缩图片</span>' +
        '    </label>' +
        '    <label for="tt_editpaste_target_kb" data-i18n="Target size after compression (KB)">压缩后文件大小上限（KB）</label>' +
        '    <input id="tt_editpaste_target_kb" class="text_pole" type="number" min="10" max="20000" step="10">' +
        '    <label class="checkbox_label" for="tt_editpaste_limit_edge">' +
        '      <input id="tt_editpaste_limit_edge" type="checkbox">' +
        '      <span data-i18n="Also limit the long edge">同时限制长边尺寸</span>' +
        '    </label>' +
        '    <label for="tt_editpaste_max_edge" data-i18n="Maximum long edge after compression (px)">压缩后长边最大尺寸（px）</label>' +
        '    <input id="tt_editpaste_max_edge" class="text_pole" type="number" min="100" max="20000" step="100">' +
        '    <label for="tt_editpaste_min_quality" data-i18n="Minimum quality (lower bound)">最低可接受画质</label>' +
        '    <input id="tt_editpaste_min_quality" class="text_pole" type="number" min="0.1" max="1" step="0.05">' +
        '    <small data-i18n="Images that are already within the size limit are left untouched. Compression re-encodes to WebP, falls back to JPEG when WebP is unsupported, and removes metadata such as EXIF. Quality is lowered first; the image is only scaled down when the lowest acceptable quality is still too large.">' +
        '    图片不超过大小上限时不做任何处理。压缩会重新编码为 WebP（不支持时退回 JPEG），并清除 EXIF 等元数据。' +
        '    优先降低画质，只有画质降到底仍然超标时才会缩小尺寸。</small>' +
        '    <small data-i18n="Paste an image into the message editor with Ctrl+V, or drag an image into the editor. The unsent input box behaves the same way.">' +
        '    在编辑框（铅笔图标）内按 Ctrl+V 粘贴，或把图片拖进编辑框；未送出的输入框同样有效。' +
        '    图片会存到 <code>user/images/&lt;角色名&gt;/</code>，与内置附件相同。</small>' +
        '    <hr>' +
        '    <label class="checkbox_label" for="tt_editpaste_long_press">' +
        '      <input id="tt_editpaste_long_press" type="checkbox">' +
        '      <span data-i18n="Hold an image on a touch screen to download it">触控装置上长按图片下载</span>' +
        '    </label>' +
        '    <small data-i18n="Holding an image asks for confirmation first, so it cannot fire by accident. Only applies on touch screens.">' +
        '    长按图片会先弹出确认再下载，避免误触。只对触控屏幕有效。</small>' +
        '  </div>' +
        '</div>';

    container.appendChild(block);

    const enabledInput = block.querySelector('#tt_editpaste_enabled');
    const maxSizeInput = block.querySelector('#tt_editpaste_maxsize');
    const compressInput = block.querySelector('#tt_editpaste_compress');
    const targetKbInput = block.querySelector('#tt_editpaste_target_kb');
    const limitEdgeInput = block.querySelector('#tt_editpaste_limit_edge');
    const maxEdgeInput = block.querySelector('#tt_editpaste_max_edge');
    const minQualityInput = block.querySelector('#tt_editpaste_min_quality');
    const longPressInput = block.querySelector('#tt_editpaste_long_press');

    enabledInput.checked = settings.enabled;
    maxSizeInput.value = String(Math.round(settings.max_image_bytes / (1024 * 1024)));
    compressInput.checked = settings.compress_enabled;
    targetKbInput.value = String(settings.compress_target_kb);
    limitEdgeInput.checked = settings.compress_limit_dimension;
    maxEdgeInput.value = String(settings.compress_max_edge);
    minQualityInput.value = String(settings.compress_min_quality);
    longPressInput.checked = settings.long_press_download;

    const syncCompressionInputs = () => {
        const off = !settings.compress_enabled;
        targetKbInput.disabled = off;
        limitEdgeInput.disabled = off;
        maxEdgeInput.disabled = off || !settings.compress_limit_dimension;
        minQualityInput.disabled = off;
    };
    syncCompressionInputs();

    const persist = () => {
        const ctx = safeContext();
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    };

    enabledInput.addEventListener('change', () => {
        settings.enabled = enabledInput.checked;
        persist();
    });
    maxSizeInput.addEventListener('change', () => {
        settings.max_image_bytes = readClampedNumber(maxSizeInput, 1, 100, 25) * 1024 * 1024;
        maxSizeInput.value = String(Math.round(settings.max_image_bytes / (1024 * 1024)));
        persist();
    });
    compressInput.addEventListener('change', () => {
        settings.compress_enabled = compressInput.checked;
        syncCompressionInputs();
        persist();
    });
    targetKbInput.addEventListener('change', () => {
        settings.compress_target_kb = Math.round(readClampedNumber(targetKbInput, 10, 20000, 500));
        targetKbInput.value = String(settings.compress_target_kb);
        persist();
    });
    limitEdgeInput.addEventListener('change', () => {
        settings.compress_limit_dimension = limitEdgeInput.checked;
        syncCompressionInputs();
        persist();
    });
    maxEdgeInput.addEventListener('change', () => {
        settings.compress_max_edge = Math.round(readClampedNumber(maxEdgeInput, 100, 20000, 2000));
        maxEdgeInput.value = String(settings.compress_max_edge);
        persist();
    });
    minQualityInput.addEventListener('change', () => {
        settings.compress_min_quality = readClampedNumber(minQualityInput, 0.1, 1, 0.5);
        minQualityInput.value = String(settings.compress_min_quality);
        persist();
    });
    longPressInput.addEventListener('change', () => {
        settings.long_press_download = longPressInput.checked;
        persist();
    });
}

/**
 * Extension entry point.
 *
 * TauriTavern / SillyTavern only inject the extension bundle as a module
 * script; they do not call an exported `init()` for arbitrary third-party
 * extensions, so the module self-initializes on DOM-ready. `init()` stays
 * exported (and idempotent) for hosts that do call it.
 * @returns {Promise<boolean>} true when this call performed the setup
 */
export async function init() {
    if (initialized) {
        return false;
    }
    initialized = true;

    const ctx = safeContext();
    getSettings();

    // 1) the interval reconciler + the capture-phase safety net
    startSync();

    // 1b) download surfaces: the lightbox corner control and "hold to download"
    installViewerHooks();
    installLongPressDownload();

    // 2) fresh chat -> no editor is open anymore
    if (ctx && ctx.eventSource && ctx.eventTypes) {
        const refresh = () => {
            OPEN_EDITOR_MESSAGE_ID.clear();
            BUSY_MESSAGES.clear();
            window.setTimeout(clearDragHighlights, 0);
        };

        const rerenderMedia = (messageId) => {
            // The host re-renders the message body on save; media images live in
            // a sibling wrapper, so make sure they are (re)drawn.
            window.setTimeout(() => {
                try {
                    renderMessageMedia(safeContext(), Number(messageId));
                } catch (error) {
                    log('media re-render after save failed', error);
                }
            }, 60);
        };

        if (ctx.eventTypes.CHAT_CHANGED) {
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, refresh);
        }
        if (ctx.eventTypes.MESSAGE_DELETED) {
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, refresh);
        }
        if (ctx.eventTypes.MESSAGE_UPDATED) {
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_UPDATED, rerenderMedia);
        }
    }

    // 3) optional settings block in the Extensions drawer
    renderSettingsPanel();

    // 4) expose minimal hooks for power users / debugging in the console.
    globalThis.__pcd = {
        version: EXTENSION_VERSION,
        attachImageToMessage,
        uploadImage,
        getSettings,
        downloadImageUrl,
        downloadImageViaAnchor,
        openImageLocation,
    };

    log('initialized v' + EXTENSION_VERSION
        + ' — paste or drop an image into the message editor (pencil button)');
    return true;
}

// Self-start: the extension bundle is injected as a module script, so run
// once the DOM is ready. Guarded by `initialized` against double setup.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init().catch((error) => console.error(DEBUG_PREFIX, 'init failed', error));
        }, { once: true });
    } else {
        init().catch((error) => console.error(DEBUG_PREFIX, 'init failed', error));
    }
}

export default {
    init,
};
