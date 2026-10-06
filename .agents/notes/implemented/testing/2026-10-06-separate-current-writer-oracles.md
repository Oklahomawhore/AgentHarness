# Agent Note: Separate current-writer oracles

Status: implemented

English | [中文](2026-10-06-separate-current-writer-oracles.zh.md)

## Problem

A recorded provider response can remain valid replay input while a changed backend writes different identity or evidence fields. Replacing the committed Session destroys that input; classifying a current-format log as a retained older format misrepresents migration coverage.

## Decision

The [snapshot manifest](../../../../packages/test-support/session-snapshot/README.md) permits owning SDK scenarios to select a separate current-writer oracle. The original canonical Session remains replay input. Actual native output is compared with the complete normalized writer expectation, and protocol notifications have their own current expectation. TypeScript and Python consume the same declaration. Historical format retention remains a distinct declaration with its existing corpus restrictions.

This applies to facts and semantic backend scenarios whose current production identities differ from recorded inputs. New output expectations come from actual keyless execution and retain identity differences for review. No provider identity is forged, no comparison field is erased, and no Session-format version is invented for a behavioral change.

## Alternatives considered

**Rewrite canonical Session input.** This loses committed evidence and conflates model replay with the current writer.

**Label current input as an older format or normalize backend identities.** The first corrupts migration accounting; the second hides the behavior under test.

## Consequences

The parser rejects borrowed Sessions, historical-format declarations, and non-SDK profiles combined with this writer selection. Record and refresh leave the canonical input unchanged. Review must inspect the independent writer and notification expectations as well as preserved input hashes.
