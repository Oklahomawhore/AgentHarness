# Connect collaboration across devices

English | [中文](collaboration-network.zh.md)

Use this guide when two people run independent AgentHarness Hosts and want to collaborate on one owner's Task. Each person keeps their own Host and browser session. The owner must be directly reachable by an IP address and TCP port; automatic internet discovery, NAT traversal, and relay service are not available.

## 1. Configure the owner's listener

1. Open the owner's local browser page and choose **Settings → Plugins → Collaboration network**. A remote browser cannot save this Host setting.
2. Select the option for other devices and enter an available TCP port from 1 to 65535. This enables listening on all IPv4 interfaces. Keep **Only the device running AgentHarness** when both participants run on this computer.
3. Save. The confirmation means the preference is stored; the current listener stays unchanged.
4. Stop and start the Host with the same Harness home. For the installed service, run `agentharness stop` followed by `agentharness start`. Return to the collaboration center and refresh its addresses.

The browser's own port and `--host` option configure a separate listener. Sharing the browser's management URL is not how an independent Agent joins a Task. The collaboration listener creates no read grant or file-sharing permission by itself.

## 2. Choose an address and invite

1. Select the owner's independent Task. Open its independent-device collaboration controls and the file-contribution permissions.
2. In **Local address for this invitation**, choose the address the other device can reach. Only current Host-published addresses are selectable. A loopback address works only on this computer; an interface address is a candidate, not confirmation of reachability. With several interfaces or a VPN, choose the route appropriate to the other device.
3. Generate an entry for one Session to join. Give the entry to the other person. They use a running ordinary native Session in a project workspace with no existing remote reading connection. An existing local Task remains assigned. They open **Collaboration**, expand file sharing, paste the entry, choose **Verify connection**, and wait for the owner to confirm that the entry is open. The file-permission form appears only after that check. They confirm Task reading and file collection separately, choose existing directories and write/edit operations, set limits, and submit the application. Configure a usable model before model-driven file work; sending a model request is not an admission protocol requirement.
4. The participant can also choose finite automatic work in the same application, with an explicit local goal, additional starts, per-turn steps, and minimum interval. The option starts off, including when the Session already has a local automatic policy. Confirm the existing local Task when joining; the joined Agent retains its history, tools and independently authorized local file sharing. Review the applicant and limits on the owner's page, set their responsibility, and approve reading and contribution. Background admission connects the original Session and any automatic permission it saved locally; the owner does not choose its execution goal or budget. Without that separate local permission, receiving stays passive.

Changing the original Agent or receiving service before automatic adoption cancels that pending permission. Restored automatic bindings stay paused. Stopping file sharing after adoption preserves reading and its automatic permission; pause automatic work or leave the connection in the reading panel.

Connection verification uses the owner device identity in the entry. It does not submit an application, read shared content, or enable collection. An unavailable owner needs a reachable address and running Host; a closed, claimed, or expired entry needs a new entry. A successful check does not reserve the entry, grant permission, or confirm context delivery. The owner checks the application again when it arrives.

To participate from the owner's own Agent, select this local Task in that native Session and separately permit its file sharing. Creating the Task alone does not connect the owner's Agent or share its files.

An Agent already assigned to its own local Task can separately share file work with another owner through a file-contribution entry. Select the remote sharing page, verify that entry, and approve its directories, tools and limits. Its existing local capture remains separate. Stop each destination in its own panel. This file-only permission does not enable remote reading or change the local goal. The joint flow above separately connects reading while retaining that local Task. Leaving the remote connection restores the original local automatic policy paused, with all consumed starts retained; local file sharing remains independent.

Responsibility guides context selection. It does not hide other shared material in that Task. Use a separate unshared Task for private work. Each permission and delivery state has its own status; approval alone does not prove that an Agent has used the context.

## 3. Recover a connection

If the other Host cannot connect, check the selected IP, TCP port, firewall, and route. A saved setting, a listed address, and a successful connection from the same computer do not prove that a second computer can reach it. No relay fallback is attempted.

If the owner changes address while retaining its Harness home, stored Task data, and device identity, refresh the owner controls and select a current address. Recover the original entry, then paste its recovery content into **Collaboration → Share this session’s file work → Update owner connection address** in the participant's original Session. Check the content and save the recovery address. The Host retains the original permissions, limits, pending samples, and any withdrawal already in progress. A joint entry also recovers its original reading when the displayed read state still matches.

For a separate read-only connection, expand **Update owner connection address** under its receiving details and enter the owner's new address. The original subscription and automatic-work allowance remain in place, including consumed starts. A later local pause, leave, or replacement can invalidate an older recovery action; refresh and review the current state. Ended or expired permissions stay ended. Saving an address does not confirm reachability or context delivery. Losing the owner's original identity or Task data cannot be repaired by changing an address.

If restart fails because the selected port is occupied, stop the Host and change only `scope-network.listenAddresses` in its `settings.yaml` to an available fixed IP/TCP listener, or `/ip4/127.0.0.1/tcp/0` for local-only use, then start again. Preserve the other settings. User settings override composition values, including `AGENTHARNESS_SCOPE_LISTEN`; changing that environment variable does not override a saved preference. Custom IPv6 and multi-address values remain visible in the card and are preserved until explicitly replaced with one of its supported modes.

[Scope transport](../../../packages/collaboration/scope-transport/README.md) defines listener validation and network limitations. [Use AgentHarness](index.md) covers local startup and the separate trusted-cluster option.
