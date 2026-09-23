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

  it('resets malformed localStorage before components read it', () => {
    localStorage.setItem('dsh.dev-workbench.view.v1', JSON.stringify({ width: 'wide' }))
    expect(createDevWorkbenchPreferences().getSnapshot()).toEqual({ selectedViewByEntry: {} })
  })
})
