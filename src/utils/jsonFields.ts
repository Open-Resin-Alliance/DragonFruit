export type JsonObject = Record<string, unknown>;

export function asJsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

export async function readJsonObject(response: { json: () => Promise<unknown> }): Promise<JsonObject> {
  try {
    const payload = await response.json();
    return asJsonObject(payload);
  } catch {
    return {};
  }
}

export function readBooleanField(payload: JsonObject, key: string): boolean | null {
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
}

export function readStringField(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

export function readNumberField(payload: JsonObject, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
