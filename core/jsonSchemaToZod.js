// jsonSchemaToZod.js — convert our JSON-Schema tool inputs into the Zod "shape"
// object the Agent SDK's tool() helper expects. `z` is injected (zod lives with the
// device deps, not in host-agnostic core). Covers the subset our tools use:
// string/number/integer/boolean/array/object, enums, unions (type arrays),
// required vs optional, defaults, descriptions, nested objects.

function zodForType(type, s, z) {
  switch (type) {
    case "string": return Array.isArray(s.enum) ? z.enum(s.enum) : z.string();
    case "integer": return z.number().int();
    case "number": return z.number();
    case "boolean": return z.boolean();
    case "array": {
      const item = s.items && Object.keys(s.items).length ? zodFor(s.items, z) : z.any();
      return z.array(item);
    }
    case "object":
      return s.properties ? z.object(toZodShape(s, z)) : z.record(z.any());
    default: return z.any();
  }
}

function zodFor(s, z) {
  if (!s || typeof s !== "object") return z.any();
  if (Array.isArray(s.enum)) return z.enum(s.enum);
  if (Array.isArray(s.type)) {
    const opts = s.type.map((t) => zodForType(t, s, z));
    return opts.length > 1 ? z.union(opts) : (opts[0] || z.any());
  }
  return zodForType(s.type, s, z);
}

// Returns { propName: ZodType, ... } for use as the 3rd arg to tool().
function toZodShape(inputSchema, z) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set((inputSchema && inputSchema.required) || []);
  const shape = {};
  for (const [key, s] of Object.entries(props)) {
    let t = zodFor(s, z);
    if (s && s.description) t = t.describe(s.description);
    if (!required.has(key)) t = s && "default" in s ? t.default(s.default) : t.optional();
    shape[key] = t;
  }
  return shape;
}

module.exports = { toZodShape, zodFor };
