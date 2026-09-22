import type { ServiceDefinition } from './types.js';

export class ServiceRegistry {
  private readonly definitions = new Map<string, ServiceDefinition>();
  register(definition: ServiceDefinition): void {
    if (!definition.id.trim()) throw new Error('SERVICE_ID_REQUIRED');
    if (this.definitions.has(definition.id)) throw new Error(`SERVICE_ALREADY_REGISTERED:${definition.id}`);
    this.definitions.set(definition.id, { ...definition, dependsOn: [...definition.dependsOn] });
  }
  get(id: string): ServiceDefinition | undefined { return this.definitions.get(id); }
  list(includeOptional = true): ServiceDefinition[] { return [...this.definitions.values()].filter((item) => includeOptional || item.required); }
  topological(includeOptional = true): ServiceDefinition[] {
    const selected = new Map(this.list(includeOptional).map((item) => [item.id, item]));
    const result: ServiceDefinition[] = []; const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`SERVICE_DEPENDENCY_CYCLE:${id}`);
      const item = selected.get(id); if (!item) throw new Error(`SERVICE_DEPENDENCY_MISSING:${id}`);
      visiting.add(id); for (const dependency of item.dependsOn) if (selected.has(dependency)) visit(dependency); visiting.delete(id); visited.add(id); result.push(item);
    };
    for (const item of selected.values()) visit(item.id);
    return result;
  }
  reverse(includeOptional = true): ServiceDefinition[] { return this.topological(includeOptional).reverse(); }
}
