# Prewarm Policy

Dev profiles prewarm the Instant tier at server startup. This keeps
the first real Instant call at roughly 500ms (warm) instead of 7s
(cold). The prewarm cost is paid once, at boot, invisible to Claude.

## Profiles

- dev-rtx5080: prewarm ON for Instant tier
- dev-rtx5080-llama: prewarm ON for Instant tier
- m5-max: prewarms nothing — production wants a clean cold-start signal
