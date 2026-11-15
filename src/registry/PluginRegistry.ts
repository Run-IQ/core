import type { PPEPlugin } from '../types/plugin.js';
import { readIdentity, registering } from '../engine/pluginPort.js';

type Fn = (...args: never[]) => unknown;

/**
 * What the engine took from a plugin when it was registered, and keeps: its name and version
 * (strings of the shape the port checks) and the functions it gave. The engine never reads the
 * plugin object again; it calls these through the port, with the plugin as `this`.
 */
export interface PluginHandle {
  readonly name: string;
  readonly version: string;
  /** The plugin, as the `this` of its own functions. Never read. */
  readonly source: PPEPlugin;
  readonly onInit: Fn;
  readonly beforeEvaluate: Fn | undefined;
  readonly afterEvaluate: Fn | undefined;
  readonly onError: Fn | undefined;
}

export class PluginRegistry {
  private readonly handles = new Map<string, PluginHandle>();

  /** Reads `plugin` once and keeps what it declares. */
  register(plugin: PPEPlugin): PluginHandle {
    return registering(() => {
      const { name, version } = readIdentity(plugin, 'plugin', 'name');
      if (this.handles.has(name)) {
        throw new Error(`Plugin "${name}" is already registered`);
      }
      const functionOf = (key: keyof PPEPlugin, required: boolean): Fn | undefined => {
        const fn: unknown = plugin[key];
        if (typeof fn === 'function') return fn as Fn;
        if (required || fn !== undefined) {
          throw new TypeError(`plugin ${name}: ${String(key)} must be a function`);
        }
        return undefined;
      };
      const handle: PluginHandle = Object.freeze({
        name,
        version,
        source: plugin,
        onInit: functionOf('onInit', true) as Fn,
        beforeEvaluate: functionOf('beforeEvaluate', false),
        afterEvaluate: functionOf('afterEvaluate', false),
        onError: functionOf('onError', false),
      });
      this.handles.set(name, handle);
      return handle;
    });
  }

  get(name: string): PPEPlugin | undefined {
    return this.handles.get(name)?.source;
  }

  has(name: string): boolean {
    return this.handles.has(name);
  }

  getAll(): ReadonlyMap<string, PPEPlugin> {
    return new Map([...this.handles].map(([name, handle]) => [name, handle.source]));
  }

  /** The handles, in registration order. */
  all(): readonly PluginHandle[] {
    return [...this.handles.values()];
  }
}
