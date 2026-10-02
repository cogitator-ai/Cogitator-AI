export type JSONValue = null | string | number | boolean | JSONObject | JSONValue[];

export interface JSONObject {
  [key: string]: JSONValue;
}

export function toJSONValue(value: unknown): JSONValue {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as JSONValue);
  } catch {
    return String(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
