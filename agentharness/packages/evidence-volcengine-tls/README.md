# `@agentharness/evidence-volcengine-tls`

English | [中文](README.zh.md)

Optional AgentHarness bundle that registers one read-only Volcengine TLS topic with DeepSeek Harness's generic `ctx.developmentEvidence` registry. It signs `POST /SearchLogs` through the Volcengine V4 protocol, resolves AK/SK references for every query, reads the response through a byte cap, validates the JSON fields, and returns bounded log citations. Retrieval changes neither rooms nor Sessions, and the current room phase does not compose this adapter.

Install the local checkout with `dsh plugin --profile web add ./agentharness/packages/evidence-volcengine-tls`. Set `AGENTHARNESS_TLS_TOPIC_ID`, store `AGENTHARNESS_TLS_ACCESS_KEY` and `AGENTHARNESS_TLS_SECRET_KEY` through the Harness credential provider, and then boot the `web` profile. `AGENTHARNESS_TLS_ENDPOINT` and `AGENTHARNESS_TLS_REGION` select another regional endpoint. The bundle stays disabled while the TopicId is absent.

## Configuration

Every field is explicit in `cordis.patch.yml`: provider identity and label, HTTPS endpoint origin, region, exact TopicId, credential references, lookback duration, result order, query-byte limit, response-byte limit, and citation-summary limit. The package contains no topic aliases or credentials. The endpoint must be an HTTPS origin without embedded credentials or additional URL components.

Each lookup treats the operator's text as a TLS search expression over the configured rolling time window. SQL analysis expressions containing `|` are rejected because their aggregate response has different citation semantics. A success must report `ResultStatus: complete`; HTTP authorization failures become `denied`, throttling and server errors remain retryable failures, and malformed, incomplete, or oversized responses never produce partial evidence.

Each result retains a `tls://search/<topic>/<time>/<record>?start=...&end=...&query=...` locator and a SHA-256 revision over the canonical log record. A profile installing this optional adapter must provide `credentials` and `developmentEvidence`.

## Model Experience

### Request context and condition

#### What the model sees

No TLS log enters a model request directly. The provider only returns Host-side citations to a future explicit Consumer.

#### Token effect

TLS retrieval contributes zero prompt tokens.

#### KV Cache effect

TLS retrieval does not create or change a KV-cache entry.

## Known Limitations and Deferred Work

- Authentication uses deployment-managed AK/SK credentials, not participant-specific Volcengine identities. The IAM account and TopicId must expose only logs that every authorized room operator may query.
- The query window is deployment-configured and ends at the Host clock. Callers cannot request an arbitrary historical interval or pagination through the current provider-neutral evidence request.
- Topic field names and historical index changes remain deployment knowledge. The provider sends the exact TLS expression and does not rewrite an old query to a broader full-text search.
- Log records can contain private user or tool content. Retrieval results are visible to the querying operator and require separate reviewed policy before any wider use.
- The `tls://` locator has no browser resolver yet. A later AgentHarness diagnostics surface can reopen the exact topic, time window, query, and record revision.
- This package still uses the parent checkout's development toolchain; extraction and independent CI/release automation remain pending.
