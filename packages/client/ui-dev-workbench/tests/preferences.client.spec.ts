// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { DevWorkbenchEntryId, DevWorkbenchViewId } from '@deepseek-ai/dsh-api-remotes/client'
import { createDevWorkbenchPreferences } from '../src/client/preferences.ts'

afterEach(() => { localStorage.clear() })

describe('createDevWorkbenchPreferences', () => {
  it('persists panel geometry and task-view selection', () => {
    const preferences = createDevWorkbenchPreferences()
    preferences.setPanelSize(960, 660)
    preferences.selectEntry('agent' as DevWorkbenchEntryId)
    preferences.selectView('agent' as DevWorkbenchEntryId, 'local-debug' as DevWorkbenchViewId)

    expect(createDevWorkbenchPreferences().getSnapshot()).toEqual({
      width: 960,
      height: 660,
      selectedEntryId: 'agent',
      selectedViewByEntry: { agent: 'local-debug' },
    })
  })

  it.each([
    { name: 'null', value: null },
    { name: 'an array', value: [] },
    { name: 'invalid geometry', value: { width: 'wide' } },
    { name: 'a non-string entry selection', value: { selectedEntryId: 42, selectedViewByEntry: {} } },
  ])('resets $name in localStorage before components read it', ({ value }) => {
    localStorage.setItem('dsh.dev-workbench.view.v1', JSON.stringify(value))
    expect(createDevWorkbenchPreferences().getSnapshot()).toEqual({ selectedViewByEntry: {} })
  })
})
