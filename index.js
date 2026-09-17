/**
 * Edit Message Paste Image
 * ------------------------------------------------------------------
 * Lets you paste an image straight into the *message edit* box
 * (the pencil / `.mes_edit` button), exactly like pasting into the
 * unsent-message box (`#send_textarea`) already works.
 *
 * Upstream background:
 *  - Unsent box: `public/scripts/chats.js` binds a `paste` listener on
 *    `#send_textarea` and feeds `event.clipboardData.files` into the
 *    `#file_form_input` attachment flow.
 *  - Edit box: `messageEdit()` in `public/script.js` renders
 *    `<textarea id="curEditTextarea" class="edit_textarea">` and there is
 *    **no** paste listener at all.
 *
 * This extension adds that missing listener. A pasted image is uploaded
 * through the standard `/api/images/upload` endpoint (the same one
 * `saveBase64AsFile()` uses for the built-in attachment button) and attached
 * to the message being edited as `message.extra.media[]` with
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

/** Module id used for settings + logging prefixes. */
export const MODULE_NAME = 'edit-paste-image';
export const DEBUG_PREFIX = '[EditPasteImage] ';

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

/** Injected download control, mirroring upstream's media controls. */
const DOWNLOAD_BUTTON_CLASS = 'tt-editpaste-download';
const DOWNLOAD_DONE_ATTR = 'data-tt-editpaste-download';
const DOWNLOAD_ICON_IDLE = 'fa-download';
const DOWNLOAD_ICON_BUSY = ['fa-spinner', 'fa-spin'];
const DOWNLOAD_ICON_DONE = 'fa-check';

/** How long a temporary download URL stays alive so the host can pick it up. */
const DOWNLOAD_BLOB_TTL_MS = 30000;

/** Paths that always belong to the local SillyTavern server. */
const LOCAL_MEDIA_PATH_PREFIXES = ['/user/', '/thumbnails/', '/characters/', '/backgrounds/', '/api/'];

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
};

/**
 * Reads this extension's settings block, creating defaults on first run.
 * @returns {any}
 */
export function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS);
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
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {string} message
 */
function notify(level, message) {
    const text = translateText(message);
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
        notify('warning', fillPlaceholders('Image is larger than ${0} MB and was not attached.', limitMb));
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
            notify('success', fillPlaceholders('Image compressed to ${0}.', formatBytes(prepared.compression.bytes)));
        }

        log('Attached image to message', messageId, uploadedUrl);
        return true;
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Upload failed', error);
        notify('error', fillPlaceholders('Image upload failed: ${0}', error && error.message ? error.message : error));
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

    // Runs whether or not an editor is open: images appear in finished messages.
    enhanceImageContainers();
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
        notify('success', fillPlaceholders('Image compressed to ${0}.', formatBytes(lastBytes)));
    } else if (compressedCount > 1) {
        notify('success', fillPlaceholders(
            'Compressed ${0} images; the last one is ${1}.',
            compressedCount,
            formatBytes(lastBytes),
        ));
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
 * Optional hook for the unsent input box (`#send_textarea`).
 *
 * The host owns that path: it attaches pasted or dropped files to
 * `#file_form_input` and only turns them into base64 when the message is sent.
 * A paste payload cannot be rewritten in flight, so the compression happens
 * right after the host attached the files, and the result is written straight
 * back into the same input. The host's own attachment UI, preview and multi
 * file merging stay in charge; only the bytes change.
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
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
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
function releaseObjectUrl(objectUrl) {
    if (!objectUrl) {
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
 * Downloads an image through the host's download bridge.
 *
 * The anchor carries a `download` attribute on purpose: on TauriTavern mobile
 * the host patches `HTMLAnchorElement.click`, tracks `URL.createObjectURL`
 * results and listens for download clicks at document level, routing them
 * through its native save flow (Android writes to the public Downloads folder or
 * opens the system save dialog, iOS opens the share sheet) with its own
 * success/failure toast. Everywhere else the browser simply saves the file,
 * which is the same thing a long press offers upstream.
 *
 * A local URL is what that bridge expects, and the click has to stay inside the
 * user gesture, so that path never waits for anything. Only a URL that still
 * points somewhere else after normalisation is read into a blob first, because
 * the bridge refuses those outright.
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

    if (isSameOriginHref(href)) {
        log('Downloading image', fileName, 'from', href, '(direct)');
        return clickDownloadAnchor(href, href, fileName, 'direct');
    }

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
 * Reports whether the app is a mobile Tauri shell, where a download that no host
 * bridge picked up would otherwise fail without any feedback at all.
 * @returns {boolean}
 */
function isNativeMobileShell() {
    try {
        if (!window.__TAURI_INTERNALS__ && !window.__TAURI__) {
            return false;
        }
        const userAgent = String((window.navigator && window.navigator.userAgent) || '');
        return /android|iphone|ipad|ipod/i.test(userAgent);
    } catch (error) {
        return false;
    }
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

/**
 * Handles a click on the injected download control.
 * @param {MouseEvent} event
 * @returns {Promise<void>}
 */
async function onDownloadControlClick(event) {
    const control = event.currentTarget;
    if (!control || control.getAttribute(DOWNLOAD_DONE_ATTR) === 'busy') {
        return;
    }

    const container = control.closest('.mes_img_container') || control.parentElement;
    const image = container ? container.querySelector('img') : null;
    const src = image ? String(image.getAttribute('src') || '') : '';
    if (!src) {
        return;
    }

    control.setAttribute(DOWNLOAD_DONE_ATTR, 'busy');
    // Acknowledge the tap right away: the payload may have to be fetched first.
    markDownloadControl(control, 'busy');

    try {
        const result = await downloadImageUrl(src);
        if (result.ok && !result.bridged && isNativeMobileShell()) {
            console.error(DEBUG_PREFIX, 'the app did not take over the download', result);
            notify('warning', 'The app did not take over the download. Update TauriTavern and try again.');
            markDownloadControl(control, 'idle');
        } else {
            markDownloadControl(control, 'done');
        }
    } catch (error) {
        console.error(DEBUG_PREFIX, 'download failed', error);
        notify('error', 'Failed to download the image.');
        markDownloadControl(control, 'idle');
    } finally {
        window.setTimeout(() => {
            control.removeAttribute(DOWNLOAD_DONE_ATTR);
        }, 1500);
    }
}

/**
 * Adds the download control to every rendered image, appending it to the
 * host's own media controls so it sits next to expand / caption / delete.
 *
 * The control is inserted once per image. When upstream ever ships its own
 * download button, the lookup below finds it and this becomes a no-op.
 */
function enhanceImageContainers() {
    const images = document.querySelectorAll('.mes_img_container');
    for (const container of images) {
        const controls = container.querySelector('.mes_img_controls');
        if (!controls || controls.querySelector('.' + DOWNLOAD_BUTTON_CLASS)) {
            continue;
        }

        const control = document.createElement('div');
        control.className = 'right_menu_button fa-lg fa-solid ' + DOWNLOAD_ICON_IDLE + ' '
            + DOWNLOAD_BUTTON_CLASS;
        control.setAttribute('title', translateText('Download image'));
        control.setAttribute('role', 'button');
        control.setAttribute('tabindex', '0');
        control.addEventListener('click', (event) => {
            // Keep the host's message level click handlers out of this.
            event.preventDefault();
            event.stopPropagation();
            onDownloadControlClick(event).catch((error) => {
                console.error(DEBUG_PREFIX, 'download control failed', error);
            });
        });

        controls.appendChild(control);
    }
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
        '    <b>Edit Message Paste Image</b>' +
        '    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
        '  </div>' +
        '  <div class="inline-drawer-content">' +
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

    enabledInput.checked = settings.enabled;
    maxSizeInput.value = String(Math.round(settings.max_image_bytes / (1024 * 1024)));
    compressInput.checked = settings.compress_enabled;
    targetKbInput.value = String(settings.compress_target_kb);
    limitEdgeInput.checked = settings.compress_limit_dimension;
    maxEdgeInput.value = String(settings.compress_max_edge);
    minQualityInput.value = String(settings.compress_min_quality);

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
    globalThis.__ttEditPasteImage = {
        attachImageToMessage,
        uploadImage,
        getSettings,
    };

    log('initialized — paste or drop an image into the message editor (pencil button)');
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
