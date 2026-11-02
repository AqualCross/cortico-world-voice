import { describe, it, expect } from 'vitest';
import { isDirectHost, normalizeProxy } from '../src/proxy.ts';

describe('系统代理设置', () => {
  it('纯 host:port 补上 http://', () => {
    expect(normalizeProxy('127.0.0.1:10808')).toBe('http://127.0.0.1:10808');
  });

  it('按协议分的列表取 https 那条', () => {
    expect(normalizeProxy('http=127.0.0.1:8888;https=127.0.0.1:10808;socks=127.0.0.1:10809'))
      .toBe('http://127.0.0.1:10808');
  });

  it('已带协议的原样保留，没有可用地址给 null', () => {
    expect(normalizeProxy('http://proxy.local:3128')).toBe('http://proxy.local:3128');
    expect(normalizeProxy('ftp=127.0.0.1:21')).toBeNull();
    expect(normalizeProxy('')).toBeNull();
  });

  it('镜像站与本机地址直连，普通站点走代理', () => {
    expect(isDirectHost('ghfast.top')).toBe(true);
    expect(isDirectHost('sub.ghfast.top')).toBe(true);
    expect(isDirectHost('127.0.0.1')).toBe(true);
    expect(isDirectHost('github.com')).toBe(false);
  });
});
