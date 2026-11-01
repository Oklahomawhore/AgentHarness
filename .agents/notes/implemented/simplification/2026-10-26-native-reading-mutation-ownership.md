# Agent Note: Native reading mutations have one settlement owner

Status: implemented

English | [中文](2026-10-26-native-reading-mutation-ownership.zh.md)

## Problem

A reading operation can commit after its panel disconnects or unmounts. Releasing its lock on connection reset permits a duplicate operation, while publishing its old response can replace a newer observation. A token comparison adds no protection when only that operation can release the lock.

## Decision

The [native reading store](../../../../packages/client/ui-emergence-center/src/client/native-scopes.ts) uses one boolean to exclude overlapping mutations. It acquires the lock before notifying subscribers and retains it across connection reset and final unsubscribe. Only the sent operation's settlement releases it, before notifying any remaining subscribers. Reentrant subscribers therefore observe the same exclusion as ordinary callers.

Connection generations independently reject old mutation results. The active-subscription check suppresses detached presentation and recovery reads. Status reads retain token identity because reset can replace an unfinished read with a newer read.

## Alternatives considered

**Compare a mutation token at settlement.** No other operation can replace that token while the lock is held, and reset and unsubscribe preserve the lock. The identity comparison duplicates exclusion instead of comparing independent owners.

**Release the lock on reset or unsubscribe.** The Host may still commit the request. A second operation would overlap an unresolved write; reconnect must read current state after settlement without retrying that write.

## Consequences

The store retains one request at a time without mutation identities or an additional controller. Tests cover reset, detached settlement, remount, shared subscribers, and recovery without repeating a mutation. Permissions, status-read identity, connection checks, and Host authority remain independent requirements.
