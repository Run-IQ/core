import type { PPEPlugin } from '../types/plugin.js';

export class PluginRegistry {
  private readonly plugins = new Map<string, PPEPlugin>();

  register(plugin: PPEPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): PPEPlugin | undefined {
    return this.plugins.get(name);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  getAll(): ReadonlyMap<string, PPEPlugin> {
    return this.plugins;
  }
}
