// -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
//
// Recolección de información del sistema para la ventana
// "Acerca de este equipo" de Tahoe Top Bar.
//
// Este módulo no importa nada de gnome-shell a propósito: así puede
// probarse desde una terminal con `gjs -m`. Todas las funciones son
// defensivas y devuelven cadena vacía (o un objeto vacío) si fallan.

'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const _decoder = new TextDecoder('utf-8');

/* ------------------------------------------------------------------ */
/* Utilidades de lectura                                               */
/* ------------------------------------------------------------------ */

function _readBytes(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok || contents === null || contents === undefined)
            return null;
        return contents;
    } catch (_e) {
        return null;
    }
}

function _readText(path) {
    const bytes = _readBytes(path);
    if (!bytes)
        return '';

    try {
        return _decoder.decode(bytes);
    } catch (_e) {
        return '';
    }
}

function _readDmi(name) {
    return _readText(`/sys/class/dmi/id/${name}`)
        .replace(/\0/g, '')
        .trim();
}

function _readFirstLine(path) {
    return _readText(path).split('\n')[0].trim();
}

/* ------------------------------------------------------------------ */
/* Modelo                                                              */
/* ------------------------------------------------------------------ */

// Valores que los fabricantes ponen cuando no rellenan el DMI.
const _INVALID_DMI = new RegExp(
    '^(?:none|unknown|n/a|not available|not specified|not applicable|' +
    'to be filled by o\\.e\\.m\\.?|default string|system product name|' +
    'system manufacturer|base board product name|o\\.e\\.m\\.?|' +
    '\\.+|-+|\\s*)$',
    'i');

function _formatVendor(vendor) {
    if (!vendor)
        return '';

    // "LENOVO" -> "Lenovo", "ASUSTeK COMPUTER INC." -> "Asustek Computer Inc."
    if (/^[A-Z0-9 .,&'()_-]+$/.test(vendor) && vendor.length > 3) {
        return vendor.toLowerCase().replace(/\b[a-z]/g,
            c => c.toUpperCase());
    }

    return vendor;
}

/**
 * Modelo del equipo. En portátiles suele estar en product_version
 * ("ThinkPad T14 Gen 2i"); si no, se compone con sys_vendor + product_name.
 *
 * @returns {string}
 */
export function getModel() {
    try {
        const version = _readDmi('product_version');
        if (version && !_INVALID_DMI.test(version))
            return version;

        const vendor = _readDmi('sys_vendor');
        const product = _readDmi('product_name');

        if (!product || _INVALID_DMI.test(product))
            return vendor && !_INVALID_DMI.test(vendor)
                ? _formatVendor(vendor)
                : '';

        if (!vendor || _INVALID_DMI.test(vendor))
            return product;

        // No repetir la marca si ya aparece en el nombre del producto.
        const brand = vendor.split(/\s+/)[0].toLowerCase();
        if (brand && product.toLowerCase().includes(brand))
            return product;

        return `${_formatVendor(vendor)} ${product}`;
    } catch (_e) {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* Pantalla y BIOS (subtítulo)                                         */
/* ------------------------------------------------------------------ */

const _COMMON_SCREEN_SIZES = [
    10.1, 11.6, 12, 12.5, 13, 13.3, 13.6, 14, 14.2, 15, 15.4, 15.6,
    16, 17, 17.3, 18, 19, 20, 21.5, 22, 23.8, 24, 27, 32,
];

function _formatInches(value) {
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded)
        ? `${rounded}`
        : rounded.toFixed(1);

    // En español el separador decimal es una coma.
    return text.replace('.', ',');
}

function _roundScreenSize(inches) {
    if (!Number.isFinite(inches) || inches <= 0)
        return 0;

    let best = inches;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (const size of _COMMON_SCREEN_SIZES) {
        const diff = Math.abs(size - inches);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = size;
        }
    }

    // Solo ajustamos a un tamaño comercial si estamos cerca; si no,
    // conservamos el valor real con un decimal.
    return bestDiff <= 0.6 ? best : Math.round(inches * 10) / 10;
}

function _edidRank(name) {
    if (/eDP|LVDS|DSI/i.test(name))
        return 0;
    if (/DP-/i.test(name))
        return 1;
    if (/HDMI/i.test(name))
        return 2;
    return 3;
}

function _listEdids() {
    const result = [];

    try {
        const dir = Gio.File.new_for_path('/sys/class/drm');
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.includes('-'))
                continue;

            const path = `/sys/class/drm/${name}/edid`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                result.push({name, path});
        }

        enumerator.close(null);
    } catch (_e) {
        // Sin DRM accesible: no pasa nada.
    }

    result.sort((a, b) => _edidRank(a.name) - _edidRank(b.name));
    return result;
}

/**
 * Calcula la diagonal en pulgadas a partir del EDID.
 *
 * Los bytes 21 y 22 del EDID son el tamaño máximo de imagen en cm y son
 * más fiables que el descriptor de temporización detallado (algunos
 * paneles guardan ahí valores corruptos).
 *
 * @param {Uint8Array} bytes
 * @returns {number} pulgadas, o 0 si no se puede calcular
 */
function _diagonalFromEdid(bytes) {
    if (!bytes || bytes.length < 128)
        return 0;

    const header = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
    for (let i = 0; i < header.length; i++) {
        if (bytes[i] !== header[i])
            return 0;
    }

    const cmWidth = bytes[21];
    const cmHeight = bytes[22];

    if (cmWidth > 5 && cmWidth < 200 &&
        cmHeight > 5 && cmHeight < 200) {
        return Math.hypot(cmWidth, cmHeight) / 2.54;
    }

    // Descriptor de temporización detallado en el offset 54.
    if (bytes[54] !== 0 || bytes[55] !== 0) {
        const mmWidth = bytes[66] | (bytes[67] << 8);
        const mmHeight = bytes[68] | (bytes[69] << 8);

        if (mmWidth > 50 && mmWidth < 2000 &&
            mmHeight > 50 && mmHeight < 2000) {
            return Math.hypot(mmWidth / 10, mmHeight / 10) / 2.54;
        }
    }

    return 0;
}

function _getScreenInches() {
    for (const {path} of _listEdids()) {
        const bytes = _readBytes(path);
        const inches = _diagonalFromEdid(bytes);
        if (inches > 0)
            return _roundScreenSize(inches);
    }

    return 0;
}

function _getBiosYear() {
    try {
        const date = _readDmi('bios_date');
        if (!date)
            return '';

        // Formatos vistos: 08/31/2026, 2021-06-07, 06/07/2021.
        const matches = date.match(/(?:19|20)\d{2}/g);
        if (!matches || matches.length === 0)
            return '';

        return matches[matches.length - 1];
    } catch (_e) {
        return '';
    }
}

/**
 * Subtítulo automático, p. ej. "14 pulgadas, 2021". Si no se puede
 * calcular la pantalla, devuelve solo el año; si tampoco hay año, "".
 *
 * @returns {string}
 */
export function getSubtitle() {
    try {
        const parts = [];

        const inches = _getScreenInches();
        if (inches > 0)
            parts.push(`${_formatInches(inches)} pulgadas`);

        const year = _getBiosYear();
        if (year)
            parts.push(year);

        return parts.join(', ');
    } catch (_e) {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* CPU                                                                 */
/* ------------------------------------------------------------------ */

function _cleanCpuName(raw) {
    let name = String(raw).replace(/\s+/g, ' ').trim();

    // Quitar la frecuencia: " @ 2.80GHz".
    name = name.replace(/\s*@\s*[\d.,]+\s*(?:GHz|MHz|THz)\b.*$/i, '');

    // "11th Gen Intel(R) Core(TM) ..." -> "Intel Core ..."
    name = name.replace(/\((?:R|TM|C)\)/gi, ' ');
    name = name.replace(/\b\d+(?:st|nd|rd|th)\s+Gen\.?\s+/i, '');

    // Sufijos redundantes en /proc/cpuinfo.
    name = name.replace(/\b(?:CPU|Processor)\b/gi, ' ');
    name = name.replace(/\s+with\s+(?:Radeon|Intel|AMD)\b.*$/i, '');

    name = name.replace(/\s+/g, ' ').trim();
    name = name.replace(/^[\s,;:-]+|[\s,;:-]+$/g, '');

    return name;
}

/**
 * Nombre comercial del procesador a partir de /proc/cpuinfo.
 *
 * @returns {string}
 */
export function getCpu() {
    try {
        const text = _readText('/proc/cpuinfo');
        if (!text)
            return '';

        const fields = {};
        for (const line of text.split('\n')) {
            const match = /^([^:]+):\s*(.*)$/.exec(line);
            if (match)
                fields[match[1].trim().toLowerCase()] = match[2].trim();
        }

        const raw = fields['model name'] ||
            fields['cpu model'] ||
            fields['hardware'] ||
            fields['chip model'] ||
            fields['processor'] ||
            '';

        // En x86 "processor" es el número de CPU ("0"), no un nombre.
        if (!raw || /^\d+$/.test(raw))
            return '';

        return _cleanCpuName(raw);
    } catch (_e) {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* GPU (asíncrona)                                                     */
/* ------------------------------------------------------------------ */

function _runAsync(argv, timeoutSeconds = 4) {
    return new Promise((resolve, reject) => {
        let process;

        try {
            process = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            reject(e);
            return;
        }

        const cancellable = new Gio.Cancellable();
        let timeoutId = 0;

        timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
                timeoutId = 0;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });

        process.communicate_utf8_async(null, cancellable, (proc, result) => {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }

            try {
                const [, stdout] = proc.communicate_utf8_finish(result);
                resolve(stdout ?? '');
            } catch (e) {
                reject(e);
            }
        });
    });
}

const _GPU_CLASS_RE = /(?:VGA compatible controller|3D controller|Display controller)/i;
const _GPU_MARKETING_RE = /(?:graphics|radeon|geforce|iris|uhd|arc|vega|rtx|gtx|quadro|mali|adreno|apple)/i;

function _parseGpuLine(line) {
    // "00:02.0 VGA compatible controller: Intel Corporation ..."
    const match = /^[0-9a-fA-F:.]+\s+(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/i
        .exec(line);

    let rest = (match?.[1] ?? '').trim();
    if (!rest) {
        const separator = line.indexOf(': ');
        if (separator === -1)
            return '';
        rest = line.slice(separator + 2).trim();
    }

    // Quitar "(rev 01)" y similares del final.
    rest = rest.replace(/\s*\((?:rev|prog-if)[^)]*\)\s*$/i, '').trim();
    if (!rest)
        return '';

    const raw = rest;
    const brackets = [...raw.matchAll(/\[([^\]]+)\]/g)]
        .map(m => m[1].trim())
        .filter(Boolean);

    // El nombre comercial suele ser el último corchete: "[Iris Xe Graphics]",
    // "[GeForce RTX 3050 Mobile]", "[Radeon Vega Series]".
    let name = brackets
        .slice()
        .reverse()
        .find(text => _GPU_MARKETING_RE.test(text)) ?? '';

    if (!name)
        name = raw;

    if (name === raw) {
        name = name.replace(
            /^(?:Intel Corporation|Intel|Advanced Micro Devices,?\s*Inc\.?|AMD|NVIDIA Corporation|NVIDIA)\s+/i,
            '');
    }

    name = name.replace(/\((?:R|TM|C)\)/gi, ' ');
    name = name.replace(/\s+/g, ' ').trim();

    let vendor = '';
    if (/Intel/i.test(raw))
        vendor = 'Intel';
    else if (/NVIDIA/i.test(raw))
        vendor = 'NVIDIA';
    else if (/AMD|Advanced Micro Devices|ATI/i.test(raw))
        vendor = 'AMD';

    if (vendor && !new RegExp(`^${vendor}\\b`, 'i').test(name))
        name = `${vendor} ${name}`;

    name = name.replace(/\b(\w+)\s+\1\b/gi, '$1').trim();

    return name;
}

function _gpuFromSysfs() {
    let result = '';

    try {
        const dir = Gio.File.new_for_path('/sys/class/drm');
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!/^card\d+$/.test(name))
                continue;

            const base = `/sys/class/drm/${name}/device`;
            const vendorId = parseInt(_readFirstLine(`${base}/vendor`), 16);

            if (vendorId === 0x8086) {
                result = 'Intel Graphics';
                break;
            }

            if (vendorId === 0x1002 || vendorId === 0x1022) {
                result = 'AMD Radeon Graphics';
                break;
            }

            if (vendorId === 0x10de) {
                result = 'NVIDIA Graphics';
                break;
            }
        }

        enumerator.close(null);
    } catch (_e) {
        // Ignorar.
    }

    return result;
}

/**
 * Nombre de la GPU. Usa `lspci` de forma asíncrona (nunca bloquea el
 * shell) y cae a /sys/class/drm si lspci no está disponible.
 *
 * @returns {Promise<string>}
 */
export async function getGpuAsync() {
    try {
        const output = await _runAsync(['lspci']);

        const names = output
            .split('\n')
            .filter(line => _GPU_CLASS_RE.test(line))
            .map(line => _parseGpuLine(line))
            .filter(Boolean);

        if (names.length > 0)
            return names[0];
    } catch (_e) {
        // lspci ausente, cancelado o fallido: probamos sysfs.
    }

    return _gpuFromSysfs();
}

/* ------------------------------------------------------------------ */
/* Memoria                                                             */
/* ------------------------------------------------------------------ */

const _MEMORY_SIZES = [
    2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512,
    768, 1024,
];

/**
 * Memoria total redondeada al tamaño comercial más cercano
 * (31,06 GiB -> "32 GB").
 *
 * @returns {string}
 */
export function getMemory() {
    try {
        const text = _readText('/proc/meminfo');
        const match = /^MemTotal:\s*(\d+)\s*kB/im.exec(text);
        if (!match)
            return '';

        const kib = Number.parseInt(match[1], 10);
        if (!Number.isFinite(kib) || kib <= 0)
            return '';

        const gib = kib / (1024 * 1024);

        let best = _MEMORY_SIZES[0];
        let bestDiff = Number.POSITIVE_INFINITY;

        for (const size of _MEMORY_SIZES) {
            const diff = Math.abs(size - gib);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = size;
            }
        }

        const total = gib > _MEMORY_SIZES[_MEMORY_SIZES.length - 1]
            ? Math.round(gib / 16) * 16
            : best;

        return `${total} GB`;
    } catch (_e) {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* Número de serie                                                     */
/* ------------------------------------------------------------------ */

/**
 * Número de serie derivado de /etc/machine-id (10 caracteres en
 * mayúsculas), con el mismo aspecto que un serial de Mac.
 *
 * @returns {string}
 */
export function getSerial() {
    try {
        const id = _readText('/etc/machine-id').replace(/\s+/g, '');
        if (!id)
            return '';

        return id.slice(0, 10).toUpperCase();
    } catch (_e) {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* Sistema operativo                                                   */
/* ------------------------------------------------------------------ */

function _parseOsRelease(text) {
    const data = {};

    for (const line of text.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match)
            continue;

        const key = match[1];
        let value = match[2];

        if (value.length >= 2) {
            const first = value[0];
            const last = value[value.length - 1];
            if ((first === '"' && last === '"') ||
                (first === "'" && last === "'"))
                value = value.slice(1, -1);
        }

        value = value.replace(/\\(["'\\$`])/g, '$1');
        data[key] = value;
    }

    return data;
}

/**
 * Nombre y versión del sistema operativo.
 *
 * @param {string} [gnomeVersion] versión de GNOME, p. ej. Config.PACKAGE_VERSION
 * @returns {{name: string, version: string}}
 */
export function getOsInfo(gnomeVersion = '') {
    try {
        const data = _parseOsRelease(_readText('/etc/os-release'));
        const name = (data.NAME || data.ID || '').trim();
        const versionId = (data.VERSION_ID || '').trim();

        let version = versionId;

        const gnome = String(gnomeVersion ?? '').trim()
            .replace(/^GNOME\s+/i, '');

        if (gnome) {
            version = versionId
                ? `${versionId} (GNOME ${gnome})`
                : `GNOME ${gnome}`;
        }

        return {name, version};
    } catch (_e) {
        return {name: '', version: ''};
    }
}
