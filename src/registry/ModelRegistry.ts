import type { CalculationModel } from '../types/model.js';
import type { Rule } from '../types/rule.js';
import type { OutputValue } from '../types/output.js';
import { validateOutputDeclaration } from '@run-iq/spec';
import type { OutputDeclaration } from '@run-iq/spec';
import { ModelNotFoundError } from '../errors/ModelNotFoundError.js';
import { InvalidModelError } from '../errors/InvalidModelError.js';
import { InputCopier } from '../input/copyInput.js';
import { DEFAULT_LIMITS } from '../limits.js';
import { isolated } from '../engine/trust.js';
import type { ModelDescriptor } from '../types/plugin.js';
import { callSync, readIdentity, registering } from '../engine/pluginPort.js';

/**
 * A copy of a declaration a plugin gave (`output`, `capabilities`): read once, frozen, plain, so
 * that a later write by anybody holding the model is not seen. Throws `InvalidModelError`
 * naming what cannot be copied. Call inside `registering`.
 */
export function copyDeclaration(value: unknown, owner: string, what: string): unknown {
  const copier = new InputCopier(DEFAULT_LIMITS, 'maxRuleLeaves', true, true, true);
  const copy = copier.copy(value, what);
  const problems = [...copier.reasons, ...copier.refusals];
  if (problems.length > 0) throw new InvalidModelError(owner, problems);
  return copy;
}

type Fn = (...args: never[]) => unknown;

/** What the engine took from a model when it was registered, and keeps. */
interface Declared {
  readonly version: string;
  readonly output: OutputDeclaration | undefined;
  readonly validateParams: Fn;
  readonly calculate: Fn;
  readonly listVariables: Fn | undefined;
  readonly describeParams: Fn | undefined;
}

/**
 * The calculation models by name. Models of any output type register without a cast; a model
 * whose `output` declaration `validateOutputDeclaration` of `@run-iq/spec` refuses is refused
 * with `InvalidModelError`. A model is read once, when it is registered (its `name` and `version`,
 * its `output` and its functions); the engine keeps those copies and never reads the model again.
 */
export class ModelRegistry {
  private readonly models = new Map<string, CalculationModel<OutputValue>>();
  private readonly declared = new Map<string, Declared>();

  register(model: CalculationModel<OutputValue>): void {
    isolated(() => this.add(model));
  }

  private add(model: CalculationModel<OutputValue>): void {
    registering(() => {
      const { name, version } = readIdentity(model, 'model', 'name');
      if (this.models.has(name)) {
        throw new Error(`Model "${name}" is already registered`);
      }
      // The declaration is copied once and the copy is the one validated: what the registry holds
      // is what was checked, whatever the model object is made to answer afterwards.
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
      const functionOf = (key: keyof CalculationModel, required: boolean): Fn | undefined => {
        const fn: unknown = model[key];
        if (typeof fn === 'function') return fn as Fn;
        if (required || fn !== undefined) {
          throw new InvalidModelError(name, [`${String(key)} must be a function`]);
        }
        return undefined;
      };
      const declared: Declared = {
        version,
        output,
        validateParams: functionOf('validateParams', true) as Fn,
        calculate: functionOf('calculate', true) as Fn,
        listVariables: functionOf('listVariables', false),
        describeParams: functionOf('describeParams', false),
      };
      this.models.set(name, model);
      this.declared.set(name, declared);
    });
  }

  /** What a plugin may know of a registered model: frozen data, no object and no function. */
  describe(name: string): ModelDescriptor {
    return isolated(() => {
      if (!this.models.has(name)) throw new ModelNotFoundError(name);
      return this.descriptor(name);
    });
  }

  /** The descriptors of every registered model, frozen. */
  describeAll(): ReadonlyArray<ModelDescriptor> {
    return isolated(() =>
      Object.freeze([...this.models.keys()].map((name) => this.descriptor(name))),
    );
  }

  private descriptor(name: string): ModelDescriptor {
    const declared = this.declared.get(name) as Declared;
    return Object.freeze(
      declared.output === undefined
        ? { name, version: declared.version }
        : { name, version: declared.version, output: declared.output },
    );
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
}

/**
 * A registry fixed at this moment: a model registered or replaced later is not seen by it, and
 * neither is a change to a model object: what was taken when it was registered is what runs. An
 * evaluation works on one, so that what its rules were validated against is what runs. Internal to
 * the engine (not exported by the package): the descriptors it holds are callable, and a plugin
 * has no path to them.
 */
export function snapshotModels(registry: ModelRegistry): ModelRegistry {
  const source = registry as unknown as {
    models: Map<string, CalculationModel<OutputValue>>;
    declared: Map<string, Declared>;
  };
  const fixed = new ModelRegistry();
  const target = fixed as unknown as typeof source;
  for (const [name, model] of source.models) {
    // justification: `register` sets both maps together.
    const declared = source.declared.get(name) as Declared;
    target.models.set(name, fixModel(name, model, declared));
    target.declared.set(name, declared);
  }
  return fixed;
}

/**
 * A frozen record of a model: its name, version and output declaration as they were registered
 * (the declaration is the validated copy), and its functions as they were registered, each called
 * through the port (a throw is a fault, a promise is a breach). The functions run on the model
 * object itself: its own `this` state is its plugin's (see the threat model in the README).
 */
function fixModel(
  name: string,
  model: CalculationModel<OutputValue>,
  declared: Declared,
): CalculationModel<OutputValue> {
  const call =
    (fn: Fn) =>
    (...args: unknown[]): unknown =>
      callSync(fn, model, args);
  const { listVariables, describeParams } = declared;
  return Object.freeze({
    name,
    version: declared.version,
    ...(declared.output === undefined ? {} : { output: declared.output }),
    validateParams: call(declared.validateParams) as CalculationModel['validateParams'],
    calculate: (
      input: Record<string, unknown>,
      rule: Readonly<Rule>,
      params: unknown,
    ): ReturnType<CalculationModel<OutputValue>['calculate']> =>
      callSync(declared.calculate, model, [input, rule, params]) as ReturnType<
        CalculationModel<OutputValue>['calculate']
      >,
    ...(listVariables === undefined
      ? {}
      : { listVariables: call(listVariables) as NonNullable<CalculationModel['listVariables']> }),
    ...(describeParams === undefined
      ? {}
      : {
          describeParams: call(describeParams) as NonNullable<CalculationModel['describeParams']>,
        }),
  });
}
