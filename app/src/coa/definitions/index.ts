import type { CoaDefinition, FieldDef } from '../types.js';
import { endotoxin } from './endotoxin.js';
import { hplcPqIdentification, hplcPurity, hplcPurityQuantity, hplcQuantity, msIdentification } from './hplc.js';
import { phUsp791 } from './ph.js';
import { sterilityAtp, sterilityVisual } from './sterility.js';

export const DEFINITIONS: CoaDefinition[] = [
  hplcPurity,
  hplcQuantity,
  hplcPurityQuantity,
  hplcPqIdentification,
  msIdentification,
  endotoxin,
  phUsp791,
  sterilityAtp,
  sterilityVisual,
];

const bySlug = new Map(DEFINITIONS.map((d) => [d.slug, d]));

export function getDefinition(slug: string): CoaDefinition | undefined {
  return bySlug.get(slug);
}

export function allFields(def: CoaDefinition): FieldDef[] {
  return def.sections.flatMap((s) => s.fields);
}

export function fieldMap(def: CoaDefinition): Map<string, FieldDef> {
  return new Map(allFields(def).map((f) => [f.key, f]));
}

/** Sanity check used by tests: every layout field exists in the form and vice versa. */
export function layoutFieldKeys(def: CoaDefinition): Set<string> {
  const keys = new Set<string>();
  const walk = (ops: CoaDefinition['pages'][number]['ops']) => {
    for (const op of ops) {
      if (op.kind === 'value' || op.kind === 'cell' || op.kind === 'image') keys.add(op.field);
      if (op.kind === 'when') {
        op.uses?.forEach((k) => keys.add(k));
        walk(op.ops);
      }
    }
  };
  def.pages.forEach((p) => walk(p.ops));
  return keys;
}
