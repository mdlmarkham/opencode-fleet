# Deploying and reloading the fleet plugin (issue #191)

## Apply a new build with a restart, not a reload

`fleet_deploy` builds, packs, installs on the gateway and every worker node, restarts the node
services, and returns `gatewayRestartRequired: true` (plus `notes` on success). **Apply the new
build with an owner gateway restart, issued from outside an agent turn.** Do not use
`openclaw plugins reload opencode-fleet` for the active fleet plugin.

What was seen (the #187 deploy, 2026-10-05):

- `plugins reload opencode-fleet` failed with "admitted work did not settle within 60s".
- A retry said "gateway is draining for restart"; the gateway then sat `ready:false,
  failing:[gateway-draining]` for about 12 minutes with websocket admission closed.
- The documented recovery, `openclaw plugins reload --wait`, got HTTP 503. Only an owner `/restart`
  cleared it.

**Likely cause (a hypothesis, not proven):** the gateway's drain waits for *admitted work* (session
work-admission leases in the OpenClaw runtime) to settle. A reload issued from inside an agent turn
is itself admitted work that cannot finish while the turn is waiting on the reload, and long
blocking calls (`fleet_watch` up to its `timeoutMs`, `fleet_await` up to 600s) are admitted work too.
This plugin registers no long-lived services or widgets of its own (only tools and a node invoke
policy), so there is nothing here that should hold a drain open by itself; nodes run in a separate
process. If a reload hangs again with no agent turn in flight, that is evidence against this
hypothesis and worth a report with the gateway logs.

Practical rules:

1. Run `fleet_deploy`, then restart the gateway from outside the session that ran it (the restart
   kills that session anyway).
2. Avoid deploying while other sessions have long `fleet_watch` / `fleet_await` calls in flight.
3. If a gateway is stuck draining, an owner `/restart` is the known way out.

## Sessions keep the tool list they started with

After the restart, a session that began **before** it could not call `fleet_await` (added in
#181/#183): the tool was unknown to both `tool_call` and `tool_search`, while new sessions had it.
So a long-lived session can be told about a tool by a runtime result from the new gateway that its
own tool list does not contain.

What the plugin does about it:

- The runtime notes that point at `fleet_await` (the detached-launch ack, the live-probe note, the
  ack-timeout recovery text) now also say what to do without it: start a new session, and until
  then poll `fleet_run_status` no faster than every 15s.
- `fleet_deploy` returns `notes` saying so after a successful deploy.

What it cannot do: refresh a running session's tool catalog. That is an OpenClaw runtime behaviour;
surfacing a catalog refresh to running sessions after a plugin generation swap would need a host
change (worth asking for alongside #176).
