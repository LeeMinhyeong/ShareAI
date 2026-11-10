# Production streaming limitations

The chat route currently accepts text-only messages and does not support tool use, function calls, refusals, annotations, reasoning output, or multiple Responses output items/content parts. Unsupported or inconsistent output is rejected rather than reported as successful text. In particular, this is not yet a tool-capable Codex CLI endpoint; adding that requires end-to-end request and response mapping, not just accepting provider events.

Codex and SIWC Responses streams must contain a complete, consistent single assistant text lifecycle including the final output snapshot. For ordinary account attempts, parser failures after dispatch leave the durable attempt OPEN for recovery. For streaming clients, already-sent text cannot be recalled; errors after headers appear as a stream error rather than an HTTP 502 status. SIWC sharing-limit stream errors retain their specific 429/503 classifications.
