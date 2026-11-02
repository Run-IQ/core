import type { CalculationModel } from '../types/model.js';
import type { Rule } from '../types/rule.js';
import type { OutputValue } from '../types/output.js';
import { validateOutputDeclaration } from '@run-iq/spec';
import type { OutputDeclaration } from '@run-iq/spec';
import { ModelNotFoundError } from '../errors/ModelNotFoundError.js';
import { InvalidModelError } from '../errors/InvalidModelError.js';
import { InputCopier } from '../input/copyInput.js';
import { DEFAULT_LIMITS } from '../limits.js';

/**
 * A copy of a declaration a plugin gave (`output`, `capabilities`): read once, frozen, plain, so
 * that a later write by anybody holding the model is not seen. Throws `InvalidModelError`
 * naming what cannot be copied.
 */
export function copyDeclaration(value: unknown, owner: string, what: string): unknown {
  const copier = new InputCopier(DEFAULT_LIMITS, 'maxRuleLeaves', true, true);
  const copy = copier.copy(value, what);
  const problems = [...copier.reasons, ...copier.refusals];
  if (problems.length > 0) throw new InvalidModelError(owner, problems);
  return copy;
}

/**
 * The calculation models by name. Models of any output type register without a cast; a model
 * whose `output` declaration `validateOutputDeclaration` of `@run-iq/spec` refuses is refused
 * with `InvalidModelError`.
 */
export class ModelRegistry {
  private readonly models = new Map<string, CalculationModel<OutputValue>>();
  /** What was registered: the version and the output declaration, each copied at that moment. */
  private readonly declared = new Map<
    string,
    { readonly version: string; readonly output: OutputDeclaration | undefined }
  >();

  register(model: CalculationModel<OutputValue>): void {
    const name = model.name;
    if (this.models.has(name)) {
      throw new Error(`Model "${name}" is already registered`);
    }
    // The declaration is copied once and the copy is the one validated: what the registry holds is
    // what was checked, whatever the model object is made to answer afterwards.
    let output: OutputDeclaration | undefined;
    const given: unknown = model.output; // read once
    if (given !== undefined) {
      output = copyDeclaration(given, name, '/output') as OutputDeclaration;
      const issues = validateOutputDeclaration(output);
      if (issues.length > 0) {
        throw new InvalidModelError(
          name,
          issues.map((issue) => issue.message),
        );
      }
    }
    this.models.set(name, model);
    this.declared.set(name, { version: model.version, output });
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
    for (const [name, model] of this.models) {
      // justification: `register` sets both maps together.
      const declared = this.declared.get(name) as NonNullable<ReturnType<typeof this.declared.get>>;
      fixed.models.set(name, fixModel(name, model, declared));
    }
    return fixed;
  }
}

/**
 * A frozen record of `model` as it is now: its name, version and output declaration as they were
 * registered (the declaration is the validated copy), and its functions taken once and bound, so
 * that a later assignment to `model.calculate` or to `model.output` (by any plugin holding the
 * model) is not seen by the evaluation. The functions run on the model object itself: its own
 * `this` state is its plugin's (see the threat model in the README).
 */
function fixModel(
  name: string,
  model: CalculationModel<OutputValue>,
  declared: { readonly version: string; readonly output: OutputDeclaration | undefined },
): CalculationModel<OutputValue> {
  const { validateParams, calculate, listVariables, describeParams } = model;
  return Object.freeze({
    name,
    version: declared.version,
    ...(declared.output === undefined ? {} : { output: declared.output }),
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
