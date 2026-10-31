import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gptSovitsMissing, inferConfig, linkPretrainedModels, type GptSovitsSetup } from '../src/gpt-sovits.ts';

let dir: string;
const setup = (): GptSovitsSetup => ({
  projectDir: dir,
  modelsDir: join(dir, 'models'),
  python: join(dir, '.venv', 'Scripts', 'python.exe'),
  device: 'cuda',
  gpuIndex: 1,
  version: 'v5turbo',
  t2sWeights: 's1v3.ckpt',
  vitsWeights: 'gsv-v5-pretrained/s2Gv5turbo.pth',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gsv-'));
  mkdirSync(join(dir, 'GPT_SoVITS', 'pretrained_models'), { recursive: true });
  writeFileSync(join(dir, 'GPT_SoVITS', 'pretrained_models', '.gitignore'), '*\n');
  mkdirSync(join(dir, 'models', 'gsv-v5-pretrained'), { recursive: true });
  mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(dir, 'api_v2.py'), '');
  writeFileSync(join(dir, '.venv', 'Scripts', 'python.exe'), '');
  writeFileSync(join(dir, 'models', 's1v3.ckpt'), 'x');
  writeFileSync(join(dir, 'models', 'gsv-v5-pretrained', 's2Gv5turbo.pth'), 'x');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('本机 GPT-SoVITS', () => {
  it('齐了就不报缺，缺哪项点哪项', () => {
    expect(gptSovitsMissing(setup())).toEqual([]);
    rmSync(join(dir, 'models', 'gsv-v5-pretrained', 's2Gv5turbo.pth'));
    rmSync(join(dir, '.venv', 'Scripts', 'python.exe'));
    expect(gptSovitsMissing(setup())).toEqual(['Python 环境', 'SoVITS 权重 gsv-v5-pretrained/s2Gv5turbo.pth']);
  });

  it('配置写的是绝对路径与所选档位', () => {
    const text = inferConfig(setup());
    expect(text).toContain('device: cuda');
    expect(text).toContain('is_half: true');
    expect(text).toContain('version: v5turbo');
    expect(text).toContain(`t2s_weights_path: ${join(dir, 'models', 's1v3.ckpt').replace(/\\/g, '/')}`);
  });

  it('把 pretrained_models 接到本包模型目录，且不动有内容的目录', () => {
    linkPretrainedModels(setup());
    expect(readlinkSync(join(dir, 'GPT_SoVITS', 'pretrained_models'))).toBe(setup().modelsDir);
    expect(existsSync(join(dir, 'GPT_SoVITS', 'pretrained_models', 's1v3.ckpt'))).toBe(true);
    linkPretrainedModels(setup()); // 再来一次不报错

    rmSync(join(dir, 'GPT_SoVITS', 'pretrained_models'), { force: true });
    mkdirSync(join(dir, 'GPT_SoVITS', 'pretrained_models'), { recursive: true });
    writeFileSync(join(dir, 'GPT_SoVITS', 'pretrained_models', '我的权重.pth'), 'x');
    expect(() => linkPretrainedModels(setup())).toThrow('已经有东西');
  });

  it('已有的联接指向别处时换成我们的', () => {
    const other = join(dir, 'models');
    rmSync(join(dir, 'GPT_SoVITS', 'pretrained_models'), { recursive: true, force: true });
    symlinkSync(resolve(other, '..'), join(dir, 'GPT_SoVITS', 'pretrained_models'), 'junction');
    linkPretrainedModels(setup());
    expect(resolve(readlinkSync(join(dir, 'GPT_SoVITS', 'pretrained_models')))).toBe(resolve(setup().modelsDir));
    expect(lstatSync(join(dir, 'GPT_SoVITS', 'pretrained_models')).isSymbolicLink()).toBe(true);
  });
});
