import type { LlmModel, LlmProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/** Per-endpoint probe is bounded so a slow/hung server never stalls a tick. */
const PROBE_TIMEOUT = Duration.millis(1500);
/** mlx-serve's `bytes_resident` is unreliable (reports ~1 MB for a multi-GB model);
 *  only surface a size when it's plausibly a real resident footprint. */
const MIN_PLAUSIBLE_SIZE_BYTES = 1_000_000_000;

export type ProviderConfig = { readonly name: string; readonly baseUrl: string };

/** Lenient view of an OpenAI-compatible `/v1/models` response; unknown fields are
 *  ignored, mlx-serve's enrichment fields are picked up when present. */
const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      loaded: Schema.optional(Schema.Boolean),
      state: Schema.optional(Schema.String),
      bytes_resident: Schema.optional(Schema.NullOr(Schema.Number)),
      capabilities: Schema.optional(Schema.Array(Schema.String)),
      meta: Schema.optional(
        Schema.Struct({
          quantization: Schema.optional(Schema.String),
          context_length: Schema.optional(Schema.Number),
          is_moe: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});

const decodeModelsResponse = Schema.decodeUnknownSync(ModelsResponse);

/** Decode + map an OpenAI-compatible `/v1/models` body to our model list. Lenient:
 *  returns [] for any payload that isn't the expected shape (so a 2xx with an
 *  unexpected body degrades to "reachable, no models" rather than failing). */
export function parseModelsResponse(payload: unknown): LlmModel[] {
  try {
    return decodeModelsResponse(payload).data.map(mapModel);
  } catch {
    return [];
  }
}

function mapModel(raw: (typeof ModelsResponse.Type.data)[number]): LlmModel {
  const sizeBytes =
    raw.bytes_resident != null && raw.bytes_resident > MIN_PLAUSIBLE_SIZE_BYTES
      ? raw.bytes_resident
      : undefined;
  // mlx-serve reports `loaded`; a provider that doesn't carry the field is treated as
  // having served (therefore loaded) what it lists.
  const loaded = raw.loaded ?? true;
  return {
    id: raw.id,
    loaded,
    status: loaded ? "online" : "offline",
    ...(raw.state != null ? { state: raw.state } : {}),
    ...(sizeBytes != null ? { sizeBytes } : {}),
    ...(raw.meta?.quantization != null ? { quantization: raw.meta.quantization } : {}),
    ...(raw.meta?.context_length != null ? { contextLength: raw.meta.context_length } : {}),
    ...(raw.meta?.is_moe != null ? { isMoe: raw.meta.is_moe } : {}),
    ...(raw.capabilities != null ? { capabilities: raw.capabilities } : {}),
  };
}

function unreachable(provider: ProviderConfig, error: string): LlmProvider {
  return { name: provider.name, baseUrl: provider.baseUrl, reachable: false, error, models: [] };
}

/**
 * Probe one endpoint's `/v1/models`. Never fails: a timeout, non-2xx, transport
 * error, or unparseable body degrades to `reachable:false` (or reachable with no
 * models) so one bad endpoint can't fail the whole sample or kill a stream.
 */
export function probeProvider(
  provider: ProviderConfig,
): Effect.Effect<LlmProvider, never, HttpClient.HttpClient> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/models`;
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    const response = yield* client.execute(request).pipe(Effect.timeoutOption(PROBE_TIMEOUT));
    if (Option.isNone(response)) return unreachable(provider, "timeout");
    const httpResponse = response.value;
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return unreachable(provider, `HTTP ${httpResponse.status}`);
    }
    const json = yield* httpResponse.json.pipe(
      Effect.catchCause(() => Effect.succeed<unknown>(null)),
    );
    return {
      name: provider.name,
      baseUrl: provider.baseUrl,
      reachable: true,
      models: json == null ? [] : parseModelsResponse(json),
    };
  }).pipe(
    Effect.scoped,
    Effect.catchCause(() => Effect.succeed(unreachable(provider, "unreachable"))),
  );
}
