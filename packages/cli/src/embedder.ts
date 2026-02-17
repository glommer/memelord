import type { EmbedFn } from "memelord";

let cachedEmbedder: EmbedFn | null = null;

/**
 * Create a local embedding function using @huggingface/transformers.
 * Downloads the model on first use and caches it locally.
 *
 * Default: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~22M params)
 * With quantized=true (default), uses the q8 (8-bit) ONNX variant.
 */
export async function createEmbedder(opts?: {
  model?: string;
  quantized?: boolean;
}): Promise<EmbedFn> {
  if (cachedEmbedder) return cachedEmbedder;

  const { pipeline } = await import("@huggingface/transformers");

  const model = opts?.model ?? process.env.MEMELORD_MODEL ?? "Xenova/all-MiniLM-L6-v2";
  const quantized = opts?.quantized ?? true;

  const extractor = await pipeline("feature-extraction", model, {
    quantized,
  });

  cachedEmbedder = async (text: string): Promise<Float32Array> => {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data as Float64Array);
  };

  return cachedEmbedder;
}
