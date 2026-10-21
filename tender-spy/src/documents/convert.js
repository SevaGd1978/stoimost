import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OFFICE = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt', 'txt', 'htm', 'html', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'ppt', 'pptx', 'odp']);
const SPREADSHEET = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv']);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz']);
const IMAGE = new Set(['jpg', 'jpeg', 'png']);
const SIGNATURE = new Set(['sig', 'sgn', 'p7s', 'p7m', 'p7b', 'cer', 'crt', 'sign']);

export const extOf = (name) => (String(name).match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase();

/** Тип по сигнатуре: у файлов ЕИС расширение бывает неверным (HTML под видом .doc). */
function sniff(head) {
  if (!head?.length) return null;
  const ascii = head.subarray(0, 16).toString('latin1');
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (ascii.startsWith('Rar!')) return 'rar';
  if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) return '7z';
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gz';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
  if (ascii.startsWith('\x89PNG')) return 'png';
  if (ascii.startsWith('{\\rtf')) return 'rtf';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'ole';
  if (ascii.startsWith('PK')) return 'zip-container';
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 200).toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || /^<\?xml[^>]*>\s*<html/.test(text)) return 'html';
  return null;
}

/**
 * Что делать с файлом: pdf | office | image | archive | signature | unsupported.
 * `spreadsheet` — признак таблицы (для неё ограничиваем число страниц).
 */
export function classify(name, head) {
  const ext = extOf(name);
  const sig = sniff(head);
  if (sig === 'pdf') return { kind: 'pdf', ext: 'pdf' };
  if (sig === 'rar' || sig === '7z' || sig === 'gz') return { kind: 'archive', ext: sig };
  if (sig === 'jpg' || sig === 'png') return { kind: 'image', ext: sig };
  if (sig === 'html') return { kind: 'office', ext: 'html' };
  if (sig === 'rtf') return { kind: 'office', ext: 'rtf' };
  if (sig === 'zip-container' && !OFFICE.has(ext)) return { kind: 'archive', ext: 'zip' };
  if (SIGNATURE.has(ext)) return { kind: 'signature', ext };
  if (OFFICE.has(ext)) return { kind: 'office', ext, spreadsheet: SPREADSHEET.has(ext) };
  if (sig === 'ole') return { kind: 'office', ext: 'doc' };
  if (ARCHIVE.has(ext)) return { kind: 'archive', ext };
  if (IMAGE.has(ext)) return { kind: 'image', ext };
  return { kind: 'unsupported', ext };
}

function run(cmd, args, { timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const commandCache = new Map();
export function hasCommand(cmd) {
  if (!commandCache.has(cmd)) {
    const dirs = String(process.env.PATH || '').split(path.delimiter);
    commandCache.set(cmd, dirs.some((d) => d && fs.existsSync(path.join(d, cmd))));
  }
  return commandCache.get(cmd);
}

export function tools() {
  return {
    soffice: hasCommand('soffice') ? 'soffice' : hasCommand('libreoffice') ? 'libreoffice' : null,
    unar: hasCommand('unar'),
    unzip: hasCommand('unzip'),
  };
}

// LibreOffice не любит параллельные запуски с одним профилем — конвертируем по очереди.
let queue = Promise.resolve();
function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const profileDir = path.join(os.tmpdir(), 'tender-spy-lo-profile');

/** Office/HTML/TXT → PDF через LibreOffice. Возвращает путь к PDF. */
export function officeToPdf(file, outDir, { timeoutMs = 180_000, ext: forcedExt } = {}) {
  const soffice = tools().soffice;
  if (!soffice) return Promise.reject(new Error('на сервере не установлен LibreOffice'));
  return serial(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    // Имя файла может быть любым: копируем под безопасным именем, чтобы найти результат.
    const ext = forcedExt || extOf(file) || 'bin';
    const work = fs.mkdtempSync(path.join(outDir, 'lo-'));
    const src = path.join(work, `source.${ext}`);
    fs.copyFileSync(file, src);
    try {
      await run(
        soffice,
        [`-env:UserInstallation=file://${profileDir}`, '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', work, src],
        { timeoutMs },
      );
      const pdf = path.join(work, 'source.pdf');
      if (!fs.existsSync(pdf) || fs.statSync(pdf).size === 0) throw new Error('LibreOffice не смог открыть файл');
      const target = path.join(outDir, `${path.basename(work)}.pdf`);
      fs.renameSync(pdf, target);
      return target;
    } catch (err) {
      if (err.killed || err.signal === 'SIGKILL') throw new Error('конвертация заняла слишком много времени');
      throw err.stderr ? new Error(err.stderr.split('\n').find(Boolean) || err.message) : err;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Распаковывает архив, возвращает пути файлов внутри (в порядке имён). */
export async function extractArchive(file, outDir, { timeoutMs = 120_000 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const t = tools();
  if (t.unar) {
    // Имена в ZIP из Windows обычно в CP866 без флага UTF-8; unar сам угадывает кодировку.
    await run('unar', ['-q', '-f', '-D', '-o', outDir, file], { timeoutMs });
  } else if (t.unzip && classify(file, fs.readFileSync(file).subarray(0, 16)).ext === 'zip') {
    await run('unzip', ['-q', '-o', '-O', 'CP866', file, '-d', outDir], { timeoutMs });
  } else {
    throw new Error('на сервере нет распаковщика архивов');
  }
  const root = path.resolve(outDir);
  return listFiles(outDir).filter((p) => path.resolve(p).startsWith(root + path.sep));
}
