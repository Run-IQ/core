import type { CalculationModel } from '../types/model.js';
import type { Rule } from '../types/rule.js';
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
   * A registry fixed at this moment: a model registered or replaced later is not seen by it, and
   * neither is a change to a model object: the functions are taken now and called on the model
   * as it is now. An evaluation works on one, so that what its rules were validated against is
   * what runs.
   */
  snapshot(): ModelRegistry {
    const fixed = new ModelRegistry();
    for (const [name, model] of this.models) fixed.models.set(name, fixModel(model));
    return fixed;
  }
}

/**
 * A frozen record of `model` as it is now: its descriptors, and its functions taken once and
 * bound, so that a later assignment to `model.calculate` (by any plugin holding the model) is not
 * seen by the evaluation.
 */
function fixModel(model: CalculationModel<OutputValue>): CalculationModel<OutputValue> {
  const { validateParams, calculate, listVariables, describeParams } = model;
  return Object.freeze({
    name: model.name,
    version: model.version,
    ...(model.output === undefined ? {} : { output: model.output }),
    validateParams: (params: unknown) => validateParams.call(model, params),
    calculate: (
      input: Record<string, unknown>,
      rule: Readonly<Rule>,
      params: unknown,
    ): ReturnType<CalculationModel<OutputValue>['calculate']> =>
      calculate.call(model, input, rule, params),
    ...(listVariables === undefined
      ? {}
      : { listVariables: (params: unknown) => listVariables.call(model, params) }),
    ...(describeParams === undefined ? {} : { describeParams: () => describeParams.call(model) }),
  });
}
