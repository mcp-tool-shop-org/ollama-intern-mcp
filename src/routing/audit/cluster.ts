/**
 * Input-shape signature — a canonical string key that groups receipts by
 * "same kind of job." First-class in 3D-C: the router's value is in
 * handling recurring shapes, not recurring tool names.
 *
 * Stable-sorted keys + per-value canonicalization so a receipt whose
 * shape is `{log_text: string/medium, source_paths: array/length 3}`
 * always hashes to the same signature regardless of insertion order or
 * minor size jitter within the same bucket.
 */

import type { InputShape, ValueShape } from "../../observability.js";

/** Bucket an integer array length so len=3 and len=4 cluster together. */
function arrayLengthBucket(len: number): string {
  if (len === 0) return "empty";
  if (len === 1) return "one";
  if (len <= 5) return "few";
  if (len <= 20) return "many";
  return "large";
}

function canonValue(v: ValueShape): string {
  switch (v.kind) {
    case "absent":
      return "absent";
    case "string":
      return `str:${v.bucket}`;
    case "array":
      return `arr:${arrayLengthBucket(v.length)}`;
    case "object":
      // Sort key names so {a,b} and {b,a} share a signature.
      return `obj:[${[...v.keys].sort().join(",")}]`;
    case "boolean":
      return `bool:${v.value}`;
    case "number":
      return "num";
    case "other":
    default:
      return "other";
  }
}

/**
 * Deterministic signature. A receipt's job shape becomes a stable string
 * key for clustering. Absent keys are included so two shapes that
 * explicitly have `source_paths: absent` versus one that doesn't mention
 * `source_paths` at all both signal the same "not using this field."
 */
export function shapeSignature(shape: InputShape): string {
  const keys = Object.keys(shape).sort();
  if (keys.length === 0) return "(empty)";
  return keys.map((k) => `${k}=${canonValue(shape[k])}`).join("|");
}
