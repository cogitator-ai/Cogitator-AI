interface UnitsInput {
  value: number;
  from: string;
  to: string;
}

interface UnitsOutput {
  value: number;
  from: string;
  to: string;
  category: string;
  error?: string;
}

type UnitCategory = 'length' | 'mass' | 'temperature' | 'volume' | 'speed' | 'data';

interface UnitDefinition {
  category: UnitCategory;
  factor: number;
  offset?: number;
}

const UNITS: Record<string, UnitDefinition> = {
  mm: { category: 'length', factor: 0.001 },
  cm: { category: 'length', factor: 0.01 },
  m: { category: 'length', factor: 1 },
  km: { category: 'length', factor: 1000 },
  in: { category: 'length', factor: 0.0254 },
  ft: { category: 'length', factor: 0.3048 },
  yd: { category: 'length', factor: 0.9144 },
  mi: { category: 'length', factor: 1609.344 },

  mg: { category: 'mass', factor: 0.001 },
  g: { category: 'mass', factor: 1 },
  kg: { category: 'mass', factor: 1000 },
  t: { category: 'mass', factor: 1000000 },
  oz: { category: 'mass', factor: 28.349523125 },
  lb: { category: 'mass', factor: 453.59237 },

  C: { category: 'temperature', factor: 1, offset: 0 },
  F: { category: 'temperature', factor: 5 / 9, offset: -32 },
  K: { category: 'temperature', factor: 1, offset: -273.15 },

  ml: { category: 'volume', factor: 0.001 },
  l: { category: 'volume', factor: 1 },
  tsp: { category: 'volume', factor: 0.00492892159375 },
  tbsp: { category: 'volume', factor: 0.01478676478125 },
  cup: { category: 'volume', factor: 0.2365882365 },
  'US gallon': { category: 'volume', factor: 3.785411784 },
  'imperial gallon': { category: 'volume', factor: 4.54609 },

  'm/s': { category: 'speed', factor: 1 },
  'km/h': { category: 'speed', factor: 1 / 3.6 },
  mph: { category: 'speed', factor: 0.44704 },
  knot: { category: 'speed', factor: 1852 / 3600 },

  B: { category: 'data', factor: 1 },
  KB: { category: 'data', factor: 1e3 },
  MB: { category: 'data', factor: 1e6 },
  GB: { category: 'data', factor: 1e9 },
  TB: { category: 'data', factor: 1e12 },
  KiB: { category: 'data', factor: 1024 },
  MiB: { category: 'data', factor: 1048576 },
  GiB: { category: 'data', factor: 1073741824 },
  TiB: { category: 'data', factor: 1099511627776 },
};

const ALIASES: Record<string, string> = {
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  centimeter: 'cm',
  centimeters: 'cm',
  centimetre: 'cm',
  centimetres: 'cm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  kilometer: 'km',
  kilometers: 'km',
  kilometre: 'km',
  kilometres: 'km',
  inch: 'in',
  inches: 'in',
  foot: 'ft',
  feet: 'ft',
  yard: 'yd',
  yards: 'yd',
  mile: 'mi',
  miles: 'mi',

  milligram: 'mg',
  milligrams: 'mg',
  gram: 'g',
  grams: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  tonne: 't',
  tonnes: 't',
  'metric ton': 't',
  'metric tons': 't',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',

  c: 'C',
  celsius: 'C',
  '°c': 'C',
  '°C': 'C',
  degc: 'C',
  degC: 'C',
  f: 'F',
  fahrenheit: 'F',
  '°f': 'F',
  '°F': 'F',
  degf: 'F',
  degF: 'F',
  k: 'K',
  kelvin: 'K',

  mL: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  L: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  cups: 'cup',
  gal: 'US gallon',
  gallon: 'US gallon',
  gallons: 'US gallon',
  'us gal': 'US gallon',
  'US gal': 'US gallon',
  'us gallon': 'US gallon',
  'us gallons': 'US gallon',
  'US gallons': 'US gallon',
  us_gal: 'US gallon',
  us_gallon: 'US gallon',
  'imp gal': 'imperial gallon',
  'imp gallon': 'imperial gallon',
  'imperial gal': 'imperial gallon',
  'imperial gallons': 'imperial gallon',
  imp_gal: 'imperial gallon',
  imperial_gallon: 'imperial gallon',
  'uk gal': 'imperial gallon',
  'uk gallon': 'imperial gallon',
  'UK gallon': 'imperial gallon',

  mps: 'm/s',
  kph: 'km/h',
  kmh: 'km/h',
  kn: 'knot',
  kt: 'knot',
  knots: 'knot',

  byte: 'B',
  bytes: 'B',
  kilobyte: 'KB',
  kilobytes: 'KB',
  megabyte: 'MB',
  megabytes: 'MB',
  gigabyte: 'GB',
  gigabytes: 'GB',
  terabyte: 'TB',
  terabytes: 'TB',
  kibibyte: 'KiB',
  kibibytes: 'KiB',
  mebibyte: 'MiB',
  mebibytes: 'MiB',
  gibibyte: 'GiB',
  gibibytes: 'GiB',
  tebibyte: 'TiB',
  tebibytes: 'TiB',
};

function resolveUnit(raw: string): UnitDefinition | undefined {
  const trimmed = raw.trim();
  if (UNITS[trimmed]) return UNITS[trimmed];
  const alias = ALIASES[trimmed] ?? ALIASES[trimmed.toLowerCase()];
  if (alias && UNITS[alias]) return UNITS[alias];
  return undefined;
}

function supportedUnitsSummary(category?: UnitCategory): string {
  const byCategory: Record<string, string[]> = {};
  for (const [unit, def] of Object.entries(UNITS)) {
    if (category && def.category !== category) continue;
    (byCategory[def.category] ??= []).push(unit);
  }
  return Object.entries(byCategory)
    .map(([cat, units]) => `${cat}: ${units.join(', ')}`)
    .join('; ');
}

function roundResult(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  if (Number.isSafeInteger(n)) return n;
  const rounded = Number(n.toPrecision(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function convert(value: number, fromDef: UnitDefinition, toDef: UnitDefinition): number {
  if (fromDef === toDef) return roundResult(value);
  const fromOffset = fromDef.offset ?? 0;
  const toOffset = toDef.offset ?? 0;
  if (fromOffset !== 0 || toOffset !== 0) {
    const base = roundResult((value + fromOffset) * fromDef.factor);
    return roundResult(roundResult(base / toDef.factor) - toOffset);
  }
  return roundResult((value * fromDef.factor) / toDef.factor);
}

export function units(): number {
  let from = '';
  let to = '';
  try {
    const inputStr = Host.inputString();
    const input: UnitsInput = JSON.parse(inputStr);

    if (typeof input.from === 'string') from = input.from;
    if (typeof input.to === 'string') to = input.to;

    if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
      throw new Error('value must be a finite number');
    }
    if (typeof input.from !== 'string' || input.from.trim().length === 0) {
      throw new Error(`Unknown unit "${input.from}". Supported units: ${supportedUnitsSummary()}`);
    }
    if (typeof input.to !== 'string' || input.to.trim().length === 0) {
      throw new Error(`Unknown unit "${input.to}". Supported units: ${supportedUnitsSummary()}`);
    }

    const fromDef = resolveUnit(input.from);
    if (!fromDef) {
      throw new Error(`Unknown unit "${input.from}". Supported units: ${supportedUnitsSummary()}`);
    }
    const toDef = resolveUnit(input.to);
    if (!toDef) {
      throw new Error(`Unknown unit "${input.to}". Supported units: ${supportedUnitsSummary()}`);
    }

    if (fromDef.category !== toDef.category) {
      throw new Error(
        `Cannot convert between ${fromDef.category} ("${input.from}") and ${toDef.category} ("${input.to}"). ` +
          `Supported ${fromDef.category} units: ${supportedUnitsSummary(fromDef.category)}; ` +
          `supported ${toDef.category} units: ${supportedUnitsSummary(toDef.category)}`
      );
    }

    const result = convert(input.value, fromDef, toDef);

    const output: UnitsOutput = {
      value: result,
      from: input.from,
      to: input.to,
      category: fromDef.category,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: UnitsOutput = {
      value: NaN,
      from,
      to,
      category: '',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
