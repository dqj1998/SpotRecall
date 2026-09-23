import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateModelFile,
  downloadFileWithRetry,
  ensureModelFile,
} from '../scripts/download-model.mjs';

const VALID_CONFIG = JSON.stringify({ model_type: 'xlm-roberta', architectures: ['XLMRobertaModel'] });
const MINI_SIZES = { 'config.json': 1, 'tokenizer.json': 1 };

function validConfigBuf() {
  return Buffer.from(VALID_CONFIG);
}

// Node Buffer may share an 8KB internal pool; slice out exactly our bytes so
// mocked arrayBuffer() responses aren't polluted with pool garbage.
function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function headersOf(obj) {
  return { get: (k) => obj[k] ?? null };
}

describe('validateModelFile', () => {
  it('rejects a 0-byte body (the original bug)', () => {
    const v = validateModelFile('config.json', Buffer.alloc(0));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/empty/);
  });

  it('rejects a body below the size floor', () => {
    const v = validateModelFile('onnx/model_quantized.onnx', Buffer.from('tiny'));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/floor/);
  });

  it('rejects invalid JSON for config.json', () => {
    const v = validateModelFile('config.json', Buffer.from('{'), null, { minSizes: MINI_SIZES });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/invalid JSON/);
  });

  it('rejects config.json missing required keys (proxy {} stub)', () => {
    const v = validateModelFile('config.json', Buffer.from('{}'), null, { minSizes: MINI_SIZES });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/model_type/);
  });

  it('rejects an HTML stub returned with HTTP 200 (intercepted proxy)', () => {
    const stub = Buffer.from('<html><body>captive portal</body></html>');
    const v = validateModelFile('onnx/model_quantized.onnx', stub, null, {
      minSizes: { 'onnx/model_quantized.onnx': 10 },
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/HTML/);
  });

  it('rejects a Content-Length mismatch (truncated transfer)', () => {
    const buf = validConfigBuf();
    const v = validateModelFile('config.json', buf, headersOf({ 'content-length': String(buf.length + 100) }), {
      minSizes: MINI_SIZES,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/truncated/);
  });

  it('accepts a valid config.json with matching Content-Length', () => {
    const buf = validConfigBuf();
    const v = validateModelFile('config.json', buf, headersOf({ 'content-length': String(buf.length) }), {
      minSizes: MINI_SIZES,
    });
    expect(v).toEqual({ ok: true });
  });

  it('accepts a valid tokenizer.json above its floor', () => {
    const buf = Buffer.from(JSON.stringify({ model: { vocab: ['a', 'b'] } }));
    expect(validateModelFile('tokenizer.json', buf, null, { minSizes: MINI_SIZES })).toEqual({ ok: true });
  });
});

describe('downloadFileWithRetry', () => {
  it('retries when the first attempt returns an empty body, then succeeds', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (urls.length === 1) {
        return { ok: true, status: 200, headers: headersOf({}), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, headers: headersOf({}), arrayBuffer: async () => bufToArrayBuffer(validConfigBuf()) };
    };
    const { buf } = await downloadFileWithRetry({
      baseUrl: 'http://x', rel: 'config.json', attempts: 3, backoffMs: 0,
      minSizes: MINI_SIZES, fetchImpl,
    });
    expect(urls.length).toBe(2);
    expect(buf.toString('utf8')).toBe(VALID_CONFIG);
  });

  it('throws after exhausting attempts on a persistently empty body', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200, headers: headersOf({}), arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      downloadFileWithRetry({ baseUrl: 'http://x', rel: 'config.json', attempts: 3, backoffMs: 0, minSizes: MINI_SIZES, fetchImpl }),
    ).rejects.toThrow(/after 3 attempts/);
  });

  it('retries on non-OK status and reports it', async () => {
    const calls = [];
    const fetchImpl = async () => {
      calls.push(1);
      return { ok: false, status: 502, statusText: 'Bad Gateway', headers: headersOf({}), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    await expect(
      downloadFileWithRetry({ baseUrl: 'http://x', rel: 'config.json', attempts: 2, backoffMs: 0, minSizes: MINI_SIZES, fetchImpl }),
    ).rejects.toThrow(/502/);
    expect(calls.length).toBe(2);
  });
});

describe('ensureModelFile end-to-end (real local fixture server)', () => {
  function fixtureServer() {
    const server = createServer((req, res) => {
      if (req.url === '/config.json') {
        const body = validConfigBuf();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function baseUrlOf(server) {
    return `http://127.0.0.1:${server.address().port}`;
  }

  it('re-downloads a stale 0-byte file, writes atomically, and trusts valid files on later runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sr-model-'));
    const dest = join(dir, 'config.json');
    // Stage the broken state that caused the 0% report.
    await writeFile(dest, Buffer.alloc(0));

    const server = await fixtureServer();
    try {
      const logs = [];
      await ensureModelFile({ baseUrl: baseUrlOf(server), rel: 'config.json', dest, minSizes: MINI_SIZES, log: (m) => logs.push(m) });

      expect((await readFile(dest)).toString('utf8')).toBe(VALID_CONFIG);
      expect(logs.join(' ')).toMatch(/re-downloading/);
      await expect(readFile(`${dest}.part`)).rejects.toThrow();

      // Second run: valid on disk → skipped without any network call.
      const fetchSpy = vi.fn(async () => {
        throw new Error('must not fetch');
      });
      await ensureModelFile({ baseUrl: baseUrlOf(server), rel: 'config.json', dest, minSizes: MINI_SIZES, fetchImpl: fetchSpy, log: () => {} });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('keeps the previous file and leaves no .part when the re-download fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sr-model-'));
    const dest = join(dir, 'config.json');
    await writeFile(dest, 'stale-but-below-floor');

    const fetchImpl = async () => ({
      ok: true, status: 200, headers: headersOf({}), arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      ensureModelFile({ baseUrl: 'http://x', rel: 'config.json', dest, attempts: 2, backoffMs: 0, minSizes: { 'config.json': 10_000 }, fetchImpl, log: () => {} }),
    ).rejects.toThrow(/after 2 attempts/);

    expect((await readFile(dest)).toString('utf8')).toBe('stale-but-below-floor');
    await expect(readFile(`${dest}.part`)).rejects.toThrow();
  });
});