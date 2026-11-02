import type { CalculationModel } from '../types/model.js';
import type { OutputValue } from '../types/output.js';
import { validateOutputDeclaration } from '@run-iq/spec';
import { ModelNotFoundError } from '../errors/ModelNotFoundError.js';
import { InvalidModelError } from '../errors/InvalidModelError.js';

/**
 * The calculation models by name. Models of any output type register without a cast; a model
 * whose `output` declaration `validateOutputDeclaration` of `@run-iq/spec` refuses is refused
 * with `InvalidModelError`.
 */
export class ModelRegistry {
  private readonly models = new Map<string, CalculationModel<OutputValue>>();

  register(model: CalculationModel<OutputValue>): void {
    if (this.models.has(model.name)) {
      throw new Error(`Model "${model.name}" is already registered`);
    }
    if (model.output !== undefined) {
      const issues = validateOutputDeclaration(model.output);
      if (issues.length > 0) {
        throw new InvalidModelError(
          model.name,
          issues.map((issue) => issue.message),
        );
      }
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

  /** A copy: writing to it changes nothing in the registry. */
  getAll(): ReadonlyMap<string, CalculationModel<OutputValue>> {
    return new Map(this.models);
  }

  /**
   * A registry fixed at this moment: a model registered or replaced later is not seen by it. An
   * evaluation works on one, so that what its rules were validated against is what runs.
   */
  snapshot(): ModelRegistry {
    const fixed = new ModelRegistry();
    for (const [name, model] of this.models) fixed.models.set(name, model);
    return fixed;
  }
}
