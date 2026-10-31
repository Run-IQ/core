import type { CalculationModel } from '../types/model.js';
import type { OutputValue } from '../types/output.js';
import { ModelNotFoundError } from '../errors/ModelNotFoundError.js';

/** The calculation models by name. Models of any output type register without a cast. */
export class ModelRegistry {
  private readonly models = new Map<string, CalculationModel<OutputValue>>();

  register(model: CalculationModel<OutputValue>): void {
    if (this.models.has(model.name)) {
      throw new Error(`Model "${model.name}" is already registered`);
    }
    this.models.set(model.name, model);
  }

  get(name: string): CalculationModel<OutputValue> {
    const model = this.models.get(name);
    if (!model) {
      throw new ModelNotFoundError(name);
    }
    return model;
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  getAll(): ReadonlyMap<string, CalculationModel<OutputValue>> {
    return this.models;
  }
}
