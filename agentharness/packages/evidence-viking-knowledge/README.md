# `@agentharness/evidence-viking-knowledge`

English | [中文](README.zh.md)

Optional AgentHarness bundle that registers one read-only Viking Knowledge collection with DeepSeek Harness's generic `ctx.developmentEvidence` seam. It invokes `viking-cli` through the managed subprocess capability, resolves AK/SK references for every query, preserves authorization and failure states, validates the CLI JSON response, and returns bounded source-attributed citations. Retrieval changes neither rooms nor Sessions, and the current room phase does not compose this adapter.

Install the local checkout with `dsh plugin --profile web add ./agentharness/packages/evidence-viking-knowledge`. Set `AGENTHARNESS_VIKING_KNOWLEDGE_COLLECTION`, store `AGENTHARNESS_VIKING_ACCESS_KEY` and `AGENTHARNESS_VIKING_SECRET_KEY` through the Harness credential provider, then boot the `web` profile. The bundle stays disabled while the collection variable is absent.

## Configuration

Every field is explicit in `cordis.patch.yml`: provider identity and label, CLI executable, collection, project, region, cloud, working directory, credential references, collected-output limit, citation-summary limit, and process termination grace. A profile patch can replace the row and restate all fields.

The package's DSH peers are type-only at runtime and marked optional for pnpm. A profile installing this optional adapter must provide `credentials`, `developmentEvidence`, and `subprocess`. This avoids installing a second Cordis or service-definition graph below an external plugin.

## Model Experience

### Request context and condition

#### What the model sees

No `DevelopmentEvidenceItem` enters a model request directly. The provider only returns Host-side citations to a future explicit Consumer.

#### Token effect

Provider retrieval contributes zero prompt tokens.

#### KV Cache effect

Provider retrieval does not create or change a KV-cache entry.

## Known Limitations and Deferred Work

- Authentication currently uses deployment-managed AK/SK credentials, not participant-specific Viking identities; collection policy must restrict the service account to material the querying operator may receive.
- The source uses a stable `viking://` locator because the CLI result does not return an openable document URL. A later AgentHarness resolver can open that locator in the owning knowledge surface.
- The provider is read-only. Any write-back remains a separate reviewed capability.
- This package still uses the parent checkout's development toolchain; extraction and independent CI/release automation remain pending.
