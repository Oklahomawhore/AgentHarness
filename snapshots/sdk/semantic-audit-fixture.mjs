/** Independent audit oracle shared by the semantic SDK Session scenarios. */
import assert from 'node:assert/strict'

/** Check the actual summary text against the complete durable capture without using the production renderer.
 * @param {object} request - Persisted auxiliary request data.
 * @param {number} maxInputBytes - Scenario's fixed system and user text limit.
 * @returns {object} Complete captured evidence for projection checks.
 */
export function capturedSummaryInput(request, maxInputBytes) {
  assert.equal(request.version, 2)
  const captured = JSON.parse(request.capturedInput)
  const text = request.messages[0].content[0].text
  assert.ok(Buffer.byteLength(request.capturedInput) <= 1048576)
  assert.ok(Buffer.byteLength(request.system) + Buffer.byteLength(text) <= maxInputBytes)
  const counts = []
  const omittedSources = []
  for (const item of captured.coverage.omittedSources) {
    if (item.reason !== 'superseded' || item.source.kind !== 'publication') {
      omittedSources.push(item)
      continue
    }
    const { taskId, revision } = item.source
    const previous = counts.find(entry => entry.source.taskId === taskId && entry.source.revision === revision)
    if (previous) previous.count++
    else counts.push({ source: { kind: 'task', taskId, revision }, count: 1 })
  }
  assert.deepEqual(JSON.parse(text), { ...captured, coverage: {
    selectedSources: captured.coverage.selectedSources, omittedSources, supersededSources: counts,
  } }, 'actual summary input must retain all current evidence and only count superseded publications')
  return captured
}

/** Compare delivered references and both historical counts with complete projection metadata.
 * @param {object} delivery - Actual parsed message, including its source table.
 * @param {object} metadata - Full durable selected and omitted identities.
 * @returns {void} Throws when a reference or Task-revision count changes.
 */
export function assertDeliveryCoverage(delivery, metadata) {
  const source = index => {
    assert.ok(Number.isInteger(index) && index >= 0 && index < delivery.sourceTable.length)
    const row = delivery.sourceTable[index]
    if (row.kind === 'task') return { kind: row.kind, taskId: row.taskId, revision: row.revision }
    assert.equal(row.kind, 'publication')
    const task = source(row.taskSourceIndex)
    assert.equal(task.kind, 'task')
    return { ...task, kind: row.kind, publicationId: row.publicationId }
  }
  assert.deepEqual(delivery.coverage.selectedSources.map(source), metadata.selectedSources)
  assert.deepEqual(delivery.coverage.omittedSources.map(item => ({ source: source(item.sourceIndex), reason: item.reason })),
    metadata.omittedSources.filter(item => !['superseded', 'withdrawn'].includes(item.reason) || item.source.kind !== 'publication'))
  for (const reason of ['superseded', 'withdrawn']) {
    const groups = new Map()
    for (const item of metadata.omittedSources.filter(item => item.reason === reason && item.source.kind === 'publication')) {
      const taskSourceIndex = delivery.sourceTable.findIndex(row => row.kind === 'task'
        && row.taskId === item.source.taskId && row.revision === item.source.revision)
      assert.ok(taskSourceIndex >= 0)
      groups.set(taskSourceIndex, (groups.get(taskSourceIndex) ?? 0) + 1)
      assert.ok(!delivery.sourceTable.some((row, index) => row.kind === 'publication'
        && row.publicationId === item.source.publicationId && source(index).taskId === item.source.taskId
        && source(index).revision === item.source.revision))
    }
    assert.deepEqual(delivery.coverage[`${reason}Sources`],
      [...groups].sort(([a], [b]) => a - b).map(([taskSourceIndex, count]) => ({ taskSourceIndex, count })))
  }
}
