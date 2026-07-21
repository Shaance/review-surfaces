# Frozen agreement-audit holdout v2

This manifest is separate from the six development-calibration cases. It was
frozen on 2026-07-20 after the first integrated journey was implemented and
before any live comparison was run.

The three cases test multi-session late boundaries, accessibility commitments,
tool chatter, a clean control, and exact-head validation. Input and hidden gold
bytes are content-addressed by `manifest.json`; editing a case requires a new
holdout version rather than replacing these files.

This directory is evaluation input, not a success claim. A release comparison
still requires matched three-run arms, hidden-gold adjudication, timing, and one
blinded reviewer preference judgment for every pair. Until those records exist,
product value remains unproven even when deterministic contract tests pass.
