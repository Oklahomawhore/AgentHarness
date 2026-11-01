/** Controlled entrance draft for isolated permission-panel tests; parent integration is covered separately. */
import { useId, useState } from 'react'
import { NativeContributionPanel as PermissionPanel } from '../src/client/NativeContributionPanel.tsx'

type Props = Parameters<typeof PermissionPanel>[0]

/**
 * Supply the main entrance's controlled text to the isolated permission panel.
 * @param props - authoritative Session status and mocked Host callbacks.
 * @returns a test-owned draft input and the production permission panel.
 */
export function NativeContributionPanel(props: Props) {
  return <ControlledPanel key={props.agentId} {...props} />
}

function ControlledPanel(props: Props) {
  const id = useId()
  const [text, setText] = useState('')
  const occupied = props.entry?.value?.capture != null || props.entry?.value?.receivingContinuation !== undefined
  return <>
    {!occupied && <label htmlFor={id}>{props.t('native.invitation')}
      <textarea id={id} value={text} disabled={props.entry?.status !== 'ready' || props.entry.pending
        || props.entry.value?.eligibility !== 'eligible'} onChange={(event) => { setText(event.target.value) }} />
    </label>}
    <PermissionPanel {...props} entryText={text || undefined} />
  </>
}
