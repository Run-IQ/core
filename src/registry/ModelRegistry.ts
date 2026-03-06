import type { CalculationModel } from '../types/model.js';
import { ModelNotFoundError } from '../errors/ModelNotFoundError.js';

export class ModelRegistry {
  private readonly models = new Map<string, CalculationModel>();

  register(model: CalculationModel): void {
    if (this.models.has(model.name)) {
      throw new Error(`Model "${model.name}" is already registered`);
    }
    this.models.set(model.name, model);
  }

  get(name: string): CalculationModel {
    const model = this.models.get(name);
    if (!model) {
      throw new ModelNotFoundError(name);
    }
    return model;
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  getAll(): ReadonlyMap<string, CalculationModel> {
    return this.models;
  }
}
