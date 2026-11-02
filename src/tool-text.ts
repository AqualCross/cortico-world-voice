/**
 * 工具设置的部署覆盖：工具开关，以及每个工具声明里的 description / title 可编辑字段，
 * 覆盖按 JSON Pointer 存在 `<部署>/worlds/<id>/tool-text.json`；包内那份只读。
 * 模型看到的工具表用 `resolve()`，面板编辑用 `read()` / `save()` / `reset()`。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const escape = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
const tokens = (path: string): string[] => path.slice(1).split('/').map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));

const MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];
const SINGLES = ['items', 'additionalItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'];
const ARRAYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

export type ToolDecl = Omit<ToolDef, 'handler'>;

export interface ToolTextField {
  /** 在工具对象上的 JSON Pointer。 */
  path: string;
  /** 人读的位置，如 `parameters.source`。 */
  location: string;
  keyword: string;
  defaultText: string;
}

/** 一个工具里所有可改的文字：工具描述 + 参数各层的 description / title。 */
export function toolTextFields(tool: ToolDecl): ToolTextField[] {
  const fields: ToolTextField[] = [{ path: '/description', location: tool.name, keyword: 'description', defaultText: tool.description }];
  const walk = (node: unknown, path: string, location: string): void => {
    if (!object(node)) return;
    for (const keyword of ['description', 'title']) {
      if (keyword === 'description' || typeof node[keyword] === 'string') {
        fields.push({ path: `${path}/${keyword}`, location, keyword, defaultText: typeof node[keyword] === 'string' ? node[keyword] : '' });
      }
    }
    for (const keyword of MAPS) {
      if (object(node[keyword])) {
        for (const [key, child] of Object.entries(node[keyword])) {
          walk(child, `${path}/${keyword}/${escape(key)}`, location === 'parameters' && keyword === 'properties' ? key : `${location}.${keyword}.${key}`);
        }
      }
    }
    for (const keyword of SINGLES) walk(node[keyword], `${path}/${keyword}`, `${location}.${keyword}`);
    for (const keyword of [...ARRAYS, 'items']) {
      const value = node[keyword];
      if (Array.isArray(value)) value.forEach((child, index) => walk(child, `${path}/${keyword}/${index}`, `${location}.${keyword}[${index}]`));
    }
  };
  walk(tool.parameters, '/parameters', 'parameters');
  return fields;
}

function setText(tool: Record<string, unknown>, path: string, value: string): void {
  const keys = tokens(path);
  const key = keys.pop()!;
  let node: Record<string, unknown> = tool;
  for (const segment of keys) node = node[segment] as Record<string, unknown>;
  node[key] = value;
}

interface Layer {
  raw: string;
  tools: Record<string, Record<string, string>>;
  disabledTools?: string[];
  error?: string;
}

function readLayer(path: string | null): Layer {
  if (!path || !existsSync(path)) return { raw: '', tools: {} };
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (data.version !== 1 || !object(data.tools)
      || !Object.values(data.tools).every((fields) => object(fields) && Object.values(fields).every((text) => typeof text === 'string'))
      || (data.disabledTools !== undefined && (!Array.isArray(data.disabledTools) || !data.disabledTools.every((name) => typeof name === 'string')))) {
      throw new Error('Expected version 1, a tools object containing text overrides, and optional disabledTools names.');
    }
    return { raw, tools: data.tools as Record<string, Record<string, string>>,
      ...(data.disabledTools === undefined ? {} : { disabledTools: [...new Set(data.disabledTools as string[])] }) };
  } catch (error) {
    return { raw, tools: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ToolTextView {
  revision: string;
  overrides: Record<string, Record<string, string>>;
  disabledTools: string[];
  defaultDisabledTools: string[];
  warnings: Array<{ layer: 'package' | 'deployment'; tool?: string; path?: string; error?: string }>;
  tools: Array<Record<string, unknown> & {
    name: string;
    enabled: boolean;
    fields: Array<ToolTextField & { inheritedText: string; inheritedSource: 'default' | 'package'; text: string; source: 'default' | 'package' | 'deployment' }>;
  }>;
}

export interface ToolTextOptions {
  /** `<部署>`：覆盖写这里。 */
  botDir: string;
  /** bot 代码包目录；包内 `worlds/<id>/tool-text.json` 作为上层覆盖。 */
  packageDir: string;
  id: string;
  /** 没有部署开关覆盖时默认关闭的工具。 */
  defaultDisabledTools?: readonly string[];
}

/** 包内默认只读；覆盖只写部署这一层。 */
export class ToolTextStore {
  private readonly defaults: ReadonlyArray<ToolDecl>;
  private readonly fields: Map<string, Map<string, ToolTextField>>;
  private readonly path: string | null;
  private readonly packagePath: string | null;
  private readonly defaultDisabledTools: string[];

  constructor(defaults: ReadonlyArray<ToolDecl>, opts: ToolTextOptions) {
    this.defaults = defaults;
    this.defaultDisabledTools = [...new Set(opts.defaultDisabledTools ?? [])];
    this.fields = new Map(defaults.map((tool) => [tool.name, new Map(toolTextFields(tool).map((field) => [field.path, field]))]));
    this.path = opts.botDir ? join(opts.botDir, 'worlds', opts.id, 'tool-text.json') : null;
    this.packagePath = opts.packageDir ? join(opts.packageDir, 'worlds', opts.id, 'tool-text.json') : null;
  }

  read(): ToolTextView {
    const inherited = readLayer(this.packagePath);
    const deployment = readLayer(this.path);
    // 部署设置损坏时保持关闭，避免原本禁用的工具因解析失败而重新暴露。
    const disabledTools = deployment.error ? this.defaults.map((tool) => tool.name) : deployment.disabledTools ?? this.defaultDisabledTools;
    const warnings: ToolTextView['warnings'] = [];
    // 深拷贝一份，免得两份声明共享同一个 schema 节点。
    const tools = JSON.parse(JSON.stringify(this.defaults)) as Array<Record<string, unknown> & { name: string }>;
    for (const [layer, data] of [['package', inherited], ['deployment', deployment]] as const) {
      if (data.error) warnings.push({ layer, error: data.error });
      for (const [name, changes] of Object.entries(data.tools)) {
        for (const [path, text] of Object.entries(changes)) {
          if (!this.fields.get(name)?.has(path)) {
            warnings.push({ layer, tool: name, path });
            continue;
          }
          setText(tools.find((tool) => tool.name === name)!, path, text);
        }
      }
    }
    return {
      revision: createHash('sha256').update(JSON.stringify([this.defaults, this.defaultDisabledTools, inherited.raw, deployment.raw])).digest('hex'),
      overrides: deployment.tools,
      disabledTools,
      defaultDisabledTools: this.defaultDisabledTools,
      warnings,
      tools: tools.map((tool) => ({
        ...tool,
        enabled: !disabledTools.includes(tool.name),
        fields: [...(this.fields.get(tool.name)?.values() ?? [])].map((field) => {
          const inheritedText = inherited.tools[tool.name]?.[field.path] ?? field.defaultText;
          const overridden = Object.hasOwn(deployment.tools[tool.name] ?? {}, field.path);
          const inheritedSource = Object.hasOwn(inherited.tools[tool.name] ?? {}, field.path) ? 'package' : 'default';
          return {
            ...field,
            inheritedText,
            inheritedSource,
            text: deployment.tools[tool.name]?.[field.path] ?? inheritedText,
            source: overridden ? 'deployment' : inheritedSource,
          } as ToolTextView['tools'][number]['fields'][number];
        }),
      })),
    };
  }

  /** 模型看到的工具表：移除关闭项，应用说明覆盖，丢掉面板元数据。 */
  resolve(): ToolDecl[] {
    return this.read().tools.filter((tool) => tool.enabled)
      .map(({ fields: _fields, enabled: _enabled, ...tool }) => tool as unknown as ToolDecl);
  }

  private current(expectedRevision: string): ToolTextView {
    if (!this.path) throw new Error('The deployment directory is unavailable.');
    const current = this.read();
    if (expectedRevision !== current.revision) throw new Error('工具设置已变化，请先刷新再保存。');
    return current;
  }

  save({ expectedRevision, overrides, disabledTools }: { expectedRevision: string; overrides: unknown; disabledTools?: unknown }): ToolTextView {
    const current = this.current(expectedRevision);
    if (current.warnings.some((warning) => warning.layer === 'deployment' && warning.error)) {
      throw new Error('覆盖文件不合法，请先恢复默认再保存。');
    }
    if (!object(overrides)) throw new Error('Expected a tools object containing text overrides.');
    const disabled = disabledTools === undefined ? current.disabledTools : disabledTools;
    if (!Array.isArray(disabled) || !disabled.every((name) => typeof name === 'string')) {
      throw new Error('Expected disabledTools to be an array of tool names.');
    }
    for (const name of disabled) {
      if (!this.fields.has(name) && !current.disabledTools.includes(name)) throw new Error(`Unknown tool: ${name}.`);
    }
    const nextDisabled = [...new Set(disabled)] as string[];
    const customSwitches = nextDisabled.length !== this.defaultDisabledTools.length
      || nextDisabled.some((name) => !this.defaultDisabledTools.includes(name));
    const next: Record<string, Record<string, string>> = {};
    for (const [name, changes] of Object.entries(overrides)) {
      if (!object(changes)) throw new Error(`Invalid text overrides for ${name}.`);
      const fields = new Map(current.tools.find((tool) => tool.name === name)?.fields.map((field) => [field.path, field]) ?? []);
      const entries: Array<[string, string]> = [];
      for (const [path, text] of Object.entries(changes)) {
        if (typeof text !== 'string') throw new Error(`Expected text at ${name}${path}.`);
        const field = fields.get(path);
        if (!field) {
          if (!Object.hasOwn(current.overrides[name] ?? {}, path) || current.overrides[name][path] !== text) {
            throw new Error(`Unknown tool text field: ${name}${path}.`);
          }
        } else if (text === field.inheritedText) {
          continue;
        }
        entries.push([path, text]);
      }
      if (entries.length) next[name] = Object.fromEntries(entries);
    }
    if (Object.keys(next).length || customSwitches) {
      mkdirSync(dirname(this.path!), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify({ version: 1, tools: next, ...(customSwitches ? { disabledTools: nextDisabled } : {}) }, null, 2) + '\n', { flag: 'wx' });
        renameSync(temp, this.path!);
      } finally {
        rmSync(temp, { force: true });
      }
    } else {
      rmSync(this.path!, { force: true });
    }
    return this.read();
  }

  reset({ expectedRevision }: { expectedRevision: string }): ToolTextView {
    this.current(expectedRevision);
    if (this.path) rmSync(this.path, { force: true });
    return this.read();
  }
}
