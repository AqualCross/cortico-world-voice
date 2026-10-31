import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerified } from '../src/download.ts';

let dir = '';
let server: Server | null = null;
let base = '';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audio-download-'));
  // 不认 Range 的服务器：带 Range 一律 416；/bad 正常但内容大小不对。
  server = createServer((req, res) => {
    if (req.headers.range) {
      res.writeHead(416);
      res.end();
      return;
    }
    if (req.url === '/bad') {
      res.writeHead(200, { 'content-length': '10' });
      res.end('0123456789');
      return;
    }
    res.writeHead(200, { 'content-length': '5' });
    res.end('12345');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('下载校验', () => {
  it('第一个来源大小不对时删掉坏文件，第二个来源能拿到正确内容', async () => {
    const dest = join(dir, 'f.bin');
    await downloadVerified([`${base}/bad`, `${base}/good`], dest, {
      bytes: 5,
      signal: new AbortController().signal,
      attempts: 1,
    });
    expect(readFileSync(dest, 'utf8')).toBe('12345');
  });

  it('所有来源都不对时报出最后几个错误', async () => {
    await expect(downloadVerified([`${base}/bad`], join(dir, 'g.bin'), {
      bytes: 5,
      signal: new AbortController().signal,
      attempts: 1,
    })).rejects.toThrow('大小');
  });
});
